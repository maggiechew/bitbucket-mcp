const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A span of milliseconds as people say it: `8h 08m`, `71m`, `45s`. Negative and non-finite spans read as `0s`.
 * @param ms the span in milliseconds
 * @return the formatted span
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (ms >= MINUTE_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  return `${Math.floor(ms / 1000)}s`;
}

/** Minutes between a past instant and now, rounded. */
export function minutesSince(epochMs: number, now = Date.now()): number {
  return Math.round((now - epochMs) / MINUTE_MS);
}
