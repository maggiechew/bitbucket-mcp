import { buildPathOf, jenkinsBaseUrl, jenkinsConfigured, jenkinsJson } from "./jenkins-client.js";
import { BitbucketStatus, fetchBitbucketStatus } from "./bitbucket-status.js";
import { toLocalTime } from "./pull-request-format.js";
import { formatDuration, minutesSince } from "./duration-format.js";

export interface QueueItem {
  task: string;
  build: string | null;
  queued_since_ms: number;
  queued_since_local: string;
  waiting_minutes: number;
  reason: string;
  stuck: boolean;
}

export interface ExecutorOccupant {
  build: string | null;
  stage: string | null;
}

export interface JenkinsNode {
  name: string;
  online: boolean;
  offline_reason?: string;
  executors: { busy: number; total: number; current: ExecutorOccupant[] };
}

export interface JenkinsHealth {
  url: string;
  reachable: boolean;
  error?: string;
  quieting_down?: boolean;
  executors?: { busy: number; total: number };
  queue?: { depth: number; oldest_wait_minutes: number | null; items: QueueItem[] };
  nodes?: JenkinsNode[];
  labels_without_nodes?: string[];
}

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthFinding {
  condition: string;
  evidence: string;
  advice: string;
}

export interface HealthAssessment {
  status: HealthStatus;
  summary: string;
  findings: HealthFinding[];
}

export interface CiHealth {
  checked_at: string;
  checked_at_local: string;
  assessment: HealthAssessment;
  bitbucket: BitbucketStatus;
  jenkins?: JenkinsHealth;
}

interface RawRoot {
  quietingDown: boolean;
}

interface RawExecutable {
  url?: string;
  displayName?: string;
}

interface RawComputer {
  displayName: string;
  offline: boolean;
  offlineCauseReason: string;
  numExecutors: number;
  executors?: { idle: boolean; currentExecutable?: RawExecutable | null }[];
}

interface RawComputerSet {
  busyExecutors: number;
  totalExecutors: number;
  computer: RawComputer[];
}

interface RawQueueItem {
  inQueueSince: number;
  why?: string;
  stuck?: boolean;
  task?: { name?: string; url?: string };
}

interface RawQueue {
  items: RawQueueItem[];
}

const OFFLINE_LABEL = /All nodes of label ‘([^’]+)’ are offline/;
const LONG_WAIT_MINUTES = 30;
const QUEUE_TREE = "/queue/api/json?tree=items[inQueueSince,why,stuck,task[name,url]]";
const COMPUTER_TREE =
  "/computer/api/json?tree=busyExecutors,totalExecutors,computer[displayName,offline,offlineCauseReason,numExecutors,executors[idle,currentExecutable[url,displayName]]]";
const STAGE_SUFFIX = /\s\(([^()]*(?:\([^()]*\)[^()]*)*)\)$/;

/** Bitbucket's status page plus, when Jenkins is configured, whether it is up and taking builds, with a verdict. */
export async function ciHealth(): Promise<CiHealth> {
  const [bitbucket, jenkins] = await Promise.all([
    fetchBitbucketStatus(),
    jenkinsConfigured() ? jenkinsHealth() : undefined,
  ]);
  const checkedAt = new Date().toISOString();
  const checkedAtLocal = toLocalTime(checkedAt)!;
  return {
    checked_at: checkedAt,
    checked_at_local: checkedAtLocal,
    assessment: assess(bitbucket, jenkins, checkedAtLocal),
    bitbucket,
    jenkins,
  };
}

/** Why Jenkins would not run a build queued now, or null when it would. */
export function jenkinsNotAcceptingBuilds(health: JenkinsHealth): string | null {
  if (!health.reachable) return health.error ?? "Jenkins is unreachable.";
  if (health.quieting_down)
    return "Jenkins is quieting down for a restart and holds new builds in the queue until it comes back.";
  if (health.labels_without_nodes?.length) {
    return `No online node serves the label(s) ${health.labels_without_nodes.join(", ")}; queued builds are stuck until agents come back.`;
  }
  if (health.nodes && !health.nodes.some((node) => node.online && node.executors.total > 0))
    return "Jenkins has no online agents to run a build.";
  return null;
}

