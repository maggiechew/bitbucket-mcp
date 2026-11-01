import {
  FailedTest,
  JenkinsBuild,
  JenkinsStage,
  StageCascade,
  TestReport,
  consoleErrors,
  fetchConsole,
  fetchConsoleTail,
  fetchLastCompletedBuildNumber,
  fetchStageSteps,
  fetchStages,
  fetchStepLogTail,
  fetchTestReport,
  stageCascade,
} from "./jenkins-build.js";
import { BuildOutcome, classifyFailure, classifyOutcome } from "./build-classification.js";
import { StatusIncident, bitbucketIncidentsBetween } from "./bitbucket-status.js";
import { toLocalTime } from "./pull-request-format.js";
import { BuildExecution, ExecutionOptions, buildExecution, tailLines } from "./build-execution.js";
import { FailedStepDiagnosis, FailedStepReport, failedStepReport } from "./step-log.js";

export interface AbortedReport {
  by: string | null;
  in_stage: string | null;
  stage_log_tail: string[];
}

export interface BuildDiagnosis {
  checked_at_local: string;
  build: JenkinsBuild;
  outcome: BuildOutcome;
  last_completed_build?: number;
  execution?: BuildExecution;
  classification?: string;
  died_in: string | null;
  stages: Omit<StageCascade, "died_in">;
  failed_step?: FailedStepReport;
  aborted?: AbortedReport;
  tests: { passed: number; skipped: number; failed: FailedTest[] } | null;
  console_errors: string[];
  console_url: string;
  bitbucket_incidents?: StatusIncident[];
}

const ABORT_TAIL_BYTES = 4_096;
const ABORTED_STEP_STATUSES = ["ABORTED", "FAILED"];

/**
 * Explains one Jenkins build of any job: whether it passed, where it died, which tests failed and
 * what the console said; while it builds, what it is doing right now. Knows nothing about pull requests.
 * @param build the build to explain
 * @param execution previousLogSize: the console size from an earlier report of the same building build, to judge log
 *   growth against; checkLiveness: sample the console size again a minute later instead
 */
export async function diagnoseBuild(build: JenkinsBuild, execution: ExecutionOptions = {}): Promise<BuildDiagnosis> {
  const [stages, junit, consoleText, lastCompleted, liveExecution] = await Promise.all([
    fetchStages(build.job, build.number),
    fetchTestReport(build.job, build.number),
    fetchConsole(build.job, build.number),
    build.building ? fetchLastCompletedBuildNumber(build.job) : null,
    build.building ? buildExecution(build, execution) : undefined,
  ]);

  const cascade = stageCascade(stages, consoleText);
  const errors = consoleErrors(consoleText);
  const diedIn = stages.find((stage) => stage.name === cascade.died_in);
  const failedStep = diedIn ? await failedStepReport(build.job, build.number, diedIn) : null;
  const tests = reportedTests(junit, failedStep);
  const outcome = classifyOutcome(build, tests);
  const incidents =
    outcome === "failed" ? await bitbucketIncidentsBetween(buildStart(build), buildEnd(build)) : undefined;
  const aborted = outcome === "aborted" && !failedStep ? await abortedReport(build, stages) : undefined;

  return {
    checked_at_local: toLocalTime(new Date().toISOString())!,
    build,
    outcome,
    last_completed_build: lastCompleted ?? undefined,
    execution: liveExecution,
    classification: outcome === "failed" ? classifyFailure(errors, cascade) : undefined,
    died_in: cascade.died_in,
    stages: { failed: cascade.failed, aborted: cascade.aborted, skipped: cascade.skipped },
    failed_step: failedStep ? withExcerptValue(failedStep.report, tests) : undefined,
    aborted,
    tests,
    console_errors: errors,
    console_url: `${build.url}console`,
    bitbucket_incidents: incidents,
  };
}

// The junit report is the record when it lists failures; when it lists none, or was never published
// because rspec died before writing it, the failing step's own rspec output names them instead.
function reportedTests(junit: TestReport | null, failedStep: FailedStepDiagnosis | null): TestReport | null {
  const parsed = failedStep?.failed_tests ?? [];
  if (junit?.failed.length || parsed.length === 0) return junit;
  return { passed: junit?.passed ?? 0, skipped: junit?.skipped ?? 0, failed: parsed };
}

// A tail around a test run that named its failures is noise next to them.
function withExcerptValue(report: FailedStepReport, tests: TestReport | null): FailedStepReport {
  const lowValue = report.excerpt_kind === "tail" && Boolean(tests?.failed.length);
  return lowValue ? { ...report, excerpt_low_value: true } : report;
}

// Who stopped the build, the first stage cut short, and the end of that stage's own output; when no
// stage was marked aborted (stopped before any ran) the build console's end stands in.
async function abortedReport(build: JenkinsBuild, stages: JenkinsStage[]): Promise<AbortedReport> {
  const inStage = stages.filter((stage) => stage.status === "ABORTED").sort((a, b) => a.started_ms - b.started_ms)[0];
  const stepTail = inStage ? await abortedStepTail(build, inStage) : null;
  const tail = stepTail || (await fetchConsoleTail(build.job, build.number, ABORT_TAIL_BYTES))?.text || "";
  return {
    by: build.interrupted_by?.join("; ") ?? null,
    in_stage: inStage?.name ?? null,
    stage_log_tail: tailLines(tail),
  };
}

async function abortedStepTail(build: JenkinsBuild, stage: JenkinsStage): Promise<string | null> {
  const steps = await fetchStageSteps(build.job, build.number, stage.id);
  const reversed = [...steps].reverse();
  const step =
    reversed.find((candidate) => ABORTED_STEP_STATUSES.includes(candidate.status) && candidate.command) ??
    reversed.find((candidate) => ABORTED_STEP_STATUSES.includes(candidate.status)) ??
    reversed.find((candidate) => candidate.command);
  if (!step) return null;
  const log = await fetchStepLogTail(build.job, build.number, step.id, ABORT_TAIL_BYTES);
  return log?.text ?? null;
}

function buildStart(build: JenkinsBuild): Date {
  return new Date(build.started_at);
}

function buildEnd(build: JenkinsBuild): Date {
  return new Date(buildStart(build).getTime() + build.duration_seconds * 1000);
}
