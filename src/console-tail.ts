import {
  JenkinsBuild,
  JenkinsStage,
  JenkinsStep,
  fetchConsoleTail,
  fetchRun,
  fetchStageSteps,
  fetchStepLogTail,
  stageUnfinished,
} from "./jenkins-build.js";
import { lastTimestamp, tailLines } from "./build-execution.js";
import { toLocalTime } from "./pull-request-format.js";

export interface ConsoleTail {
  build_url: string;
  size_bytes: number;
  last_output_local: string | null;
  lines: string[];
  stage?: string;
  step?: string;
  step_command?: string;
}

export const DEFAULT_TAIL_KB = 16;
export const MAX_TAIL_KB = 256;
const LINE_CAP = 2_000;

/**
 * The last `kb` of a build's console, or with a stage name the current (or last) step log of that stage,
 * for "what is this build doing right now" and "where did it stop".
 * @param build the build to read
 * @param kb kilobytes to read from the end
 * @param stage a stage or parallel-branch name as the report lists it, matched whole first then as a fragment
 * @return the tail lines, blank lines dropped, timestamps stripped
 */
export async function consoleTail(build: JenkinsBuild, kb: number, stage: string | undefined): Promise<ConsoleTail> {
  const bytes = Math.min(Math.max(kb, 1), MAX_TAIL_KB) * 1024;
  if (!stage) {
    const log = await fetchConsoleTail(build.job, build.number, bytes);
    if (!log) throw new Error(`Build ${build.url} has no console log.`);
    return {
      build_url: build.url,
      size_bytes: log.size_bytes,
      last_output_local: lastOutputLocal(log.text),
      lines: tailLines(log.text, LINE_CAP),
    };
  }

  const run = await fetchRun(build.job, build.number);
  const target = findStage(run.stages, stage);
  if (!target) {
    throw new Error(
      `Build ${build.url} has no stage named "${stage}". Stages: ${run.stages.map((s) => s.name).join(", ")}`,
    );
  }
  const steps = await fetchStageSteps(build.job, build.number, target.id);
  const step = currentStep(steps);
  if (!step) throw new Error(`Stage "${target.name}" of ${build.url} has no steps yet, so there is no log to read.`);

  const log = await fetchStepLogTail(build.job, build.number, step.id, bytes);
  return {
    build_url: build.url,
    size_bytes: log?.size_bytes ?? 0,
    last_output_local: lastOutputLocal(log?.text ?? ""),
    lines: tailLines(log?.text ?? "", LINE_CAP),
    stage: target.name,
    step: step.name,
    step_command: step.command,
  };
}

function lastOutputLocal(text: string): string | null {
  const ms = lastTimestamp(text);
  return ms === null ? null : toLocalTime(new Date(ms).toISOString())!;
}

// The latest stage with that exact name wins (a pipeline repeats names like "Setup" across branches
// and the latest is the one still going); a fragment match is the fallback.
function findStage(stages: JenkinsStage[], name: string): JenkinsStage | undefined {
  const wanted = name.trim().toLowerCase();
  const byTime = [...stages].sort((a, b) => b.started_ms - a.started_ms);
  return (
    byTime.find((stage) => stage.name.toLowerCase() === wanted) ??
    byTime.find((stage) => stage.name.toLowerCase().includes(wanted))
  );
}

// The step still running is the one to read; on a finished stage the last step with a log (a step
// that failed or was aborted first, else the last shell step, else the last step of all).
function currentStep(steps: JenkinsStep[]): JenkinsStep | undefined {
  const reversed = [...steps].reverse();
  return (
    reversed.find(stageUnfinished) ??
    reversed.find((step) => ["FAILED", "ABORTED", "UNSTABLE"].includes(step.status)) ??
    reversed.find((step) => step.command) ??
    reversed[0]
  );
}
