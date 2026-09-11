import { bitbucketAllPages, bitbucketRequest } from "./client.js";
import { RawDiffstatEntry, compactDiffstatEntry } from "./diffstat-format.js";

export type AlignmentBasis = "author_commits" | "pull_request_diffstat";

export interface CommitTouch {
  hash: string;
  author: string;
  is_pr_author: boolean;
}

export interface PullRequestChanges {
  author: string;
  changed_files: number;
  authored_files: string[];
  alignment_basis: AlignmentBasis;
  commits_scanned: number;
  touchedBy(path: string): CommitTouch[];
}

interface RawUser {
  uuid?: string;
  display_name?: string;
}

interface RawCommit {
  hash: string;
  parents?: { hash: string }[];
  author?: { raw?: string; user?: RawUser };
}

const COMMIT_LIMIT = 50;
const DIFFSTAT_LIMIT = 500;
const CONCURRENCY = 6;

/**
 * The files a PR's own commits changed, attributed to their authors, so a failing test can be
 * matched against what the PR author wrote rather than everything the branch inherited.
 * Falls back to the PR diffstat when the PR has more commits than can be scanned.
 */
export async function fetchPullRequestChanges(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
): Promise<PullRequestChanges> {
  const base = `/repositories/${workspace}/${repoSlug}/pullrequests/${pullRequestId}`;
  const [pr, commits, diffstat] = await Promise.all([
    bitbucketRequest<{ author?: RawUser }>(`${base}?fields=author.uuid,author.display_name`),
    bitbucketAllPages<RawCommit>(`${base}/commits`, new URLSearchParams(), COMMIT_LIMIT),
    changedPaths(`${base}/diffstat`),
  ]);

  const author = pr.author?.display_name ?? "unknown";
  const ownCommits = commits.values.filter((commit) => !isMerge(commit));

  if (commits.truncated) {
    return {
      author,
      changed_files: diffstat.length,
      authored_files: diffstat,
      alignment_basis: "pull_request_diffstat",
      commits_scanned: 0,
      touchedBy: () => [],
    };
  }

  const touches = await commitTouches(workspace, repoSlug, ownCommits, pr.author?.uuid);
  return {
    author,
    changed_files: diffstat.length,
    authored_files: authoredFiles(touches),
    alignment_basis: "author_commits",
    commits_scanned: ownCommits.length,
    touchedBy: (path) => touches.get(path) ?? [],
  };
}

function isMerge(commit: RawCommit): boolean {
  return (commit.parents?.length ?? 0) > 1;
}

async function commitTouches(
  workspace: string,
  repoSlug: string,
  commits: RawCommit[],
  prAuthorUuid: string | undefined,
): Promise<Map<string, CommitTouch[]>> {
  const touches = new Map<string, CommitTouch[]>();
  const diffstats = await mapConcurrently(commits, (commit) =>
    changedPaths(`/repositories/${workspace}/${repoSlug}/diffstat/${commit.hash}`),
  );

  commits.forEach((commit, index) => {
    const touch = describeTouch(commit, prAuthorUuid);
    for (const path of diffstats[index]) {
      touches.set(path, [...(touches.get(path) ?? []), touch]);
    }
  });
  return touches;
}

function describeTouch(commit: RawCommit, prAuthorUuid: string | undefined): CommitTouch {
  const user = commit.author?.user;
  return {
    hash: commit.hash.slice(0, 10),
    author: user?.display_name ?? commit.author?.raw ?? "unknown",
    is_pr_author: Boolean(prAuthorUuid) && user?.uuid === prAuthorUuid,
  };
}

function authoredFiles(touches: Map<string, CommitTouch[]>): string[] {
  return [...touches.entries()]
    .filter(([, commits]) => commits.some((commit) => commit.is_pr_author))
    .map(([path]) => path);
}

async function changedPaths(path: string): Promise<string[]> {
  const result = await bitbucketAllPages<RawDiffstatEntry>(path, new URLSearchParams(), DIFFSTAT_LIMIT);
  return result.values.map(compactDiffstatEntry).map((entry) => entry.path);
}

async function mapConcurrently<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}
