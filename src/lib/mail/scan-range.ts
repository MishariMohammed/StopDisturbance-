// ScanRangeSelector (04-ux §3.2): 1 year / 3 years (default) / Everything. Changing it restarts that
// mailbox's scan; headers already stored are kept (MessageHeader is unique per accountId+providerMsgId).

export const SCAN_RANGES = ["1y", "3y", "all"] as const;
export type ScanRange = (typeof SCAN_RANGES)[number];
export const DEFAULT_SCAN_RANGE: ScanRange = "3y";

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
/** "Everything": a fixed far-past date. Gmail omits `newer_than` for it; Graph filters from 1970. */
export const SCAN_EVERYTHING_FROM = new Date("1970-01-01T00:00:00Z");

export function scanFromFor(range: ScanRange, now = new Date()): Date {
  if (range === "all") return SCAN_EVERYTHING_FROM;
  return new Date(now.getTime() - (range === "1y" ? 1 : 3) * YEAR_MS);
}

/** True when `scanFrom` means "Everything" (on or before 1990, far older than any mailbox we scan). */
export function isEverything(scanFrom: Date): boolean {
  return scanFrom.getTime() <= Date.UTC(1990, 0, 1);
}

/** The selector option for a stored scanFrom (nearest of 1y / 3y; Everything when far past). */
export function rangeOf(scanFrom: Date, now = new Date()): ScanRange {
  if (isEverything(scanFrom)) return "all";
  return (now.getTime() - scanFrom.getTime()) / YEAR_MS < 2 ? "1y" : "3y";
}
