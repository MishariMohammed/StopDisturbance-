// Pure helpers for /review: law summary keys, approval state and the send confirmation plan (04-ux §6.3, §6.5).

export type LawSummaryKey = "PDPL" | "GDPR" | "UK_GDPR" | "CAN_SPAM" | "UNKNOWN";

/** Which LawExplainer rows to show (04-ux §6.3 table). Unknown jurisdiction shows the fallback row only. */
export function lawSummaryKeys(lawKeys: readonly string[], fallback: boolean): LawSummaryKey[] {
  if (fallback || lawKeys.length === 0) return ["UNKNOWN"];
  const order: LawSummaryKey[] = ["PDPL", "GDPR", "UK_GDPR", "CAN_SPAM"];
  const keys = order.filter((k) => lawKeys.includes(k));
  return keys.length ? keys : ["UNKNOWN"];
}

export type ReviewChannel = "EMAIL" | "ONE_CLICK" | "MAILTO" | "WEB_FORM";

export function channelOf(kind: string): ReviewChannel {
  if (kind === "ONE_CLICK_POST") return "ONE_CLICK";
  if (kind === "UNSUB_MAILTO") return "MAILTO";
  if (kind === "WEB_FORM_COPY") return "WEB_FORM";
  return "EMAIL";
}

export interface PlanItem {
  outboundId: string;
  kind: string;
  status: string;
  approved: boolean;
  companyName: string;
  to: string | null;
  mailbox: string;
  /** Follow-ups (reminder, ID reply) keep the request status; approval lives on the message. */
  followUp?: boolean;
}

export interface SendPlan<T extends PlanItem> {
  /** Approved, sendable items (the count in the button label). */
  send: T[];
  /** Grouped by sending mailbox, in first-seen order. */
  byMailbox: { mailbox: string; items: T[] }[];
  /** Web forms still to be submitted by the owner (never sent by us). */
  webForms: T[];
}

/** Approval holds only while the approved hash equals the current draft hash (03-legal M4). */
export function isApproved(o: { approvedHash: string | null; draftHash: string }, status: string, followUp = false): boolean {
  const hashOk = o.approvedHash !== null && o.approvedHash === o.draftHash;
  return followUp ? hashOk : (status === "APPROVED" || status === "QUEUED") && hashOk;
}

export function planSend<T extends PlanItem>(items: readonly T[]): SendPlan<T> {
  const send = items.filter((i) => i.approved && (i.followUp || i.status === "APPROVED") && i.kind !== "WEB_FORM_COPY");
  const webForms = items.filter((i) => i.kind === "WEB_FORM_COPY" && (i.status === "DRAFT" || i.status === "APPROVED"));
  const groups = new Map<string, T[]>();
  for (const i of send) groups.set(i.mailbox, [...(groups.get(i.mailbox) ?? []), i]);
  return { send, webForms, byMailbox: [...groups].map(([mailbox, list]) => ({ mailbox, items: list })) };
}

/** Seconds left in the undo window, never negative. */
export function secondsLeft(sendAfter: Date | string | null, now: number): number {
  if (!sendAfter) return 0;
  const t = typeof sendAfter === "string" ? Date.parse(sendAfter) : sendAfter.getTime();
  return Math.max(0, Math.ceil((t - now) / 1000));
}
