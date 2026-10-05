import type { Prisma, Request, RequestStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { computeDeadlines } from "@/lib/deadlines";

// Shared request-state helpers for the dispatcher, the reply poller, the deadline tick and owner actions.

/** Requests we still watch for replies and deadlines. */
export const TRACKED_STATUSES: RequestStatus[] = ["SENT", "ACKNOWLEDGED", "NEEDS_ACTION", "OVERDUE", "ESCALATED"];
/** Statuses after which nothing is sent or tracked any more. */
export const CLOSED_STATUSES: RequestStatus[] = ["COMPLETED", "REFUSED", "CANCELLED", "FAILED"];
/** OutboundMessage kinds that are emails from the owner's mailbox (count toward cap and spacing). */
export const EMAIL_KINDS = ["INITIAL", "REMINDER", "ID_REPLY", "UNSUB_MAILTO"] as const;
/** Follow-up kinds created after the first send (approved and queued here, not in drafts.ts). */
export const FOLLOW_UP_KINDS = ["REMINDER", "ID_REPLY"] as const;
/** Request types that only unsubscribe (auto-complete after 10 quiet business days). */
export const UNSUB_ONLY_TYPES = ["ONE_CLICK", "MAILTO_UNSUB"] as const;

export const isFollowUp = (kind: string) => (FOLLOW_UP_KINDS as readonly string[]).includes(kind);

export class TrackError extends Error {
  constructor(
    public code:
      | "not_found" | "bad_status" | "already_sent" | "not_queued" | "limit_reached" | "too_early" | "not_supported"
      | "not_approved" | "bad_date" | "no_mailbox",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TrackError";
  }
}

type Tx = Prisma.TransactionClient;

export async function logEvent(
  tx: Tx,
  requestId: string,
  type: string,
  actor: "OWNER" | "SYSTEM",
  data: Record<string, unknown>,
  at = new Date(),
) {
  const json = data as Prisma.InputJsonValue;
  await tx.requestEvent.create({ data: { requestId, type, actor, at, data: json } });
  await tx.auditLog.create({ data: { action: `request.${type.toLowerCase()}`, entity: "request", entityId: requestId, at, data: json } });
}

/** The latest extension notice date the owner recorded (RequestEvent EXTENSION_RECORDED). */
export async function extensionNoticeAt(requestId: string, tx: Tx = db): Promise<Date | null> {
  const ev = await tx.requestEvent.findFirst({ where: { requestId, type: "EXTENSION_RECORDED" }, orderBy: { at: "desc" } });
  const v = (ev?.data as { noticeDate?: string } | null)?.noticeDate;
  return v ? new Date(v) : null;
}

/** Deadline columns for a request from its clock start (00-brief §5 deadline maths). */
export function deadlineColumns(
  req: Pick<Request, "lawKeys">,
  clockStart: Date,
  opts: { extensionNoticeAt?: Date | null; reminderSentAt?: Date | null } = {},
) {
  const d = computeDeadlines({
    clockStart,
    lawKeys: req.lawKeys,
    extensionNoticeAt: opts.extensionNoticeAt ?? null,
    reminderSentAt: opts.reminderSentAt ?? null,
  });
  return {
    clockStart,
    dueAt: d.dueAt,
    latestDueAt: d.latestDueAt,
    extendedDueAt: d.extendedDueAt,
    reminderOfferedAt: d.reminderOfferedAt,
    escalationOpenAt: d.escalationOpenAt,
    complaintWindowEndsAt: d.complaintWindowEndsAt,
  } satisfies Prisma.RequestUpdateInput;
}

/** The request's first sent email (the thread follow-ups answer). */
export async function initialSent(requestId: string, tx: Tx = db) {
  return tx.outboundMessage.findFirst({
    where: { requestId, sentAt: { not: null }, kind: { in: ["INITIAL", "UNSUB_MAILTO"] } },
    orderBy: { sentAt: "asc" },
  });
}

/** Registrable domains that belong to a company (primary + CompanyDomain rows). */
export async function companyDomains(companyId: string, tx: Tx = db): Promise<string[]> {
  const c = await tx.company.findUnique({ where: { id: companyId }, select: { primaryDomain: true } });
  const extra = await tx.companyDomain.findMany({ where: { companyId }, select: { domain: true } });
  return [...new Set([c?.primaryDomain, ...extra.map((d) => d.domain)].filter((d): d is string => Boolean(d)))];
}
