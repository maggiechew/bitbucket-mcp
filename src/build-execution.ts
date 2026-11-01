import {
  JenkinsBuild,
  JenkinsStage,
  JenkinsStep,
  fetchConsoleSize,
  fetchRun,
  fetchStageSteps,
  fetchStepLogTail,
  stageUnfinished,
} from "./jenkins-build.js";
import { QueueItem, agentsHeldBy, fetchNodes, fetchQueueItems, queueItemsFor } from "./ci-health.js";
import { formatDuration } from "./duration-format.js";
import { toLocalTime } from "./pull-request-format.js";

export type ExecutionState = "queued" | "executing" | "waiting_for_agent" | "mixed";

export interface StageExecution {
  name: string;
  status: "done" | "executing" | "waiting_for_agent";
  started_local: string;
  ran_for?: string;
  running_for?: string;
  waiting_for?: string;
  step_command?: string;
  wait_reason?: string;
}

export interface ExecutionLog {
  size_bytes: number;
  growing: boolean | null;
  current_step_tail: string[];
  last_output_local: string | null;
  silent_for: string | null;
}

export interface BuildExecution {
  state: ExecutionState;
  started_local: string;
  waited_for_first_agent: string | null;
  queued_for: string | null;
  queue_reason: string | null;
  queue_position: { position: number; of: number } | null;
  on_executor_for: string | null;
  estimated_duration: string | null;
  stages: StageExecution[];
  agents_held: { node: string; stage: string | null }[];
  log: ExecutionLog;
  verdict: string;
}

export interface ExecutionOptions {
  previousLogSize?: number;
  checkLiveness?: boolean;
}

interface LiveStage {
  stage: JenkinsStage;
  steps: JenkinsStep[];
  current_step?: JenkinsStep;
  queue_item?: QueueItem;
  agent_assigned?: boolean;
}

const QUEUE_PAIRING_WINDOW_MS = 2_000;
const WRAPPER_MAX_OWN_MS = 1_000;
const WRAPPER_BOUNDARY_MS = 1_000;
const LIVENESS_POLL_MS = 60_000;
const STALL_SILENCE_MS = 10 * 60_000;
const FINISHED_SILENCE_MS = 2 * 60_000;
const TAIL_LINES = 20;
const TAIL_BYTES = 4_096;
const COMMAND_LIMIT = 160;
const TESTS_FINISHED = /All tests finished/i;
const TIMESTAMP_PREFIX = /^\[([^\]]+)\] /;
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * What a building pipeline is doing right now: queued for its first agent, executing, waiting for
 * agents on some branches, or both; per stage, with the current step's command and log tail, the
 * agents it holds, and a one-sentence verdict. Never derives "running for" from the build start.
 * @param build the build, which must still be building
 * @param options previousLogSize: the console size from an earlier call, so growth is judged against it;
 *   checkLiveness: sample the console size again after a minute when no earlier size is given
 */
