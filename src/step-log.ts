import {
  FailedTest,
  JenkinsStage,
  JenkinsStep,
  fetchArtifact,
  fetchArtifacts,
  fetchStageSteps,
  fetchStepLog,
} from "./jenkins-build.js";
import { jenkinsBaseUrl } from "./jenkins-client.js";

export type ExcerptKind = "rspec_failures" | "jest_failures" | "ruby_exception" | "tail";

export interface FailedStepReport {
  stage: string;
  step: string;
  command?: string;
  log_url: string;
  log_lines: number;
  excerpt_source: string;
  artifact_missing?: string;
  excerpt_kind: ExcerptKind;
  excerpt: string[];
  excerpt_truncated: boolean;
  excerpt_low_value?: true;
}

export interface FailedStepDiagnosis {
  report: FailedStepReport;
  failed_tests: FailedTest[];
}

interface StepOutput {
  text: string;
  source: string;
  truncated: boolean;
  artifact_missing?: string;
}

const FAILED_STEP_STATUSES = ["FAILED", "UNSTABLE"];
const EXCERPT_LINE_LIMIT = 120;
const TAIL_LINES = 40;
const STEP_LOG_SOURCE = "step_log";
const LOAD_ERROR_EXAMPLE = "(error while loading the file)";
const OUT_FILE_OPTION = /--out[= ]+(\S+)/g;
const TIMESTAMP_PREFIX = /^\[[^\]]+\] /;
const ANSI_ESCAPE = /\[[0-9;]*[A-Za-z]/g;

const RSPEC_FAILURES_START = /^(Failures:|An error occurred while loading .+)$/;
const RSPEC_SUMMARY = /^\d+ examples?, \d+ failures?/;
const RSPEC_RERUN_LINE = /^rspec \.\/spec\//;
const RSPEC_RERUN_EXAMPLE = /^rspec (\.\/[^\s:[]+)\S* # (.+)$/;
const RSPEC_LOAD_ERROR = /^An error occurred while loading (\S+?)\.?$/;
const RSPEC_NUMBERED_FAILURE = /^\s*\d+\) (.+)$/;
const RSPEC_FAILURE_ERROR = /^\s*Failure\/Error:/;
const RSPEC_BLOCK_BOUNDARY = /^(\s*\d+\) |An error occurred while loading |Finished in |\d+ examples?, )/;
const JEST_FAILURE_START = /^● /;
const JEST_SUMMARY = /^Tests:\s+\d+ failed/;
const RUBY_EXCEPTION = /^[\w:]+(Error|Exception)\b|\(\w+Error\)$/;
const RUBY_BACKTRACE = /^\s*(from )?\S+\.rb:\d+:in /;

/**
 * The step a stage died in and the part of its output worth reading: an rspec or Jest failures block,
 * a Ruby exception with its backtrace, or the last lines when nothing recognisable is there. The
 * output is the archived file an rspec `--out` names when the build archived it, else the step's log.
 * @return the report and the failing examples the output names, or null when no step in the stage failed
 */
export async function failedStepReport(
  job: string,
  number: number,
  stage: JenkinsStage,
): Promise<FailedStepDiagnosis | null> {
  const steps = await fetchStageSteps(job, number, stage.id);
  const step = pickFailedStep(steps);
  if (!step) return null;

  const output = await stepOutput(job, number, step);
  const lines = cleanLines(output.text);
  const excerpt = extractExcerpt(lines);

  return {
    report: {
      stage: stage.name,
      step: step.name,
      command: step.command,
      log_url: `${jenkinsBaseUrl()}${job}/${number}/execution/node/${step.id}/log/`,
      log_lines: lines.length,
      excerpt_source: output.source,
      artifact_missing: output.artifact_missing,
      excerpt_kind: excerpt.kind,
      excerpt: excerpt.lines,
      excerpt_truncated: excerpt.truncated || output.truncated,
    },
    failed_tests: rspecFailedTests(lines),
  };
}

// rspec's --out sends a formatter's output to a file the step log never sees; when the pipeline
// archived that file, it is the output that explains the step.
async function stepOutput(job: string, number: number, step: JenkinsStep): Promise<StepOutput> {
  const outFile = rspecOutFile(step.command);
  const archived = outFile ? await archivedOutput(job, number, outFile) : null;
  if (archived) return archived;

  const log = await fetchStepLog(job, number, step.id);
  return {
    text: log?.text ?? "",
    source: STEP_LOG_SOURCE,
    truncated: Boolean(log?.truncated),
    artifact_missing: outFile,
  };
}

// The text formatter's file over the junit one, which only Jenkins reads.
function rspecOutFile(command: string | undefined): string | undefined {
  const files = [...(command ?? "").matchAll(OUT_FILE_OPTION)].map((match) => match[1]);
  return files.find((file) => !file.endsWith(".xml")) ?? files[0];
}

async function archivedOutput(job: string, number: number, file: string): Promise<StepOutput | null> {
  try {
    const artifacts = await fetchArtifacts(job, number);
    const artifact = artifacts.find((candidate) => candidate.relativePath === file || candidate.fileName === file);
    if (!artifact) return null;

    const text = await fetchArtifact(job, number, artifact.relativePath);
    return text === null ? null : { text, source: `artifact:${artifact.relativePath}`, truncated: false };
  } catch {
    return null;
  }
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

/**
 * The failing examples an rspec text report names, in the shape the junit report gives them: files
 * that raised while loading, then the examples from the rerun lines, each with the error its failure
 * block states. Empty when the text is not an rspec report.
 */
export function rspecFailedTests(lines: string[]): FailedTest[] {
  const errors = new Map(
    failureBlocks(lines, RSPEC_NUMBERED_FAILURE).map((block) => [block.title, errorIn(block.body)]),
  );
  const loadErrors = failureBlocks(lines, RSPEC_LOAD_ERROR).map((block) => ({
    file: specPath(block.title),
    example: LOAD_ERROR_EXAMPLE,
    error: errorIn(block.body),
  }));
  const examples = lines
    .map((line) => line.match(RSPEC_RERUN_EXAMPLE))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ file: specPath(match[1]), example: match[2], error: errors.get(match[2]) }));
  return [...loadErrors, ...examples];
}

function failureBlocks(lines: string[], start: RegExp): { title: string; body: string[] }[] {
  return lines.flatMap((line, index) => {
    const title = line.match(start)?.[1];
    if (!title) return [];

    const length = lines.slice(index + 1).findIndex((candidate) => RSPEC_BLOCK_BOUNDARY.test(candidate));
    return [{ title, body: lines.slice(index + 1, length === -1 ? undefined : index + 1 + length) }];
  });
}

// The first line after Failure/Error is the message, or the exception class when it ends with a
// colon, in which case the message follows it.
function errorIn(body: string[]): string | undefined {
  const at = body.findIndex((line) => RSPEC_FAILURE_ERROR.test(line));
  if (at === -1) return undefined;

  const [first, second] = body
    .slice(at + 1)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!first) return undefined;
  return first.endsWith(":") && second ? `${first} ${second}` : first;
}

// rspec names files as ./spec/...; the junit report, and so the rest of the report, as spec/...
function specPath(file: string): string {
  return file.replace(/^\.\//, "");
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
