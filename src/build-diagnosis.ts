import {
  FailedTest,
  JenkinsBuild,
  StageCascade,
  consoleErrors,
  fetchConsole,
  fetchLastCompletedBuildNumber,
  fetchStages,
  fetchTestReport,
  stageCascade,
} from "./jenkins-build.js";
import { BuildOutcome, classifyFailure, classifyOutcome } from "./build-classification.js";
import { StatusIncident, bitbucketIncidentsBetween } from "./bitbucket-status.js";
import { toLocalTime } from "./pull-request-format.js";
import { BuildExecution, buildExecution } from "./ci-health.js";
import { FailedStepReport, failedStepReport } from "./step-log.js";

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
  tests: { passed: number; skipped: number; failed: FailedTest[] } | null;
  console_errors: string[];
  console_url: string;
  bitbucket_incidents?: StatusIncident[];
}

/**
 * Explains one Jenkins build of any job: whether it passed, where it died, which tests failed and
 * what the console said. Knows nothing about pull requests.
 */
export async function diagnoseBuild(build: JenkinsBuild): Promise<BuildDiagnosis> {
  const [stages, tests, consoleText, lastCompleted, execution] = await Promise.all([
    fetchStages(build.job, build.number),
    fetchTestReport(build.job, build.number),
    fetchConsole(build.job, build.number),
    build.building ? fetchLastCompletedBuildNumber(build.job) : null,
    build.building ? buildExecution(build.job, build.number) : undefined,
  ]);

  const cascade = stageCascade(stages, consoleText);
  const errors = consoleErrors(consoleText);
  const outcome = classifyOutcome(build, tests);
  const diedIn = stages.find((stage) => stage.name === cascade.died_in);
  const [incidents, failedStep] = await Promise.all([
    outcome === "failed" ? bitbucketIncidentsBetween(buildStart(build), buildEnd(build)) : undefined,
    diedIn ? failedStepReport(build.job, build.number, diedIn) : undefined,
  ]);

  return {
    checked_at_local: toLocalTime(new Date().toISOString())!,
    build,
    outcome,
    last_completed_build: lastCompleted ?? undefined,
    execution,
    classification: outcome === "failed" ? classifyFailure(errors, cascade) : undefined,
    died_in: cascade.died_in,
    stages: { failed: cascade.failed, aborted: cascade.aborted, skipped: cascade.skipped },
    failed_step: failedStep ?? undefined,
    tests,
    console_errors: errors,
    console_url: `${build.url}console`,
    bitbucket_incidents: incidents,
  };
}

function buildStart(build: JenkinsBuild): Date {
  return new Date(build.started_at);
}

function buildEnd(build: JenkinsBuild): Date {
  return new Date(buildStart(build).getTime() + build.duration_seconds * 1000);
}
