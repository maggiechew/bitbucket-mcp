import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bitbucketRequest, bitbucketPaginated } from "../client.js";
import { resolveContext } from "../git-context.js";

export function registerCommentTools(server: McpServer): void {
  server.tool(
    "getPullRequestComments",
    "List all comments on a pull request",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      page: z.number().optional(),
      pagelen: z.number().optional(),
    },
    async ({ workspace, repo_slug, pull_request_id, page, pagelen }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketPaginated(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/comments`,
        { page, pagelen },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "addPullRequestComment",
    "Add a comment to a pull request (general or inline on a specific file/line)",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      content: z.string().describe("Comment body (markdown)"),
      inline_path: z.string().optional().describe("File path for inline comment"),
      inline_from: z.number().optional().describe("Start line for inline comment (old side)"),
      inline_to: z.number().optional().describe("End line for inline comment (new side)"),
      parent_id: z.number().optional().describe("Parent comment ID for replies"),
    },
    async ({ workspace, repo_slug, pull_request_id, content, inline_path, inline_from, inline_to, parent_id }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const body: Record<string, unknown> = {
        content: { raw: content },
      };

      if (inline_path) {
        const inline: Record<string, unknown> = { path: inline_path };
        if (inline_from !== undefined) inline.from = inline_from;
        if (inline_to !== undefined) inline.to = inline_to;
        body.inline = inline;
      }

      if (parent_id) {
        body.parent = { id: parent_id };
      }

      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/comments`,
        { method: "POST", body },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "updatePullRequestComment",
    "Update an existing comment on a pull request",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      comment_id: z.number().describe("Comment ID"),
      content: z.string().describe("New comment body (markdown)"),
    },
    async ({ workspace, repo_slug, pull_request_id, comment_id, content }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/comments/${comment_id}`,
        { method: "PUT", body: { content: { raw: content } } },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "deletePullRequestComment",
    "Delete a comment from a pull request",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      comment_id: z.number().describe("Comment ID"),
    },
    async ({ workspace, repo_slug, pull_request_id, comment_id }) => {
      const ctx = resolveContext(workspace, repo_slug);
      await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/comments/${comment_id}`,
        { method: "DELETE" },
      );
      return { content: [{ type: "text" as const, text: "Comment deleted successfully." }] };
    },
  );
}
