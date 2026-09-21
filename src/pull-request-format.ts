export interface RawParticipant {
  user?: { display_name?: string };
  role?: string;
  approved?: boolean;
  state?: string | null;
}

export interface RawPullRequest {
  id: number;
  title: string;
  state: string;
  draft?: boolean;
  author?: { display_name?: string; nickname?: string; uuid?: string };
  source?: { branch?: { name?: string }; repository?: { full_name?: string } };
  destination?: { branch?: { name?: string }; repository?: { full_name?: string } };
  created_on?: string;
  updated_on?: string;
  comment_count?: number;
  task_count?: number;
  reviewers?: Array<{ display_name?: string }>;
  participants?: RawParticipant[];
  links?: { html?: { href?: string } };
  summary?: { raw?: string };
  description?: string;
}

export interface CompactPullRequest {
  id: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  repo?: string;
  source_branch?: string;
  destination_branch?: string;
  created_local?: string;
  updated_local?: string;
  comment_count?: number;
  task_count?: number;
  url?: string;
}

const localFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

export function toLocalTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const parts = localFormatter.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

export function compactPullRequest(pr: RawPullRequest): CompactPullRequest {
  return {
    id: pr.id,
    title: pr.title,
    state: pr.state,
    draft: Boolean(pr.draft),
    author: pr.author?.display_name ?? pr.author?.nickname ?? "unknown",
    repo: pr.destination?.repository?.full_name,
    source_branch: pr.source?.branch?.name,
    destination_branch: pr.destination?.branch?.name,
    created_local: toLocalTime(pr.created_on),
    updated_local: toLocalTime(pr.updated_on),
    comment_count: pr.comment_count,
    task_count: pr.task_count,
    url: pr.links?.html?.href,
  };
}

export function repoSlugFromFullName(fullName: string | undefined, fallback: string): string {
  return fullName?.split("/")[1] ?? fallback;
}

export function summarizeList(
  count: number,
  total: number | undefined,
  truncated: boolean,
  detailsFetched: boolean,
): string {
  const parts = [`${count} pull request${count === 1 ? "" : "s"} returned`];
  if (total !== undefined) parts.push(`of ${total} matching`);
  if (truncated) parts.push("(more available; raise limit)");
  parts.push(
    detailsFetched ? "with build and review details" : "without build/review details (pass include_details: true)",
  );
  return parts.join(" ");
}
