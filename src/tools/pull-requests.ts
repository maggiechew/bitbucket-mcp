import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bitbucketRequest, bitbucketPaginated } from "../client.js";
import { resolveContext } from "../git-context.js";

export function registerPullRequestTools(server: McpServer): void {
  server.tool(
    "listPullRequests",
    "List pull requests in a repository, filtered by state",
    {
      workspace: z.string().optional().describe("Bitbucket workspace (auto-detected from git remote if omitted)"),
      repo_slug: z.string().optional().describe("Repository slug (auto-detected from git remote if omitted)"),
      state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional().describe("Filter by PR state (default: OPEN)"),
      page: z.number().optional().describe("Page number"),
      pagelen: z.number().optional().describe("Results per page (max 50)"),
    },
    async ({ workspace, repo_slug, state, page, pagelen }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const params = new URLSearchParams();
      if (state) params.set("state", state);
      if (page) params.set("page", String(page));
      if (pagelen) params.set("pagelen", String(pagelen));

      const query = params.toString();
      const path = `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests${query ? `?${query}` : ""}`;
      const result = await bitbucketRequest(path);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "getPullRequest",
    "Get details of a specific pull request",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
    },
    async ({ workspace, repo_slug, pull_request_id }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}`,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "createPullRequest",
    "Create a new pull request",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      title: z.string().describe("PR title"),
      source_branch: z.string().describe("Source branch name"),
      destination_branch: z.string().optional().describe("Destination branch (default: repo main branch)"),
      description: z.string().optional().describe("PR description (markdown)"),
      reviewers: z.array(z.string()).optional().describe("Array of reviewer account UUIDs"),
      close_source_branch: z.boolean().optional().describe("Close source branch on merge"),
    },
    async ({ workspace, repo_slug, title, source_branch, destination_branch, description, reviewers, close_source_branch }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const body: Record<string, unknown> = {
        title,
        source: { branch: { name: source_branch } },
      };
      if (destination_branch) {
        body.destination = { branch: { name: destination_branch } };
      }
      if (description) body.description = description;
      if (close_source_branch !== undefined) body.close_source_branch = close_source_branch;
      if (reviewers?.length) {
        body.reviewers = reviewers.map((uuid) => ({ uuid }));
      }

      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests`,
        { method: "POST", body },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "updatePullRequest",
    "Update a pull request (title, description, reviewers, destination branch)",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description (markdown)"),
      destination_branch: z.string().optional().describe("New destination branch"),
      reviewers: z.array(z.string()).optional().describe("Replace reviewers (account UUIDs)"),
    },
    async ({ workspace, repo_slug, pull_request_id, title, description, destination_branch, reviewers }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const body: Record<string, unknown> = {};
      if (title) body.title = title;
      if (description) body.description = description;
      if (destination_branch) body.destination = { branch: { name: destination_branch } };
      if (reviewers) body.reviewers = reviewers.map((uuid) => ({ uuid }));

      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}`,
        { method: "PUT", body },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "getPullRequestCommits",
    "List commits on a pull request",
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
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/commits`,
        { page, pagelen },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "createDraftPullRequest",
    "Create a draft pull request",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      title: z.string().describe("PR title"),
      source_branch: z.string().describe("Source branch name"),
      destination_branch: z.string().optional().describe("Destination branch (default: repo main branch)"),
      description: z.string().optional().describe("PR description (markdown)"),
    },
    async ({ workspace, repo_slug, title, source_branch, destination_branch, description }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const body: Record<string, unknown> = {
        title,
        source: { branch: { name: source_branch } },
        draft: true,
      };
      if (destination_branch) body.destination = { branch: { name: destination_branch } };
      if (description) body.description = description;

      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests`,
        { method: "POST", body },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "publishDraftPullRequest",
    "Publish a draft pull request (mark it as ready for review)",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
    },
    async ({ workspace, repo_slug, pull_request_id }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}`,
        { method: "PUT", body: { draft: false } },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "convertToDraft",
    "Convert an open pull request back to draft",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
    },
    async ({ workspace, repo_slug, pull_request_id }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketRequest(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}`,
        { method: "PUT", body: { draft: true } },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
