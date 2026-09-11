import { bitbucketRequest, PaginatedResponse } from "./client.js";
import { CompactPullRequest, RawPullRequest, RawParticipant, toLocalTime } from "./pull-request-format.js";

export interface BuildStatus {
  state: string;
  name?: string;
  url?: string;
  updated_on?: string;
  updated_local?: string;
  commit?: string;
}

export interface ReviewSummary {
  reviewers: string[];
  approved_by: string[];
  changes_requested_by: string[];
  pending: string[];
}

export interface EnrichedPullRequest extends CompactPullRequest {
  build?: BuildStatus & { total_statuses: number };
  review?: ReviewSummary;
}

interface RawCommitStatus {
  state: string;
  name?: string;
  url?: string;
  updated_on?: string;
  links?: { commit?: { href?: string } };
}

export function compactBuildStatus(status: RawCommitStatus): BuildStatus {
  return {
    state: status.state,
    name: status.name,
    url: status.url,
    updated_on: status.updated_on,
    updated_local: toLocalTime(status.updated_on),
    commit: status.links?.commit?.href?.split("/").pop(),
  };
}

export async function fetchBuildStatuses(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
): Promise<BuildStatus[]> {
  const page = await bitbucketRequest<PaginatedResponse<RawCommitStatus>>(
    `/repositories/${workspace}/${repoSlug}/pullrequests/${pullRequestId}/statuses?pagelen=50`,
  );
  return page.values
    .map(compactBuildStatus)
    .sort((a, b) => (b.updated_on ?? "").localeCompare(a.updated_on ?? ""));
}

export function summarizeReview(pr: RawPullRequest): ReviewSummary {
  const participants: RawParticipant[] = pr.participants ?? [];
  const name = (p: RawParticipant) => p.user?.display_name ?? "unknown";
  const reviewers = participants.filter((p) => p.role === "REVIEWER");

  return {
    reviewers: reviewers.map(name),
    approved_by: participants.filter((p) => p.approved).map(name),
    changes_requested_by: participants.filter((p) => p.state === "changes_requested").map(name),
    pending: reviewers.filter((p) => !p.approved && p.state !== "changes_requested").map(name),
  };
}

export async function enrichPullRequest(
  workspace: string,
  repoSlug: string,
  compact: CompactPullRequest,
): Promise<EnrichedPullRequest> {
  const [detail, statuses] = await Promise.all([
    bitbucketRequest<RawPullRequest>(`/repositories/${workspace}/${repoSlug}/pullrequests/${compact.id}`),
    fetchBuildStatuses(workspace, repoSlug, compact.id),
  ]);

  return {
    ...compact,
    build: statuses.length ? { ...statuses[0], total_statuses: statuses.length } : undefined,
    review: summarizeReview(detail),
  };
}

export async function enrichAll(
  workspace: string,
  prs: CompactPullRequest[],
  repoSlugOf: (pr: CompactPullRequest) => string,
  concurrency = 8,
): Promise<EnrichedPullRequest[]> {
  const results: EnrichedPullRequest[] = new Array(prs.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < prs.length) {
      const index = next++;
      results[index] = await enrichPullRequest(workspace, repoSlugOf(prs[index]), prs[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, prs.length) }, worker));
  return results;
}
