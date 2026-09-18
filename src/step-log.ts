import { JenkinsStage, JenkinsStep, fetchStageSteps, fetchStepLog } from "./jenkins-build.js";
import { jenkinsBaseUrl } from "./jenkins-client.js";

export type ExcerptKind = "rspec_failures" | "jest_failures" | "ruby_exception" | "tail";

export interface FailedStepReport {
  stage: string;
  step: string;
  command?: string;
  log_url: string;
  log_lines: number;
  excerpt_kind: ExcerptKind;
  excerpt: string[];
  excerpt_truncated: boolean;
}

const FAILED_STEP_STATUSES = ["FAILED", "UNSTABLE"];
const EXCERPT_LINE_LIMIT = 120;
const TAIL_LINES = 40;
const TIMESTAMP_PREFIX = /^\[[^\]]+\] /;
const ANSI_ESCAPE = /\[[0-9;]*[A-Za-z]/g;

const RSPEC_FAILURES_START = /^Failures:$/;
const RSPEC_SUMMARY = /^\d+ examples?, \d+ failures?/;
const RSPEC_RERUN_LINE = /^rspec \.\/spec\//;
const JEST_FAILURE_START = /^● /;
const JEST_SUMMARY = /^Tests:\s+\d+ failed/;
const RUBY_EXCEPTION = /^[\w:]+(Error|Exception)\b|\(\w+Error\)$/;
const RUBY_BACKTRACE = /^\s*(from )?\S+\.rb:\d+:in /;

/**
 * The step a stage died in and the part of its log worth reading: an rspec or Jest failures block,
 * a Ruby exception with its backtrace, or the last lines when nothing recognisable is there.
 */
export async function failedStepReport(job: string, number: number, stage: JenkinsStage): Promise<FailedStepReport | null> {
  const steps = await fetchStageSteps(job, number, stage.id);
  const step = pickFailedStep(steps);
  if (!step) return null;

  const log = await fetchStepLog(job, number, step.id);
  const lines = cleanLines(log?.text ?? "");
  const excerpt = extractExcerpt(lines);

  return {
    stage: stage.name,
    step: step.name,
    command: step.command,
    log_url: `${jenkinsBaseUrl()}${job}/${number}/execution/node/${step.id}/log/`,
    log_lines: lines.length,
    excerpt_kind: excerpt.kind,
    excerpt: excerpt.lines,
    excerpt_truncated: excerpt.truncated || Boolean(log?.truncated),
  };
}

// The shell step that failed is the one whose output explains the stage; a failed step with no
// command (an error signal, a junit publish) is the fallback when no shell step failed.
function pickFailedStep(steps: JenkinsStep[]): JenkinsStep | undefined {
  const failed = steps.filter((step) => FAILED_STEP_STATUSES.includes(step.status));
  return failed.find((step) => step.command) ?? failed[0];
}

function cleanLines(text: string): string[] {
  return text
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.replace(TIMESTAMP_PREFIX, "").trimEnd());
}

interface Excerpt {
  kind: ExcerptKind;
  lines: string[];
  truncated: boolean;
}

export function extractExcerpt(lines: string[]): Excerpt {
  return rspecFailures(lines) ?? jestFailures(lines) ?? rubyException(lines) ?? tail(lines);
}

function rspecFailures(lines: string[]): Excerpt | null {
  const start = lines.findIndex((line) => RSPEC_FAILURES_START.test(line));
  if (start === -1) return null;

  const summary = indexFrom(lines, start, RSPEC_SUMMARY);
  const block = lines.slice(start, summary === -1 ? undefined : summary + 1);
  const reruns = lines.filter((line) => RSPEC_RERUN_LINE.test(line));
  return capped("rspec_failures", [...block, ...(reruns.length ? ["", ...reruns] : [])]);
}

function jestFailures(lines: string[]): Excerpt | null {
  const start = lines.findIndex((line) => JEST_FAILURE_START.test(line));
  if (start === -1) return null;

  const summary = indexFrom(lines, start, JEST_SUMMARY);
  return capped("jest_failures", lines.slice(start, summary === -1 ? undefined : summary + 1));
}

function rubyException(lines: string[]): Excerpt | null {
  const start = lines.findIndex((line) => RUBY_EXCEPTION.test(line));
  if (start === -1) return null;

  let end = start + 1;
  while (end < lines.length && RUBY_BACKTRACE.test(lines[end])) end += 1;
  return capped("ruby_exception", lines.slice(start, end));
}

function tail(lines: string[]): Excerpt {
  const kept = lines.filter((line) => line.length > 0).slice(-TAIL_LINES);
  return { kind: "tail", lines: kept, truncated: false };
}

function indexFrom(lines: string[], start: number, pattern: RegExp): number {
  const offset = lines.slice(start).findIndex((line) => pattern.test(line));
  return offset === -1 ? -1 : start + offset;
}

// A long failures block keeps its head, where the first failures are explained in full, and its
// summary at the end, with a marker for what was left out between them.
function capped(kind: ExcerptKind, lines: string[]): Excerpt {
  if (lines.length <= EXCERPT_LINE_LIMIT) return { kind, lines, truncated: false };

  const tailLength = 10;
  const head = lines.slice(0, EXCERPT_LINE_LIMIT - tailLength - 1);
  const omitted = lines.length - head.length - tailLength;
  return { kind, lines: [...head, `... ${omitted} lines omitted ...`, ...lines.slice(-tailLength)], truncated: true };
}