export async function buildExecution(build: JenkinsBuild, options: ExecutionOptions = {}): Promise<BuildExecution> {
  const [run, queueItems, nodes, logSize] = await Promise.all([
    fetchRun(build.job, build.number),
    fetchQueueItems(),
    fetchNodes(),
    fetchConsoleSize(build.job, build.number),
  ]);
  const now = Date.now();
  const runStart = run.started_ms || new Date(build.started_at).getTime();
  const agentsHeld = agentsHeldBy(nodes, build.url);
  const ownItems = queueItemsFor(queueItems, build.url);
  const live = await liveStages(build, run.stages, ownItems, agentsHeld.length);
  const executing = live.filter((entry) => entry.current_step);
  const waiting = live.filter((entry) => !entry.current_step);
  const tails = await currentStepTails(build, executing);
  const growing = await logGrowing(build, logSize, options);

  const firstStageStart = run.stages.length ? Math.min(...run.stages.map((stage) => stage.started_ms)) : null;
  const state = executionState(run.stages, executing, waiting);
  const stages = [
    ...run.stages
      .filter((stage) => !stageUnfinished(stage) && !wrapsAnother(stage, run.stages))
      .map((stage) => [stage.started_ms, doneStage(stage)] as const),
    ...executing.map((entry) => [entry.stage.started_ms, executingStage(entry, now)] as const),
    ...waiting.map((entry) => [entry.stage.started_ms, waitingStage(entry, now)] as const),
  ]
    .sort((a, b) => a[0] - b[0])
    .map(([, stage]) => stage);
  const estimate = build.estimated_duration_ms;
  const onExecutorMs = firstStageStart === null ? null : now - firstStageStart;
  const lastOutput = tails[0]?.last_output_ms ?? null;
  const silentMs = lastOutput === null ? null : Math.max(0, now - lastOutput);
  const queued = state === "queued" ? ownItems.sort((a, b) => a.queued_since_ms - b.queued_since_ms)[0] : undefined;

  return {
    state,
    started_local: toLocalTime(new Date(runStart).toISOString())!,
    waited_for_first_agent: firstStageStart === null ? null : formatDuration(firstStageStart - runStart),
    queued_for: state === "queued" ? formatDuration(now - runStart) : null,
    queue_reason: queued?.reason ?? null,
    queue_position: queued ? queuePosition(queueItems, queued) : null,
    on_executor_for: onExecutorMs === null ? null : formatDuration(onExecutorMs),
    estimated_duration: estimate ? formatDuration(estimate) : null,
    stages,
    agents_held: agentsHeld,
    log: {
      size_bytes: logSize ?? 0,
      growing,
      current_step_tail: tails[0]?.lines ?? [],
      last_output_local: lastOutput === null ? null : localMs(lastOutput),
      silent_for: silentMs === null ? null : formatDuration(silentMs),
    },
    verdict: verdict({
      state,
      stages: run.stages,
      executing,
      waiting,
      agentsHeld,
      tails,
      growing,
      silentMs,
      onExecutorMs,
      estimate,
      now,
      runStart,
      queued,
    }),
  };
}

// Executing stages carry an unfinished step; waiting ones have no steps and, when Jenkins has got to
// it, a queue item that entered the queue within a breath of the stage starting. A step-less stage
// with no queue item that encloses a later unfinished stage is a wrapper and is left out. When the
// build holds more agents than it has executing stages, a step-less unpaired stage has just been
// given its agent and its first step has not started.
async function liveStages(
  build: JenkinsBuild,
  stages: JenkinsStage[],
  queued: QueueItem[],
  agentsHeld: number,
): Promise<LiveStage[]> {
  const unfinished = stages.filter(stageUnfinished).sort((a, b) => a.started_ms - b.started_ms);
  const described = await Promise.all(
    unfinished.map(async (stage) => ({ stage, steps: await fetchStageSteps(build.job, build.number, stage.id) })),
  );
  const unpaired = [...queued].sort((a, b) => a.queued_since_ms - b.queued_since_ms);
  const live: LiveStage[] = [];
  for (const entry of described) {
    const currentStep = [...entry.steps].reverse().find(stageUnfinished) ?? entry.steps[entry.steps.length - 1];
    if (entry.steps.length) {
      live.push({ ...entry, current_step: currentStep });
      continue;
    }
    const item = pairQueueItem(unpaired, entry.stage);
    if (item) unpaired.splice(unpaired.indexOf(item), 1);
    const wraps = unfinished.some((other) => other !== entry.stage && other.started_ms >= entry.stage.started_ms);
    if (item || !wraps) live.push({ ...entry, queue_item: item });
  }
  const executingCount = live.filter((entry) => entry.current_step).length;
  let spareAgents = Math.max(0, agentsHeld - executingCount);
  for (const entry of live) {
    if (entry.current_step || entry.queue_item || spareAgents === 0) continue;
    entry.agent_assigned = true;
    spareAgents -= 1;
  }
  return live;
}

