// Pure view helpers for /tracker (04-ux §7.1, §7.2). Safe in client components.

export const STATUSES = [
  "DRAFT", "APPROVED", "QUEUED", "SENT", "ACKNOWLEDGED", "NEEDS_ACTION", "COMPLETED", "REFUSED", "OVERDUE", "ESCALATED", "FAILED", "CANCELLED",
] as const;
export type Status = (typeof STATUSES)[number];

export type Tone = "neutral" | "info" | "warning" | "success" | "danger" | "escalated";

/** Icon + colour token per canonical status. The label always comes from messages (never colour alone). */
export const STATUS_META: Record<Status, { icon: string; tone: Tone }> = {
  DRAFT: { icon: "✎", tone: "neutral" },
  APPROVED: { icon: "☑", tone: "neutral" },
  QUEUED: { icon: "⧗", tone: "info" },
  SENT: { icon: "✉", tone: "info" },
  ACKNOWLEDGED: { icon: "✓◌", tone: "info" },
  NEEDS_ACTION: { icon: "⚠", tone: "warning" },
  COMPLETED: { icon: "✓", tone: "success" },
  REFUSED: { icon: "✕", tone: "danger" },
  OVERDUE: { icon: "⏰", tone: "danger" },
  ESCALATED: { icon: "⚑", tone: "escalated" },
  FAILED: { icon: "!", tone: "danger" },
  CANCELLED: { icon: "—", tone: "neutral" },
};

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-border-strong bg-surface-2 text-text",
  info: "border-info bg-info-bg text-info",
  warning: "border-warning bg-warning-bg text-warning",
  // Success text on its tint is just under 4.5:1 at text-sm, so the label uses the body colour.
  success: "border-success bg-success-bg text-text",
  danger: "border-danger bg-danger-bg text-danger",
  escalated: "border-escalated bg-escalated-bg text-escalated",
};

export function statusMeta(status: string) {
  return STATUS_META[(STATUSES as readonly string[]).includes(status) ? (status as Status) : "DRAFT"];
}

/** Summary tabs (04-ux §3.5) ↔ TrackerRow.group from lib/track. */
export const BUCKETS = ["needs", "overdue", "escalated", "waiting", "completed", "closed"] as const;
export type Bucket = (typeof BUCKETS)[number];
const GROUP_TAB: Record<string, Bucket> = {
  NEEDS_YOU: "needs",
  OVERDUE: "overdue",
  ESCALATED: "escalated",
  WAITING: "waiting",
  COMPLETED: "completed",
  CLOSED: "closed",
};

export function bucketOf(group: string): Bucket {
  return GROUP_TAB[group] ?? "waiting";
}

const DAY = 24 * 3600 * 1000;

export interface DeadlineView {
  /** Whole days until the deadline (ceil); negative when past due. */
  days: number;
  overdue: boolean;
  tone: "info" | "warning" | "danger";
  /** 0–1 share of the period elapsed, for the bar (fills from the start side). */
  elapsed: number;
}

/** Text-first countdown (04-ux §7.2): >7 days info, ≤7 warning, past due danger. */
export function deadlineView(dueAt: Date | string, now: Date | number, clockStart?: Date | string | null): DeadlineView {
  const due = new Date(dueAt).getTime();
  const t = typeof now === "number" ? now : now.getTime();
  const diff = due - t;
  const overdue = diff < 0;
  const days = overdue ? -Math.ceil(-diff / DAY) : Math.ceil(diff / DAY);
  const tone = overdue ? "danger" : days <= 7 ? "warning" : "info";
  let elapsed = overdue ? 1 : 0;
  if (!overdue && clockStart) {
    const start = new Date(clockStart).getTime();
    elapsed = due > start ? Math.min(1, Math.max(0, (t - start) / (due - start))) : 1;
  }
  return { days, overdue, tone, elapsed };
}

/** Parses the tracker's URL filters (bucket tab, search, sort). */
export function parseTrackerFilters(sp: Record<string, string | string[] | undefined>) {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const tab = one("tab");
  const sort = one("sort");
  return {
    tab: (BUCKETS as readonly string[]).includes(tab) ? (tab as Bucket) : ("all" as const),
    q: one("q").trim().slice(0, 100),
    sort: sort === "company" || sort === "recent" ? sort : ("deadline" as const),
  };
}
export type TrackerFilters = ReturnType<typeof parseTrackerFilters>;
