export interface RawDiffstatEntry {
  status?: string;
  lines_added?: number;
  lines_removed?: number;
  old?: { path?: string } | null;
  new?: { path?: string } | null;
}

export interface CompactDiffstatEntry {
  status: string;
  path: string;
  from?: string;
  added: number;
  removed: number;
}

export function compactDiffstatEntry(entry: RawDiffstatEntry): CompactDiffstatEntry {
  const newPath = entry.new?.path;
  const oldPath = entry.old?.path;
  const renamed = entry.status === "renamed" && oldPath && newPath && oldPath !== newPath;
  return {
    status: entry.status ?? "unknown",
    path: newPath ?? oldPath ?? "",
    from: renamed ? oldPath : undefined,
    added: entry.lines_added ?? 0,
    removed: entry.lines_removed ?? 0,
  };
}

export function summarizeDiffstat(entries: CompactDiffstatEntry[], truncated: boolean): string {
  const added = entries.reduce((sum, e) => sum + e.added, 0);
  const removed = entries.reduce((sum, e) => sum + e.removed, 0);
  const files = entries.length === 1 ? "1 file changed" : `${entries.length} files changed`;
  const more = truncated ? " (more files not shown)" : "";
  return `${files}, +${added} / -${removed}${more}`;
}
