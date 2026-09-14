import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveContext } from "../git-context.js";
import { buildReport, retriggerBuild } from "../build-report.js";
import { discoverPipeline } from "../jenkins-discovery.js";

const DEFAULT_SAMPLE_SIZE = 20;
const MAX_SAMPLE_SIZE = 50;

export function registerJenkinsTools(server: McpServer): void {
  server.tool(
    "getPullRequestBuildReport",
    "Explain a pull request's Jenkins build: outcome (passed, in_progress, aborted, tests_failed, failed), the stage it died in, which stages were aborted or skipped as a consequence, the failing tests with how closely each aligns to the files the PR author's own commits changed (direct, subject, neighbourhood, none) and changed_by, the PR commits that touched the test with their authors, so a test that arrived through a merge from upstream is attributed to whoever wrote it, and the console lines that name a non-test failure. Defaults to the build Bitbucket reports as latest. An in_progress report carries execution (running, or waiting_for_agent with Jenkins's reason and the minutes waited, since a pipeline build counts as building while it sits in the queue for an agent) and last_completed_build: when asked why a build failed, call again with that build_number and diagnose that one rather than stopping at the run still going.",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      build_number: z.number().optional().describe("A specific build of the PR's job (default: the build in the PR's latest Bitbucket status)"),
    },
    async ({ workspace, repo_slug, pull_request_id, build_number }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const report = await buildReport(ctx.workspace, ctx.repoSlug, pull_request_id, build_number);
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
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
    "Sample the most recent completed builds in a Jenkins multibranch folder and describe how its pipeline behaves: stage names and which run in parallel, how often a test report is published, outcome counts, and the failure signatures seen with example console lines. Use it to build or refresh a local manifest of this Jenkins setup, especially after a build that did not fit the manifest.",
    {
      repo_slug: z.string().optional(),
      job_folder: z.string().optional().describe("Multibranch folder name (default: the repository slug)"),
      sample_size: z.number().optional().describe(`Builds to sample, one per job, newest first (default ${DEFAULT_SAMPLE_SIZE}, max ${MAX_SAMPLE_SIZE})`),
    },
    async ({ repo_slug, job_folder, sample_size }) => {
      const folder = job_folder ?? resolveContext(undefined, repo_slug).repoSlug;
      const profile = await discoverPipeline(folder, Math.min(sample_size ?? DEFAULT_SAMPLE_SIZE, MAX_SAMPLE_SIZE));
      return { content: [{ type: "text" as const, text: JSON.stringify(profile, null, 2) }] };
    },
  );
}
