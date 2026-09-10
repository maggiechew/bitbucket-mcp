import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bitbucketRequest } from "../client.js";
import { resolveContext } from "../git-context.js";

export function registerActivityTools(server: McpServer): void {
  server.tool(
    "getPullRequestActivity",
    "Get the activity log for a pull request (comments, approvals, pushes, status changes)",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      page: z.number().optional(),
      pagelen: z.number().optional(),
    },
    async ({ workspace, repo_slug, pull_request_id, page, pagelen }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const params = new URLSearchParams();
      if (page) params.set("page", String(page));
      if (pagelen) params.set("pagelen", String(pagelen));

      const query = params.toString();
      const path = `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/activity${query ? `?${query}` : ""}`;
      const result = await bitbucketRequest(path);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