function pairQueueItem(items: QueueItem[], stage: JenkinsStage): QueueItem | undefined {
  return items
    .filter((item) => Math.abs(item.queued_since_ms - stage.started_ms) <= QUEUE_PAIRING_WINDOW_MS)
    .sort((a, b) => Math.abs(a.queued_since_ms - stage.started_ms) - Math.abs(b.queued_since_ms - stage.started_ms))[0];
}

// A wrapper (the stage that holds the parallel branches, or a branch itself) has another stage start
// inside its span and either lasts under a second or ends exactly where a contained stage starts or
// ends, since Jenkins closes it on a child boundary. A sibling branch also contains the other
// branch's starts, but it ends on its own work, minutes away from any boundary, and is kept.
function wrapsAnother(stage: JenkinsStage, stages: JenkinsStage[]): boolean {
  const end = stage.started_ms + stage.duration_ms;
  const contained = stages.filter(
    (other) => other !== stage && other.started_ms > stage.started_ms && other.started_ms <= end,
  );
  if (!contained.length) return false;
  if (stage.duration_ms < WRAPPER_MAX_OWN_MS) return true;
  return contained.some(
    (child) =>
      Math.abs(child.started_ms - end) <= WRAPPER_BOUNDARY_MS ||
      Math.abs(child.started_ms + child.duration_ms - end) <= WRAPPER_BOUNDARY_MS,
  );
}

function executionState(stages: JenkinsStage[], executing: LiveStage[], waiting: LiveStage[]): ExecutionState {
  if (stages.length === 0) return "queued";
  if (executing.length && waiting.length) return "mixed";
  if (waiting.length) return "waiting_for_agent";
  return "executing";
}

// Position among the items waiting for the same thing (Jenkins's reason names the label), oldest first.
function queuePosition(all: QueueItem[], own: QueueItem): { position: number; of: number } {
  const competing = own.reason ? all.filter((item) => item.reason === own.reason) : all;
  const ordered = [...competing].sort((a, b) => a.queued_since_ms - b.queued_since_ms);
  return { position: ordered.indexOf(own) + 1, of: ordered.length };
}

function doneStage(stage: JenkinsStage): StageExecution {
  return {
    name: stage.name,
    status: "done",
    started_local: localMs(stage.started_ms),
    ran_for: formatDuration(stage.duration_ms),
  };
}

function executingStage(entry: LiveStage, now: number): StageExecution {
  const step = entry.current_step!;
  return {
    name: entry.stage.name,
    status: "executing",
    started_local: localMs(entry.stage.started_ms),
    running_for: formatDuration(now - (step.started_ms || entry.stage.started_ms)),
    step_command: commandOf(step),
  };
}

function waitingStage(entry: LiveStage, now: number): StageExecution {
  const since = entry.queue_item?.queued_since_ms ?? entry.stage.started_ms;
  return {
    name: entry.stage.name,
    status: "waiting_for_agent",
    started_local: localMs(entry.stage.started_ms),
    waiting_for: formatDuration(now - since),
    wait_reason: entry.queue_item?.reason ?? unpairedReason(entry),
  };
}

function unpairedReason(entry: LiveStage): string {
  return entry.agent_assigned
    ? "no queue item: the build holds an agent with no executing stage, so this stage has just been given its agent and its first step has not started"
    : "no queue item matched: the stage has started but has no steps yet; measured from the stage start, not from a queue entry";
}

function commandOf(step: JenkinsStep): string {
  const text = (step.command ?? step.name).trim().replace(/\s+/g, " ");
  return text.length > COMMAND_LIMIT ? `${text.slice(0, COMMAND_LIMIT)}…` : text;
}

function localMs(ms: number): string {
  return toLocalTime(new Date(ms).toISOString())!;
}

interface StepTail {
  stage: string;
  lines: string[];
  last_output_ms: number | null;
}

