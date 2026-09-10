import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bitbucketRequest, bitbucketPaginated } from "../client.js";
import { resolveContext } from "../git-context.js";

export function registerPipelineTools(server: McpServer): void {
  server.tool(
    "listPipelineRuns",
    "List recent pipeline runs, optionally filtered by status or branch",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      page: z.number().optional(),
      pagelen: z.number().optional(),
      sort: z.string().optional().describe("Sort field, e.g. '-created_on' for newest first"),
    },
    async ({ workspace, repo_slug, page, pagelen, sort }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const params = new URLSearchParams();
      if (page) params.set("page", String(page));
      if (pagelen) params.set("pagelen", String(pagelen));
      if (sort) params.set("sort", sort);

      const query = params.toString();
      const path = `/repositories/${ctx.workspace}/${ctx.repoSlug}/pipelines/${query ? `?${query}` : ""}`;
      const result = await bitbucketRequest(path);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "getPipelineRun",
    "Get details of a specific pipeline run (state, duration, result)",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pipeline_uuid: z.string().describe("Pipeline run UUID"),
    },
    async ({ workspace, repo_slug, pipeline_uuid }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pipelines/${pipeline_uuid}`,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "runPipeline",
    "Trigger a new pipeline run on a branch, tag, or custom pipeline",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      ref_name: z.string().describe("Branch, tag, or bookmark name"),
      ref_type: z.enum(["branch", "tag", "bookmark", "named_branch"]).optional().describe("Reference type (default: branch)"),
      selector_type: z.enum(["default", "custom", "pull-requests"]).optional().describe("Pipeline selector type"),
      selector_pattern: z.string().optional().describe("Pipeline name for custom pipelines"),
      variables: z.array(z.object({
        key: z.string(),
        value: z.string(),
        secured: z.boolean().optional(),
      })).optional().describe("Pipeline variables"),
    },
    async ({ workspace, repo_slug, ref_name, ref_type, selector_type, selector_pattern, variables }) => {
      const ctx = resolveContext(workspace, repo_slug);

      const target: Record<string, unknown> = {
        ref_type: ref_type || "branch",
        ref_name,
        type: "pipeline_ref_target",
      };

      if (selector_type) {
        target.selector = { type: selector_type, pattern: selector_pattern || "" };
      }

      const body: Record<string, unknown> = { target };
      if (variables?.length) body.variables = variables;

      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pipelines/`,
        { method: "POST", body },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "stopPipeline",
    "Stop/abort a running pipeline",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pipeline_uuid: z.string().describe("Pipeline run UUID"),
    },
    async ({ workspace, repo_slug, pipeline_uuid }) => {
      const ctx = resolveContext(workspace, repo_slug);
      await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pipelines/${pipeline_uuid}/stopPipeline`,
        { method: "POST" },
      );
      return { content: [{ type: "text" as const, text: "Pipeline stopped successfully." }] };
    },
  );

  server.tool(
    "getPipelineSteps",
    "List steps within a pipeline run and their results",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pipeline_uuid: z.string().describe("Pipeline run UUID"),
    },
    async ({ workspace, repo_slug, pipeline_uuid }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pipelines/${pipeline_uuid}/steps/`,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "getPipelineStepLogs",
    "Get stdout/stderr logs from a specific pipeline step",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pipeline_uuid: z.string().describe("Pipeline run UUID"),
      step_uuid: z.string().describe("Step UUID"),
    },
    async ({ workspace, repo_slug, pipeline_uuid, step_uuid }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketRequest<string>(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pipelines/${pipeline_uuid}/steps/${step_uuid}/log`,
        { accept: "text/plain" },
      );
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
}
