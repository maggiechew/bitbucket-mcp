import { AlignmentBasis, CommitTouch, fetchPullRequestChanges } from "./pull-request-changes.js";
import { fetchBuildStatuses } from "./pull-request-enrich.js";
import { jenkinsBaseUrl, jenkinsPost } from "./jenkins-client.js";
import {
  FailedTest,
  JenkinsBuild,
  StageCascade,
  consoleErrors,
  fetchBuild,
  fetchConsole,
  fetchLastCompletedBuildNumber,
  fetchStages,
  fetchTestReport,
  jobFromStatusUrl,
  pullRequestJob,
  stageCascade,
} from "./jenkins-build.js";
import { BuildOutcome, classifyFailure, classifyOutcome } from "./build-classification.js";
import { TestAlignment, alignTest } from "./test-alignment.js";
import { StatusIncident, bitbucketIncidentsBetween } from "./bitbucket-status.js";
import { toLocalTime } from "./pull-request-format.js";
import { BuildExecution, buildExecution, jenkinsHealth, jenkinsNotAcceptingBuilds } from "./ci-health.js";

export interface BuildReport {
  pull_request_id: number;
  checked_at_local: string;
  build: JenkinsBuild;
  outcome: BuildOutcome;
  last_completed_build?: number;
  execution?: BuildExecution;
  classification?: string;
  died_in: string | null;
  stages: Omit<StageCascade, "died_in">;
  tests: { passed: number; skipped: number; failed: FailedTestReport[] } | null;
  console_errors: string[];
  console_url: string;
  bitbucket_incidents?: StatusIncident[];
  pull_request_author: string;
  changed_files: number;
  authored_files: number;
  alignment_basis: AlignmentBasis;
}

export type FailedTestReport = FailedTest & TestAlignment & { changed_by: CommitTouch[] };

/**
 * Explains one PR build: whether it passed, where it died, which tests failed and how close each
 * sits to the PR's own changes. Reads the Jenkins job from the PR's Bitbucket build status.
 */
export async function buildReport(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
  buildNumber: number | undefined,
): Promise<BuildReport> {
  const build = await locateBuild(workspace, repoSlug, pullRequestId, buildNumber);
  const [stages, tests, consoleText, changes, lastCompleted, execution] = await Promise.all([
    fetchStages(build.job, build.number),
    fetchTestReport(build.job, build.number),
    fetchConsole(build.job, build.number),
    fetchPullRequestChanges(workspace, repoSlug, pullRequestId),
    build.building ? fetchLastCompletedBuildNumber(build.job) : null,
    build.building ? buildExecution(build.job, build.number) : undefined,
  ]);

  const cascade = stageCascade(stages, consoleText);
  const errors = consoleErrors(consoleText);
  const outcome = classifyOutcome(build, tests);
  const incidents = outcome === "failed" ? await bitbucketIncidentsBetween(buildStart(build), buildEnd(build)) : undefined;

  return {
    pull_request_id: pullRequestId,
    checked_at_local: toLocalTime(new Date().toISOString())!,
    build,
    outcome,
    last_completed_build: lastCompleted ?? undefined,
    execution,
    classification: outcome === "failed" ? classifyFailure(errors, cascade) : undefined,
    died_in: cascade.died_in,
    stages: { failed: cascade.failed, aborted: cascade.aborted, skipped: cascade.skipped },
    tests: tests && {
      passed: tests.passed,
      skipped: tests.skipped,
      failed: tests.failed.map((test) => ({
        ...test,
        ...alignTest(test.file, changes.authored_files),
        changed_by: changes.touchedBy(test.file),
      })),
    },
    console_errors: errors,
    console_url: `${build.url}console`,
    bitbucket_incidents: incidents,
    pull_request_author: changes.author,
    changed_files: changes.changed_files,
    authored_files: changes.authored_files.length,
    alignment_basis: changes.alignment_basis,
  };
}

export interface RetriggerResult {
  pull_request_id: number;
  job: string;
  previous_build: number | null;
  queue_url?: string;
  job_url: string;
}

/**
 * Asks Jenkins to build the PR's job again. The build is queued, not finished, when this returns.
 * Refuses while Jenkins would not run it (quieting down, no agents) unless forced.
 */
export async function retriggerBuild(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
  force: boolean,
): Promise<RetriggerResult> {
  const blocker = force ? null : jenkinsNotAcceptingBuilds(await jenkinsHealth());
  if (blocker) throw new Error(`Not retriggering: ${blocker} Pass force: true to queue it anyway.`);

  const located = await locateJob(workspace, repoSlug, pullRequestId);
  const queueUrl = await jenkinsPost(`${located.job}/build`);
  return {
    pull_request_id: pullRequestId,
    job: located.job,
    previous_build: located.number,
    queue_url: queueUrl,
    job_url: `${jenkinsBaseUrl()}${located.job}/`,
  };
}

// The Bitbucket status URL names the Jenkins job whatever the folder is called; the PR-<id>
// convention of a multibranch folder named after the repo is the fallback when no status exists.
async function locateJob(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
): Promise<{ job: string; number: number | null }> {
  const statuses = await fetchBuildStatuses(workspace, repoSlug, pullRequestId);
  const located = jobFromStatusUrl(statuses[0]?.url);
  return located ?? { job: pullRequestJob(repoSlug, pullRequestId), number: null };
}

async function locateBuild(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
  buildNumber: number | undefined,
): Promise<JenkinsBuild> {
  const located = await locateJob(workspace, repoSlug, pullRequestId);
  const number = buildNumber ?? located.number ?? "lastBuild";

  const build = await fetchBuild(located.job, number);
  if (!build) throw new Error(`Jenkins has no build ${number} for ${located.job}.`);
  return build;
}

function buildStart(build: JenkinsBuild): Date {
  return new Date(build.started_at);
}

function buildEnd(build: JenkinsBuild): Date {
  return new Date(buildStart(build).getTime() + build.duration_seconds * 1000);
}
