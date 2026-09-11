import { toLocalTime } from "./pull-request-format.js";

export interface RawComment {
  id: number;
  deleted?: boolean;
  created_on?: string;
  user?: { display_name?: string; nickname?: string };
  content?: { raw?: string };
  inline?: { path: string; to?: number; from?: number };
  parent?: { id: number };
}

export interface CompactComment {
  id: number;
  author: string;
  created_local?: string;
  body: string;
  inline?: { path: string; line?: number };
  reply_to?: number;
}

export function compactComments(comments: RawComment[]): CompactComment[] {
  return comments
    .filter((c) => !c.deleted)
    .sort((a, b) => (a.created_on ?? "").localeCompare(b.created_on ?? ""))
    .map((c) => ({
      id: c.id,
      author: c.user?.display_name ?? c.user?.nickname ?? "unknown",
      created_local: toLocalTime(c.created_on),
      body: c.content?.raw ?? "",
      inline: c.inline ? { path: c.inline.path, line: c.inline.to ?? c.inline.from } : undefined,
      reply_to: c.parent?.id,
    }));
}