// Newest step first, so the tail shown is the step that started most recently.
async function currentStepTails(build: JenkinsBuild, executing: LiveStage[]): Promise<StepTail[]> {
  const newestFirst = [...executing].sort((a, b) => b.current_step!.started_ms - a.current_step!.started_ms);
  return Promise.all(
    newestFirst.map(async (entry) => {
      const log = await fetchStepLogTail(build.job, build.number, entry.current_step!.id, TAIL_BYTES);
      const text = log?.text ?? "";
      return { stage: entry.stage.name, lines: tailLines(text), last_output_ms: lastTimestamp(text) };
    }),
  );
}

/** The last lines of a log, blank lines dropped, timestamps and ANSI colour codes stripped. */
export function tailLines(text: string, count = TAIL_LINES): string[] {
  return text
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.replace(TIMESTAMP_PREFIX, "").trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count);
}

/** When the log last wrote a line, from the timestamp prefix the pipeline puts on each one, or null when there is none. */
export function lastTimestamp(text: string): number | null {
  const stamps = text
    .split("\n")
    .map((line) => Date.parse(line.match(TIMESTAMP_PREFIX)?.[1] ?? ""))
    .filter((ms) => Number.isFinite(ms));
  return stamps.length ? stamps[stamps.length - 1] : null;
}

// Two size reads seconds apart prove nothing, since a test can be quiet that long. Growth is judged
// against a size the caller read earlier, or against a second sample a minute later when asked for.
async function logGrowing(
  build: JenkinsBuild,
  size: number | null,
  options: ExecutionOptions,
): Promise<boolean | null> {
  if (size === null) return null;
  if (options.previousLogSize !== undefined) return size !== options.previousLogSize;
  if (!options.checkLiveness) return null;
  await new Promise((resolve) => setTimeout(resolve, LIVENESS_POLL_MS));
  const later = await fetchConsoleSize(build.job, build.number);
  return later === null ? null : later > size;
}

interface VerdictInput {
  state: ExecutionState;
  stages: JenkinsStage[];
  executing: LiveStage[];
  waiting: LiveStage[];
  agentsHeld: { node: string }[];
  tails: StepTail[];
  growing: boolean | null;
  silentMs: number | null;
  onExecutorMs: number | null;
  estimate: number | null;
  now: number;
  runStart: number;
  queued?: QueueItem;
}

function verdict(input: VerdictInput): string {
  const { state, executing, waiting, agentsHeld, onExecutorMs, estimate, now, runStart } = input;
  if (state === "queued") {
    const reason = input.queued ? ` (${plainReason(input.queued.reason)})` : "";
    return `Queued for ${formatDuration(now - runStart)}${reason}: no stage has started, so no agent has been assigned yet.`;
  }
  const waitClause = waiting.length ? waitingClause(waiting, now) : null;
  const agents = `${agentsHeld.length} agent${agentsHeld.length === 1 ? "" : "s"}`;

  if (state === "waiting_for_agent") {
    return `${capitalize(waitClause!)}; nothing is executing${agentsHeld.length ? `, though ${agents} ${agentsHeld.length === 1 ? "is" : "are"} still held` : ""}.`;
  }
  if (executing.length === 0) return betweenStepsVerdict(input);

  const stepClauses = executing.map((entry) => {
    const step = entry.current_step!;
    const running = formatDuration(now - (step.started_ms || entry.stage.started_ms));
    return `\`${commandOf(step)}\` in ${entry.stage.name} running ${running}`;
  });
  const executingClause = `executing on ${agents} for ${formatDuration(onExecutorMs ?? 0)}${waitedClause(input)}; current step ${stepClauses.join(", ")}, ${logClause(input)}`;
  const rest = waitClause ? `; ${waitClause}` : "";

  const hung = hungReason(input);
  if (hung) {
    const over = estimate && onExecutorMs !== null && onExecutorMs > estimate ? onExecutorMs - estimate : null;
    const pastEstimate =
      over !== null ? `on an executor ${formatDuration(over)} past the ${formatDuration(estimate!)} estimate, ` : "";
    return `Possibly hung: ${pastEstimate}${hung}; ${executingClause}${rest}.`;
  }
  return `${capitalize(executingClause)}${rest}.`;
}