/** Every item in the Jenkins queue; each is a pipeline node block waiting for an executor, `build` naming the run it belongs to. */
export async function fetchQueueItems(): Promise<QueueItem[]> {
  const queue = await jenkinsJson<RawQueue>(QUEUE_TREE);
  return (queue?.items ?? []).map(compactQueueItem);
}

/** Every Jenkins node with what each of its executors is running. */
export async function fetchNodes(): Promise<JenkinsNode[]> {
  const computers = await jenkinsJson<RawComputerSet>(COMPUTER_TREE);
  return (computers?.computer ?? []).map(compactNode);
}

/** The queue items that belong to one build. */
export function queueItemsFor(items: QueueItem[], buildUrl: string): QueueItem[] {
  const path = buildPathOf(buildUrl);
  return items.filter((item) => item.build && buildPathOf(item.build) === path);
}

/** The agents a build holds right now, each with the stage or parallel branch running on it. */
export function agentsHeldBy(nodes: JenkinsNode[], buildUrl: string): { node: string; stage: string | null }[] {
  const path = buildPathOf(buildUrl);
  return nodes.flatMap((node) =>
    node.executors.current
      .filter((occupant) => occupant.build && buildPathOf(occupant.build) === path)
      .map((occupant) => ({ node: node.name, stage: occupant.stage })),
  );
}

