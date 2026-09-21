import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveContext } from "../git-context.js";
import { buildReport, retriggerBuild } from "../build-report.js";
import { diagnoseBuild } from "../build-diagnosis.js";
import { fetchBuild, fetchRecentBuilds, jobPath } from "../jenkins-build.js";
import { discoverPipeline } from "../jenkins-discovery.js";

const DEFAULT_SAMPLE_SIZE = 20;
const MAX_SAMPLE_SIZE = 50;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const JOB_DESCRIPTION =
  "Jenkins job name as it appears in the URL, e.g. `my-app-master`, or a nested path like `my-app/master` for a branch job inside a multibranch folder";

export function registerJenkinsTools(server: McpServer): void {
  server.tool(
    "getPullRequestBuildReport",
    "Explain a pull request's Jenkins build: outcome (passed, in_progress, aborted, tests_failed, failed), the stage it died in, which stages were aborted or skipped as a consequence, the failing tests with how closely each aligns to the files the PR author's own commits changed (direct, subject, neighbourhood, none) and changed_by, the PR commits that touched the test with their authors, so a test that arrived through a merge from upstream is attributed to whoever wrote it, the console lines that name a non-test failure, and failed_step: the step the died_in stage broke on, its command, and an excerpt of that step's own log (an rspec or Jest failures block, a Ruby exception with backtrace, or the last lines) so the reason is read from the failing command's output rather than from the whole console. Defaults to the build Bitbucket reports as latest. An in_progress report carries execution (running, or waiting_for_agent with Jenkins's reason and the minutes waited, since a pipeline build counts as building while it sits in the queue for an agent) and last_completed_build: when asked why a build failed, call again with that build_number and diagnose that one rather than stopping at the run still going.",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      build_number: z
        .number()
        .optional()
        .describe("A specific build of the PR's job (default: the build in the PR's latest Bitbucket status)"),
    },
    async ({ workspace, repo_slug, pull_request_id, build_number }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const report = await buildReport(ctx.workspace, ctx.repoSlug, pull_request_id, build_number);
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
    },
  );

  server.tool(
    "getJenkinsBuildReport",
    "Explain one build of any Jenkins job by name, for builds that belong to no pull request such as a master branch or nightly job: outcome (passed, in_progress, aborted, tests_failed, failed), when it started in local time, the stage it died in, which stages were aborted or skipped as a consequence, the failing tests with file, example, error line and how many consecutive builds each has failed, the console lines that name a non-test failure, and failed_step: the step the died_in stage broke on, its command, and an excerpt of that step's own log (an rspec or Jest failures block, a Ruby exception with backtrace, or the last lines). Defaults to the job's latest build; an in_progress report carries execution and last_completed_build, so call again with that build_number when asked about a finished run. Carries no pull request alignment: to tell whether a failure is new, fetch the earlier build too and compare the two reports.",
    {
      job: z.string().describe(JOB_DESCRIPTION),
      build_number: z.number().optional().describe("A specific build of the job (default: the latest build)"),
    },
    async ({ job, build_number }) => {
      const path = jobPath(job);
      const build = await fetchBuild(path, build_number ?? "lastBuild");
      if (!build) throw new Error(`Jenkins has no build ${build_number ?? "lastBuild"} for ${job}.`);
      const report = await diagnoseBuild(build);
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
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
    },
    async ({ workspace, repo_slug, pull_request_id, force }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await retriggerBuild(ctx.workspace, ctx.repoSlug, pull_request_id, force ?? false);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "discoverJenkinsPipeline",
    "Sample recent completed builds and describe how a pipeline behaves: stage names and which run in parallel, how often a test report is published, outcome counts, and the failure signatures seen with example console lines. Given a multibranch folder it samples the latest completed build of each branch job; given a standalone job such as a master or nightly job it samples that job's last few builds. Use it to build or refresh a local manifest of this Jenkins setup, especially after a build that did not fit the manifest.",
    {
      repo_slug: z.string().optional(),
      job: z.string().optional().describe("Multibranch folder or standalone job name (default: the repository slug)"),
      sample_size: z
        .number()
        .optional()
        .describe(`Builds to sample, newest first (default ${DEFAULT_SAMPLE_SIZE}, max ${MAX_SAMPLE_SIZE})`),
    },
    async ({ repo_slug, job, sample_size }) => {
      const target = job ?? resolveContext(undefined, repo_slug).repoSlug;
      const profile = await discoverPipeline(target, Math.min(sample_size ?? DEFAULT_SAMPLE_SIZE, MAX_SAMPLE_SIZE));
      return { content: [{ type: "text" as const, text: JSON.stringify(profile, null, 2) }] };
    },
  );
}