// The step log's own timestamps are the finer measure, so a console that has not grown counts only
// when the step has also been quiet for a couple of minutes (or has no timestamps to say); a size
// read seconds apart cannot be told from one read minutes apart. "All tests finished" counts when the
// step has gone quiet since, and the shape of a build one step from green that cannot finish is that
// plus another branch still waiting for an agent. The estimate only strengthens the sentence.
function hungReason(input: VerdictInput): string | null {
  const { growing, silentMs, tails, waiting } = input;
  const finished = tails.length > 0 && tails.every((tail) => tail.lines.some((line) => TESTS_FINISHED.test(line)));
  const quiet = silentMs === null || silentMs >= FINISHED_SILENCE_MS;
  const silence = silentMs === null ? "" : ` and the step has been silent for ${formatDuration(silentMs)}`;
  if (growing === false && quiet) return `the console has not grown since the earlier read${silence}`;
  if (silentMs !== null && silentMs >= STALL_SILENCE_MS)
    return `the current step's log has been silent for ${formatDuration(silentMs)}`;
  if (finished && quiet && waiting.length)
    return `every executing branch's log reports all tests finished${silence} while another branch still waits for an agent`;
  if (finished && silentMs !== null && silentMs >= FINISHED_SILENCE_MS)
    return `every executing branch's log reports all tests finished and has been silent for ${formatDuration(silentMs)}`;
  return null;
}

function logClause(input: VerdictInput): string {
  const { growing, silentMs } = input;
  const silence = silentMs === null ? "" : `, last output ${formatDuration(silentMs)} ago`;
  if (growing === true) return `log growing${silence}`;
  if (growing === false && silentMs !== null && silentMs < FINISHED_SILENCE_MS)
    return `console unchanged since the earlier read but the step wrote ${formatDuration(silentMs)} ago, too soon to call`;
  if (growing === false) return `log not growing${silence}`;
  return `liveness not sampled (call again with previous_log_size or check_liveness)${silence}`;
}

function betweenStepsVerdict(input: VerdictInput): string {
  const { stages, agentsHeld, onExecutorMs, now } = input;
  const finished = stages.filter((stage) => !stageUnfinished(stage));
  const last = finished.sort((a, b) => b.started_ms + b.duration_ms - (a.started_ms + a.duration_ms))[0];
  const since = last
    ? `; last finished stage ${last.name} ended ${formatDuration(now - (last.started_ms + last.duration_ms))} ago`
    : "";
  const agents = agentsHeld.length ? `, holding ${agentsHeld.length} agent${agentsHeld.length === 1 ? "" : "s"}` : "";
  return `Between stages: no stage has a running step${agents}, on an executor for ${formatDuration(onExecutorMs ?? 0)}${waitedClause(input)}${since}.`;
}

function waitedClause(input: VerdictInput): string {
  const firstStageMs = input.onExecutorMs === null ? null : input.now - input.onExecutorMs;
  return firstStageMs === null ? "" : ` after waiting ${formatDuration(firstStageMs - input.runStart)}`;
}

function waitingClause(waiting: LiveStage[], now: number): string {
  const longest = Math.max(
    ...waiting.map((entry) => now - (entry.queue_item?.queued_since_ms ?? entry.stage.started_ms)),
  );
  const reasons = [...new Set(waiting.map((entry) => entry.queue_item?.reason).filter(Boolean))];
  const why = reasons.length ? ` (${reasons.map(plainReason).join("; ")})` : "";
  return `waiting for an agent on ${waiting.length} stage${waiting.length === 1 ? "" : "s"} for ${formatDuration(longest)}${why}`;
}

function plainReason(reason: string | undefined): string {
  if (!reason) return "";
  if (/Waiting for next available executor/i.test(reason)) return "executors saturated";
  const offline = reason.match(/All nodes of label ‘([^’]+)’ are offline/);
  if (offline) return `label ${offline[1]} has no online nodes`;
  return reason;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
