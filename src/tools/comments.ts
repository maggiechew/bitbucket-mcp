import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bitbucketRequest, bitbucketAllPages } from "../client.js";
import { resolveContext } from "../git-context.js";
import { RawComment, compactComments } from "../comment-format.js";

const MAX_COMMENTS = 200;

export function registerCommentTools(server: McpServer): void {
  server.tool(
    "getPullRequestComments",
    "Every non-deleted comment on a pull request in chronological order, as compact records (author, local timestamp, body, inline file/line, reply_to).",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      limit: z.number().optional().describe(`Maximum comments to return across pages (default ${MAX_COMMENTS})`),
      verbose: z.boolean().optional().describe("Return the raw API objects instead of the compact records"),
    },
    async ({ workspace, repo_slug, pull_request_id, limit, verbose }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketAllPages<RawComment>(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/comments`,
        new URLSearchParams(),
        limit ?? MAX_COMMENTS,
      );
      const payload = verbose ? result.values : compactComments(result.values);
      const note = result.truncated ? "(more available; raise limit)\n" : "";
      return { content: [{ type: "text" as const, text: `${note}${JSON.stringify(payload, null, 2)}` }] };
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
    "resolvePullRequestComment",
    "Mark a pull request comment thread as resolved",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      comment_id: z.number().describe("Comment ID"),
    },
    async ({ workspace, repo_slug, pull_request_id, comment_id }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/comments/${comment_id}/resolve`,
        { method: "POST" },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "reopenPullRequestComment",
    "Reopen a resolved pull request comment thread",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      comment_id: z.number().describe("Comment ID"),
    },
    async ({ workspace, repo_slug, pull_request_id, comment_id }) => {
      const ctx = resolveContext(workspace, repo_slug);
      await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/comments/${comment_id}/resolve`,
        { method: "DELETE" },
      );
      return { content: [{ type: "text" as const, text: "Comment thread reopened." }] };
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
