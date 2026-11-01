import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveContext } from "../git-context.js";
import { buildReport, retriggerBuild } from "../build-report.js";
import { diagnoseBuild } from "../build-diagnosis.js";
import { fetchBuild, fetchRecentBuilds, jobPath, missingBuildMessage } from "../jenkins-build.js";
import { jenkinsFolderFor } from "../jenkins-client.js";
import { discoverPipeline } from "../jenkins-discovery.js";
import { DEFAULT_TAIL_KB, MAX_TAIL_KB, consoleTail } from "../console-tail.js";

const DEFAULT_SAMPLE_SIZE = 20;
const MAX_SAMPLE_SIZE = 50;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const JOB_DESCRIPTION =
  "Jenkins job name as it appears in the URL, e.g. `my-app-master`, or a nested path like `my-app/master` for a branch job inside a multibranch folder";
const PR_JOB_DESCRIPTION =
  "The PR's Jenkins job by name, e.g. `my-app/PR-42`, when the folder is not named after the repository and JENKINS_JOBS does not list it (default: the job in the PR's latest Bitbucket status, else `<folder>/PR-<id>`)";
const PREVIOUS_LOG_SIZE_DESCRIPTION =
  "execution.log.size_bytes from an earlier report of the same building build, read minutes ago; execution.log.growing is then true or false against it. Without it (and without check_liveness) growing is null";
const CHECK_LIVENESS_DESCRIPTION =
  "Sample the console size again after 60 seconds so execution.log.growing is answered in one call; the call takes a minute longer. Ignored when previous_log_size is given";
const EXECUTION_DESCRIPTION =
  "An in_progress report carries execution: state (queued: no stage has started and no agent has been assigned; executing: every unfinished stage has a running step; waiting_for_agent: every unfinished stage sits in the queue for an executor; mixed: some of each), started_local, waited_for_first_agent, queued_for with queue_reason and queue_position while queued, on_executor_for (measured from the first stage start, never the build start, since a pipeline build counts as building while it waits hours for an agent), estimated_duration (null on a job's first build), every stage as done/executing/waiting_for_agent with ran_for/running_for/waiting_for, the executing step's command and the waiting stage's queue reason, agents_held (node and stage), log (size_bytes; growing, null unless previous_log_size or check_liveness was passed; current_step_tail: the last lines of the running step's own log; last_output_local and silent_for from its timestamps) and a one-sentence verdict that says whether it is queued, executing, between stages, waiting or possibly hung (a log that stopped growing, a step silent over 10 minutes, or every branch reporting all tests finished while another branch waits for an agent; no estimate needed); plus last_completed_build";