export async function jenkinsHealth(): Promise<JenkinsHealth> {
  const url = jenkinsBaseUrl();
  try {
    const [root, computers, items] = await Promise.all([
      jenkinsJson<RawRoot>("/api/json?tree=quietingDown"),
      jenkinsJson<RawComputerSet>(COMPUTER_TREE),
      fetchQueueItems(),
    ]);
    items.sort((a, b) => b.waiting_minutes - a.waiting_minutes);
    return {
      url,
      reachable: true,
      quieting_down: root?.quietingDown ?? false,
      executors: { busy: computers?.busyExecutors ?? 0, total: computers?.totalExecutors ?? 0 },
      queue: { depth: items.length, oldest_wait_minutes: items[0]?.waiting_minutes ?? null, items },
      nodes: (computers?.computer ?? []).map(compactNode),
      labels_without_nodes: labelsWithoutNodes(items),
    };
  } catch (error) {
    return { url, reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function assess(bitbucket: BitbucketStatus, jenkins: JenkinsHealth | undefined, checkedAt: string): HealthAssessment {
  const findings = [...bitbucketFindings(bitbucket), ...(jenkins ? jenkinsFindings(jenkins) : [])];
  const status = findings.some((finding) => DOWN_CONDITIONS.has(finding.condition))
    ? "down"
    : findings.length
      ? "degraded"
      : "ok";
  return { status, summary: `As of ${checkedAt}, ${summarize(status, bitbucket, jenkins, findings)}`, findings };
}

const DOWN_CONDITIONS = new Set(["jenkins_unreachable", "no_nodes_for_label", "no_agents"]);

function bitbucketFindings(bitbucket: BitbucketStatus): HealthFinding[] {
  if (bitbucket.indicator === "none") return [];
  const incidents = bitbucket.open_incidents
    .map((incident) => `${incident.name} (${incident.impact}, ${incident.url})`)
    .join("; ");
  return [
    {
      condition: "bitbucket_incident",
      evidence: `${bitbucket.description}. ${incidents || bitbucket.degraded_components.map((c) => `${c.name}: ${c.status}`).join(", ")}`,
      advice:
        "Pushes, PR statuses and API calls may fail or lag until Atlassian resolves it. Nothing on our side to fix; wait it out.",
    },
  ];
}

function jenkinsFindings(jenkins: JenkinsHealth): HealthFinding[] {
  if (!jenkins.reachable) {
    return [
      {
        condition: "jenkins_unreachable",
        evidence: jenkins.error ?? "",
        advice: "Check the VPN first, then whether the Jenkins host is up. Nothing else can be read until it answers.",
      },
    ];
  }
  const findings: HealthFinding[] = [];
  const queue = jenkins.queue!;
  const nodes = jenkins.nodes ?? [];

  if (jenkins.labels_without_nodes?.length) {
    const stuck = queue.items.filter((item) => item.stuck);
    findings.push({
      condition: "no_nodes_for_label",
      evidence: `No online node serves label ${jenkins.labels_without_nodes.join(", ")}; ${stuck.length} build(s) stuck in the queue, oldest ${formatWait(queue.oldest_wait_minutes ?? 0)}`,
      advice:
        "Builds needing that label cannot start until agents come back. If the label is served by cloud workers, they are not being provisioned; that is an infrastructure problem, and retriggering will not help.",
    });
  }
  if (jenkins.quieting_down) {
    findings.push({
      condition: "quieting_down",
      evidence: `Jenkins is quieting down; ${queue.depth} item(s) queued`,
      advice:
        "A restart is pending. Builds queue until Jenkins is back; do not retrigger, and check again in a few minutes.",
    });
  }
  const offline = nodes.filter((node) => !node.online);
  if (offline.length) {
    findings.push({
      condition: "agents_offline",
      evidence: offline.map((node) => `${node.name}: ${node.offline_reason || "no reason given"}`).join("; "),
      advice: "Reduced capacity. If a reason names a cause (disk, connection, manual), that is the thing to fix.",
    });
  }
  const online = nodes.filter((node) => node.online && node.executors.total > 0);
  if (!jenkins.labels_without_nodes?.length && online.length === 0) {
    findings.push({
      condition: "no_agents",
      evidence: "No online node has an executor",
      advice: "Nothing can run. Agents need to come back before any build starts.",
    });
  }
  const saturated = jenkins.executors!.total > 0 && jenkins.executors!.busy >= jenkins.executors!.total;
  if (!jenkins.labels_without_nodes?.length && saturated && queue.depth > 0) {
    findings.push({
      condition: "capacity",
      evidence: `${jenkins.executors!.busy}/${jenkins.executors!.total} executors busy, ${queue.depth} queued, oldest ${formatWait(queue.oldest_wait_minutes ?? 0)}`,
      advice:
        "Capacity, not failure. Builds will start as executors free up; a long oldest wait means a backlog, not a broken build.",
    });
  }
  const unexplained = queue.items.filter((item) => item.waiting_minutes >= LONG_WAIT_MINUTES && !findings.length);
  if (unexplained.length) {
    findings.push({
      condition: "unrecognised",
      evidence: unexplained
        .map((item) => `${item.task}: ${item.reason} (${formatWait(item.waiting_minutes)})`)
        .join("; "),
      advice:
        "Builds have waited a long time for a reason this check does not recognise. Read the reasons above; they are Jenkins's own words.",
    });
  }
  const starved = buildsHoldingAgentsWhileWaiting(nodes, queue.items);
  if (starved.length) {
    const shown = starved.slice(0, STARVED_SHOWN);
    const more = starved.length > shown.length ? `; and ${starved.length - shown.length} more` : "";
    findings.push({
      condition: "agents_held_while_waiting",
      evidence: `${starved.length} build(s) hold agents while waiting ${formatWait(LONG_WAIT_MINUTES)} or longer for more: ${shown
        .map(
          (entry) =>
            `${entry.build} holds ${entry.agents_held} agent(s) (${entry.stages.join(", ")}), ${entry.stages_waiting} stage(s) waiting ${formatWait(entry.waiting_minutes)}`,
        )
        .join("; ")}${more}`,
      advice:
        "Each build keeps its agents until every branch has run, so the branches queued here wait on agents other such builds hold. Whether a held agent is working or idle is in that build's report (execution.stages); the builds nearest to finishing free agents soonest, so cancelling one of them lengthens the wait for everyone.",
    });
  }
  return findings;
}

const STARVED_SHOWN = 5;

interface StarvedBuild {
  build: string;
  agents_held: number;
  stages: string[];
  stages_waiting: number;
  waiting_minutes: number;
}

// The starvation pattern: a build keeps an agent for one branch while its other branches queue for
// agents that the other such builds are holding, so no one finishes.
function buildsHoldingAgentsWhileWaiting(nodes: JenkinsNode[], items: QueueItem[]): StarvedBuild[] {
  const held = new Map<string, { build: string; stages: string[] }>();
  for (const node of nodes) {
    for (const occupant of node.executors.current) {
      if (!occupant.build) continue;
      const path = buildPathOf(occupant.build);
      const entry = held.get(path) ?? { build: occupant.build, stages: [] };
      entry.stages.push(occupant.stage ?? "?");
      held.set(path, entry);
    }
  }
  return [...held.entries()]
    .map(([path, entry]) => {
      const waiting = items.filter((item) => item.build && buildPathOf(item.build) === path);
      return {
        build: entry.build,
        agents_held: entry.stages.length,
        stages: entry.stages,
        stages_waiting: waiting.length,
        waiting_minutes: Math.max(0, ...waiting.map((item) => item.waiting_minutes)),
      };
    })
    .filter((entry) => entry.stages_waiting > 0 && entry.waiting_minutes >= LONG_WAIT_MINUTES)
    .sort((a, b) => b.waiting_minutes - a.waiting_minutes);
}

function summarize(
  status: HealthStatus,
  bitbucket: BitbucketStatus,
  jenkins: JenkinsHealth | undefined,
  findings: HealthFinding[],
): string {
  if (status === "ok") {
    if (!jenkins) return `Bitbucket is ${bitbucket.description.toLowerCase()}.`;
    const executors = jenkins.executors!;
    const running = executors.busy === 1 ? "1 build running" : `${executors.busy} builds running`;
    const queued = jenkins.queue!.depth ? `${jenkins.queue!.depth} queued` : "nothing queued";
    return `situation normal: ${running}, ${queued}, all ${jenkins.nodes!.length} agents online, Bitbucket ${bitbucket.description.toLowerCase()}.`;
  }
  const headline = findings[0];
  const rest = findings.length > 1 ? ` Plus ${findings.length - 1} more finding(s).` : "";
  return `CI is ${status}: ${headline.evidence}.${rest}`;
}

function compactQueueItem(item: RawQueueItem): QueueItem {
  return {
    task: item.task?.name ?? "unknown",
    build: item.task?.url ? absoluteBuildUrl(item.task.url) : null,
    queued_since_ms: item.inQueueSince,
    queued_since_local: toLocalTime(new Date(item.inQueueSince).toISOString())!,
    waiting_minutes: minutesSince(item.inQueueSince),
    reason: item.why ?? "",
    stuck: item.stuck ?? false,
  };
}

function absoluteBuildUrl(url: string): string {
  return url.startsWith("http") ? url : `${jenkinsBaseUrl()}/${buildPathOf(url)}`;
}

function compactNode(computer: RawComputer): JenkinsNode {
  const executors = computer.executors ?? [];
  const busy = executors.filter((executor) => !executor.idle);
  return {
    name: computer.displayName,
    online: !computer.offline,
    offline_reason: computer.offline ? computer.offlineCauseReason : undefined,
    executors: {
      busy: busy.length,
      total: computer.numExecutors,
      current: busy.map((executor) => ({
        build: executor.currentExecutable?.url ?? null,
        stage: stageFromDisplayName(executor.currentExecutable?.displayName),
      })),
    },
  };
}

// An agent executor runs a node block whose display name is the build's plus the enclosing stage or
// parallel branch in parentheses: "my-app-master #3319 (Tests)", "… #2 (Feature b1f1 (base DBs))".
function stageFromDisplayName(displayName: string | undefined): string | null {
  return displayName?.match(STAGE_SUFFIX)?.[1] ?? null;
}

function labelsWithoutNodes(items: QueueItem[]): string[] {
  const labels = items
    .map((item) => OFFLINE_LABEL.exec(item.reason)?.[1])
    .filter((label): label is string => Boolean(label));
  return [...new Set(labels)];
}

function formatWait(minutes: number): string {
  return formatDuration(minutes * 60_000);
}
