import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bitbucketRequest, bitbucketPaginated, bitbucketAllPages } from "../client.js";
import { resolveContext, resolveWorkspace } from "../git-context.js";
import { resolveAuthorUuid, resolveUserUuids } from "../users.js";
import {
  CompactPullRequest,
  RawPullRequest,
  compactPullRequest,
  repoSlugFromFullName,
  summarizeList,
} from "../pull-request-format.js";
import { enrichAll, EnrichedPullRequest, fetchBuildStatuses, summarizeReview } from "../pull-request-enrich.js";
import { RawDiffstatEntry, compactDiffstatEntry, summarizeDiffstat } from "../diffstat-format.js";

const PR_STATES = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"] as const;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const DEFAULT_UPDATED_WITHIN_DAYS = 30;
const AUTO_DETAIL_THRESHOLD = 20;
const DIFFSTAT_LIMIT = 500;

const listSchema = {
  states: z.array(z.enum(PR_STATES)).optional().describe("PR states to include (default: [OPEN])"),
  title_contains: z.string().optional().describe("Only PRs whose title contains this text (case-insensitive)"),
  updated_within_days: z
    .number()
    .optional()
    .describe(`Only PRs updated in the last N days (default ${DEFAULT_UPDATED_WITHIN_DAYS}; pass 0 for no cutoff)`),
  limit: z
    .number()
    .optional()
    .describe(`Maximum PRs to return across pages (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
  include_details: z
    .boolean()
    .optional()
    .describe(
      `Attach latest build status and review/approval summary to each PR (default: on when ${AUTO_DETAIL_THRESHOLD} or fewer PRs are returned)`,
    ),
  verbose: z.boolean().optional().describe("Return the raw API objects instead of the compact summary"),
};

function stateClause(states: readonly string[]): string {
  const clauses = states.map((s) => `state="${s}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function titleClause(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return `title ~ "${text.replace(/"/g, '\\"')}"`;
}

function updatedSinceClause(days: number | undefined): string | undefined {
  const window = days ?? DEFAULT_UPDATED_WITHIN_DAYS;
  if (window <= 0) return undefined;
  const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000);
  return `updated_on >= ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

async function respond(
  workspace: string,
  fallbackRepoSlug: string,
  result: { values: unknown[]; total?: number; truncated: boolean },
  options: { include_details?: boolean; verbose?: boolean },
) {
  if (options.verbose) {
    const text = `${summarizeList(result.values.length, result.total, result.truncated, false)}\n${JSON.stringify(result.values, null, 2)}`;
    return { content: [{ type: "text" as const, text }] };
  }

  const compact = (result.values as RawPullRequest[]).map(compactPullRequest);
  const withDetails = options.include_details ?? compact.length <= AUTO_DETAIL_THRESHOLD;
  const items: CompactPullRequest[] = withDetails
    ? await enrichAll(workspace, compact, (pr) => repoSlugFromFullName(pr.repo, fallbackRepoSlug))
    : compact;

  const text = `${summarizeList(items.length, result.total, result.truncated, withDetails)}\n${JSON.stringify(items, null, 2)}`;
  return { content: [{ type: "text" as const, text }] };
}

const users = z.union([z.string(), z.array(z.string())]);

async function userClause(field: string, workspace: string, people: string | string[]): Promise<string> {
  const uuids = await resolveUserUuids(workspace, Array.isArray(people) ? people : [people]);
  const clauses = uuids.map((uuid) => `${field}="${uuid}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function reviewerBodies(uuids: string[]): { uuid: string }[] {
  return [...new Set(uuids)].map((uuid) => ({ uuid }));
}

async function adjustedReviewers(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
  add: string[],
  remove: string[],
): Promise<string[]> {
  const [current, added, removed] = await Promise.all([
    currentReviewerUuids(workspace, repoSlug, pullRequestId),
    resolveUserUuids(workspace, add),
    resolveUserUuids(workspace, remove),
  ]);
  return [...current, ...added].filter((uuid) => !removed.includes(uuid));
}

async function currentReviewerUuids(workspace: string, repoSlug: string, pullRequestId: number): Promise<string[]> {
  const pr = await bitbucketRequest<{ reviewers?: { uuid: string }[] }>(
    `/repositories/${workspace}/${repoSlug}/pullrequests/${pullRequestId}?fields=reviewers.uuid`,
  );
  return (pr.reviewers ?? []).map((reviewer) => reviewer.uuid);
}

export function registerPullRequestTools(server: McpServer): void {
  server.tool(
    "listPullRequests",
    "List pull requests in a repository as compact records, each with latest build status and review state. Filter by author or reviewer ('me', a name fragment, or a uuid; pass an array to match any of several people in one call), by states, and by recency. Fetches every page up to limit.",
    {
      workspace: z.string().optional().describe("Bitbucket workspace (auto-detected from git remote if omitted)"),
      repo_slug: z.string().optional().describe("Repository slug (auto-detected from git remote if omitted)"),
      author: users
        .optional()
        .describe(
          "Only PRs by this author, or any of these authors: 'me', a name as the user said it, or a uuid. Names resolve exactly as findUsers does; no lookup needed first",
        ),
      reviewer: users
        .optional()
        .describe(
          "Only PRs where this user, or any of these users, is a reviewer: 'me', a name fragment, or a uuid. Check review.pending to see whether they still need to act.",
        ),
      sort: z.string().optional().describe("Sort field, prefix '-' for descending (default: -updated_on)"),
      ...listSchema,
    },
    async ({
      workspace,
      repo_slug,
      author,
      reviewer,
      sort,
      states,
      title_contains,
      updated_within_days,
      limit,
      include_details,
      verbose,
    }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const clauses = [stateClause(states?.length ? states : ["OPEN"])];
      if (author) clauses.push(await userClause("author.uuid", ctx.workspace, author));
      if (reviewer) clauses.push(await userClause("reviewers.uuid", ctx.workspace, reviewer));
      const title = titleClause(title_contains);
      if (title) clauses.push(title);
      const since = updatedSinceClause(updated_within_days);
      if (since) clauses.push(since);

      const params = new URLSearchParams();
      params.set("q", clauses.join(" AND "));
      params.set("sort", sort ?? "-updated_on");

      const result = await bitbucketAllPages(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests`,
        params,
        Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
      );
      return respond(ctx.workspace, ctx.repoSlug, result, { include_details, verbose });
    },
  );

  server.tool(
    "listMyPullRequests",
    "List pull requests authored by the authenticated user across every repository in the workspace, as compact records with latest build status and review state.",
    {
      workspace: z.string().optional().describe("Bitbucket workspace (auto-detected from git remote if omitted)"),
      ...listSchema,
    },
    async ({ workspace, states, title_contains, updated_within_days, limit, include_details, verbose }) => {
      const ws = resolveWorkspace(workspace);
      const uuid = await resolveAuthorUuid(ws, "me");

      const clauses = [stateClause(states?.length ? states : ["OPEN"])];
      const title = titleClause(title_contains);
      if (title) clauses.push(title);
      const since = updatedSinceClause(updated_within_days);
      if (since) clauses.push(since);

      const params = new URLSearchParams();
      params.set("q", clauses.join(" AND "));
      params.set("sort", "-updated_on");

      const result = await bitbucketAllPages(
        `/workspaces/${ws}/pullrequests/${encodeURIComponent(uuid)}`,
        params,
        Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
      );
      return respond(ws, "", result, { include_details, verbose });
    },
  );

  server.tool(
    "getPullRequest",
    "One pull request as a compact record: metadata, description, latest build status, reviewers and review state.",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      verbose: z.boolean().optional().describe("Return the raw API object instead of the compact record"),
    },
    async ({ workspace, repo_slug, pull_request_id, verbose }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const [pr, statuses] = await Promise.all([
        bitbucketRequest<RawPullRequest>(
          `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}`,
        ),
        fetchBuildStatuses(ctx.workspace, ctx.repoSlug, pull_request_id),
      ]);

      const enriched: EnrichedPullRequest & { description?: string } = {
        ...compactPullRequest(pr),
        description: pr.description ?? pr.summary?.raw,
        build: statuses.length ? { ...statuses[0], total_statuses: statuses.length } : undefined,
        review: summarizeReview(pr),
      };

      const payload = verbose ? pr : enriched;
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.tool(
    "getPullRequestBuildStatuses",
    "List every build status reported on a pull request, newest first. Use when more than one build has run on the PR.",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
    },
    async ({ workspace, repo_slug, pull_request_id }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const statuses = await fetchBuildStatuses(ctx.workspace, ctx.repoSlug, pull_request_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(statuses, null, 2) }] };
    },
  );

  server.tool(
    "getPullRequestDiffstat",
    "Per-file change summary for a pull request: status, path, lines added and removed. Answers 'how big is it' and 'what does it touch' without the diff itself.",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      verbose: z.boolean().optional().describe("Return the raw API objects instead of the compact records"),
    },
    async ({ workspace, repo_slug, pull_request_id, verbose }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const result = await bitbucketAllPages<RawDiffstatEntry>(
        `/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests/${pull_request_id}/diffstat`,
        new URLSearchParams(),
        DIFFSTAT_LIMIT,
      );

      if (verbose) {
        return { content: [{ type: "text" as const, text: JSON.stringify(result.values, null, 2) }] };
      }

      const entries = result.values.map(compactDiffstatEntry);
      const text = `${summarizeDiffstat(entries, result.truncated)}\n${JSON.stringify(entries, null, 2)}`;
      return { content: [{ type: "text" as const, text }] };
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
      reviewers: z
        .array(z.string())
        .optional()
        .describe(
          "Reviewers as names or uuids. Names resolve exactly as findUsers does, so pass them as the user said them; a genuine tie fails with the candidates listed",
        ),
      close_source_branch: z.boolean().optional().describe("Close source branch on merge"),
    },
    async ({
      workspace,
      repo_slug,
      title,
      source_branch,
      destination_branch,
      description,
      reviewers,
      close_source_branch,
    }) => {
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
        body.reviewers = reviewerBodies(await resolveUserUuids(ctx.workspace, reviewers));
      }

      const result = await bitbucketRequest(`/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests`, {
        method: "POST",
        body,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "updatePullRequest",
    "Update a pull request: title, description, destination branch, reviewers. add_reviewers and remove_reviewers adjust the current reviewer list in one call; reviewers replaces it outright. People are names as the user said them, or uuids; names resolve exactly as findUsers does, so no lookup is needed first, and a genuine tie fails with the candidates listed.",
    {
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
      pull_request_id: z.number().describe("Pull request ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description (markdown)"),
      destination_branch: z.string().optional().describe("New destination branch"),
      reviewers: z
        .array(z.string())
        .optional()
        .describe("Replace the reviewer list with these people (names or uuids; no lookup needed first)"),
      add_reviewers: z
        .array(z.string())
        .optional()
        .describe("Add these people to the current reviewers (names or uuids; no lookup needed first)"),
      remove_reviewers: z
        .array(z.string())
        .optional()
        .describe("Remove these people from the current reviewers (names or uuids; no lookup needed first)"),
    },
    async ({
      workspace,
      repo_slug,
      pull_request_id,
      title,
      description,
      destination_branch,
      reviewers,
      add_reviewers,
      remove_reviewers,
    }) => {
      const ctx = resolveContext(workspace, repo_slug);
      const body: Record<string, unknown> = {};
      if (title) body.title = title;
      if (description) body.description = description;
      if (destination_branch) body.destination = { branch: { name: destination_branch } };
      if (reviewers) body.reviewers = reviewerBodies(await resolveUserUuids(ctx.workspace, reviewers));
      if (add_reviewers?.length || remove_reviewers?.length) {
        body.reviewers = reviewerBodies(
          await adjustedReviewers(
            ctx.workspace,
            ctx.repoSlug,
            pull_request_id,
            add_reviewers ?? [],
            remove_reviewers ?? [],
          ),
        );
      }

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

      const result = await bitbucketRequest(`/repositories/${ctx.workspace}/${ctx.repoSlug}/pullrequests`, {
        method: "POST",
        body,
      });
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