export function registerJenkinsTools(server: McpServer): void {
  server.tool(
    "getPullRequestBuildReport",
    `Explain a pull request's Jenkins build: outcome (passed, in_progress, aborted, tests_failed, failed), the stage it died in, which stages were aborted or skipped as a consequence, the failing tests with how closely each aligns to the files the PR author's own commits changed (direct, subject, neighbourhood, none) and changed_by, the PR commits that touched the test with their authors, so a test that arrived through a merge from upstream is attributed to whoever wrote it, the console lines that name a non-test failure, and failed_step: the step the died_in stage broke on, its command, and an excerpt of that step's own log (an rspec or Jest failures block, a Ruby exception with backtrace, or the last lines) so the reason is read from the failing command's output rather than from the whole console. An aborted build with no failed step carries aborted: who stopped it, the stage it was in, and the end of that stage's log. Defaults to the build Bitbucket reports as latest. ${EXECUTION_DESCRIPTION}: when asked why a build failed, call again with that build_number and diagnose that one rather than stopping at the run still going.`,
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      build_number: z
        .number()
        .optional()
        .describe("A specific build of the PR's job (default: the build in the PR's latest Bitbucket status)"),
      job: z.string().optional().describe(PR_JOB_DESCRIPTION),
      previous_log_size: z.number().optional().describe(PREVIOUS_LOG_SIZE_DESCRIPTION),
      check_liveness: z.boolean().optional().describe(CHECK_LIVENESS_DESCRIPTION),
    },
    async ({ workspace, repo_slug, pull_request_id, build_number, job, previous_log_size, check_liveness }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const report = await buildReport(ctx.workspace, ctx.repoSlug, pull_request_id, build_number, job, {
        previousLogSize: previous_log_size,
        checkLiveness: check_liveness,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
    },
  );

  server.tool(
    "getJenkinsBuildReport",
    `Explain one build of any Jenkins job by name, for builds that belong to no pull request such as a master branch or nightly job: outcome (passed, in_progress, aborted, tests_failed, failed), when it started in local time, the stage it died in, which stages were aborted or skipped as a consequence, the failing tests with file, example, error line and how many consecutive builds each has failed, the console lines that name a non-test failure, and failed_step: the step the died_in stage broke on, its command, and an excerpt of that step's own log (an rspec or Jest failures block, a Ruby exception with backtrace, or the last lines). An aborted build with no failed step carries aborted: who stopped it, the stage it was in, and the end of that stage's log. Defaults to the job's latest build. ${EXECUTION_DESCRIPTION}, so call again with that build_number when asked about a finished run. Carries no pull request alignment: to tell whether a failure is new, fetch the earlier build too and compare the two reports.`,
    {
      job: z.string().describe(JOB_DESCRIPTION),
      build_number: z.number().optional().describe("A specific build of the job (default: the latest build)"),
      previous_log_size: z.number().optional().describe(PREVIOUS_LOG_SIZE_DESCRIPTION),
      check_liveness: z.boolean().optional().describe(CHECK_LIVENESS_DESCRIPTION),
    },
    async ({ job, build_number, previous_log_size, check_liveness }) => {
      const path = jobPath(job);
      const build = await fetchBuild(path, build_number ?? "lastBuild");
      if (!build) throw new Error(await missingBuildMessage(path, build_number ?? "lastBuild"));
      const report = await diagnoseBuild(build, { previousLogSize: previous_log_size, checkLiveness: check_liveness });
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
    },
  );

  server.tool(
    "getJenkinsConsoleTail",
    'Read the end of a Jenkins build\'s console log, for "what is this build doing right now" and "where did it stop": the last kb kilobytes of the whole console (default 16, max 256), ConsoleNote blobs stripped, as lines with the log\'s current size_bytes and last_output_local, the timestamp of the last line written. With stage, the current (or last) step log of that stage or parallel branch instead, which is the clean per-branch output a build report\'s current_step_tail only samples. Works on a job by name (`my-app-master`, `my-app/PR-42`) and defaults to its latest build. Call size_bytes twice a few minutes apart to tell a working build from a hung one.',
    {
      job: z.string().describe(JOB_DESCRIPTION),
      build_number: z.number().optional().describe("A specific build of the job (default: the latest build)"),
      kb: z
        .number()
        .optional()
        .describe(`Kilobytes to read from the end (default ${DEFAULT_TAIL_KB}, max ${MAX_TAIL_KB})`),
      stage: z
        .string()
        .optional()
        .describe(
          "A stage or parallel-branch name as the build report lists it; reads that stage's current or last step log instead of the console",
        ),
    },
    async ({ job, build_number, kb, stage }) => {
      const path = jobPath(job);
      const build = await fetchBuild(path, build_number ?? "lastBuild");
      if (!build) throw new Error(await missingBuildMessage(path, build_number ?? "lastBuild"));
      const tail = await consoleTail(build, kb ?? DEFAULT_TAIL_KB, stage);
      return { content: [{ type: "text" as const, text: JSON.stringify(tail, null, 2) }] };
    },
  );

  server.tool(
    "listJenkinsBuilds",
    "The most recent builds of a Jenkins job by name, newest first: number, result (SUCCESS, UNSTABLE, FAILURE, ABORTED, or null while building), started_local, duration and URL. Use it to find the build that ran on a given night or date before calling getJenkinsBuildReport with its build_number; a job that also builds on merges through the day has several builds per date, so pick by start time.",
    {
      job: z.string().describe(JOB_DESCRIPTION),
      limit: z.number().optional().describe(`Builds to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT})`),
    },
    async ({ job, limit }) => {
      const builds = await fetchRecentBuilds(jobPath(job), Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
      if (!builds) throw new Error(`Jenkins has no job named "${job}".`);
      return { content: [{ type: "text" as const, text: JSON.stringify(builds, null, 2) }] };
    },
  );

  server.tool(
    "retriggerPullRequestBuild",
    "Queue a new Jenkins build of a pull request's job, without pushing anything. Checks Jenkins health first and refuses, with the reason, while Jenkins is quieting down or has no online agents. Returns the queue item and job URL; the build has not run yet when this returns. Use after a build failed for a reason unrelated to the PR's changes.",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      force: z.boolean().optional().describe("Queue the build even though Jenkins is not currently accepting builds"),
      job: z.string().optional().describe(PR_JOB_DESCRIPTION),
    },
    async ({ workspace, repo_slug, pull_request_id, force, job }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await retriggerBuild(ctx.workspace, ctx.repoSlug, pull_request_id, force ?? false, job);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "discoverJenkinsPipeline",
    "Sample recent completed builds and describe how a pipeline behaves: stage names and which run in parallel, how often a test report is published, outcome counts, and the failure signatures seen with example console lines. Given a multibranch folder it samples the latest completed build of each branch job; given a standalone job such as a master or nightly job it samples that job's last few builds. Use it to build or refresh a local manifest of this Jenkins setup, especially after a build that did not fit the manifest.",
    {
      repo_slug: z.string().optional(),
      job: z
        .string()
        .optional()
        .describe(
          "Multibranch folder or standalone job name (default: the repository's folder per JENKINS_JOBS, else its slug)",
        ),
      sample_size: z
        .number()
        .optional()
        .describe(`Builds to sample, newest first (default ${DEFAULT_SAMPLE_SIZE}, max ${MAX_SAMPLE_SIZE})`),
    },
    async ({ repo_slug, job, sample_size }) => {
      const target = job ?? jenkinsFolderFor(resolveContext(undefined, repo_slug).repoSlug);
      const profile = await discoverPipeline(target, Math.min(sample_size ?? DEFAULT_SAMPLE_SIZE, MAX_SAMPLE_SIZE));
      return { content: [{ type: "text" as const, text: JSON.stringify(profile, null, 2) }] };
    },
  );
}
