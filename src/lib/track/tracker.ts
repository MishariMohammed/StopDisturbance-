import type { InboundReply, OutboundMessage, Request, RequestStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { replyRaw } from "@/lib/evidence/crypto";
import { simpleParser } from "mailparser";
import { hasSendScope } from "@/lib/send/mailbox";
import { isFollowUp, TrackError, TRACKED_STATUSES } from "@/lib/track/state";

// /tracker data (04-ux §3.5, §7): one row per request with exactly one primary next action.

export type TrackerGroup = "NEEDS_YOU" | "WAITING" | "OVERDUE" | "ESCALATED" | "COMPLETED" | "CLOSED";

export type NextActionKind =
  | "REVIEW_DRAFT" //        DRAFT, or a follow-up draft waiting for approval → open /review (outboundId)
  | "SEND" //                APPROVED (first letter or follow-up) → send confirmation (outboundId)
  | "CANCEL" //              QUEUED → cancel until sent (outboundId)
  | "SUBMIT_WEB_FORM" //     web form not yet submitted → open form + "I submitted it" (url)
  | "GRANT_SEND_PERMISSION" // mailbox lacks the send scope → incremental consent (accountId)
  | "RECONNECT_MAILBOX" //   mailbox needs reconnect (accountId)
  | "CONFIRM_REPLY" //       a reply waits for the owner's confirmation (replyId)
  | "REPLY_WITH_DETAILS" //  NEEDS_ACTION: identity / clarification → template 6e
  | "SEND_REMINDER" //       OVERDUE, no reminder yet; availableAt = dueAt + 3 days
  | "ESCALATE" //            OVERDUE after the reminder window, or REFUSED → EscalationWizard
  | "ADD_COMPLAINT_REF" //   ESCALATED without a reference
  | "FIX_ADDRESS" //         FAILED (send error or bounce) → back to Draft
  | "VIEW_REPLY" //          COMPLETED with a confirming reply (replyId)
  | "NONE"; //               waiting; "we'll tell you when they reply"

export interface NextAction {
  kind: NextActionKind;
  outboundId?: string;
  replyId?: string;
  accountId?: string;
  url?: string;
  /** For SEND_REMINDER / ESCALATE: the action is shown from this instant. */
  availableAt?: Date | null;
}

export interface TrackerRow {
  requestId: string;
  reference: string;
  companyId: string;
  companyName: string;
  companyDomain: string;
  type: Request["type"];
  status: RequestStatus;
  group: TrackerGroup;
  needsActionReason: string | null;
  mailbox: string | null;
  lawKeys: string[];
  clockStart: Date | null;
  dueAt: Date | null;
  latestDueAt: Date | null;
  extendedDueAt: Date | null;
  /** Whole days until dueAt (negative = days overdue); null before sending. */
  daysLeft: number | null;
  extensionClaimed: boolean;
  stillEmailing: boolean;
  bounced: boolean;
  lastReplyAt: Date | null;
  lastReplyClass: string | null;
  unconfirmedReplies: number;
  closedAt: Date | null;
  updatedAt: Date;
  nextAction: NextAction;
}

export interface TrackerOutbound {
  id: string;
  kind: string;
  templateId: string;
  language: string;
  toAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  state: "DRAFT" | "APPROVED" | "QUEUED" | "SENT" | "FAILED";
  approvedAt: Date | null;
  sendAfter: Date | null;
  sentAt: Date | null;
  internetMessageId: string | null;
  httpStatus: number | null;
  error: string | null;
}

export interface TrackerReply {
  id: string;
  receivedAt: Date;
  fromAddress: string;
  subject: string;
  /** First 300 characters of the reply text ("" when no body was fetched, e.g. probable matches). */
  preview: string;
  matchMethod: string;
  probable: boolean;
  suggestedClass: string | null;
  ownerConfirmed: boolean | null;
}

export interface TrackerEvent {
  id: string;
  at: Date;
  type: string;
  actor: string;
  data: unknown;
}

export interface TrackerDetail extends TrackerRow {
  citationsText: string;
  lowConfidenceWording: boolean;
  reminderOfferedAt: Date | null;
  reminderSentAt: Date | null;
  escalationOpenAt: Date | null;
  complaintWindowEndsAt: Date | null;
  complaintRef: string | null;
  webFormUrl: string | null;
  canSendReminder: boolean;
  canEscalate: boolean;
  evidenceCount: number;
  outbound: TrackerOutbound[];
  replies: TrackerReply[];
  timeline: TrackerEvent[];
}

const DAY = 86_400_000;

function outState(o: OutboundMessage, request: Request): TrackerOutbound["state"] {
  if (o.sentAt) return "SENT";
  if (o.error && !o.sendAfter) return "FAILED";
  if (isFollowUp(o.kind)) return o.sendAfter ? "QUEUED" : o.approvedHash ? "APPROVED" : "DRAFT";
  if (request.status === "QUEUED") return "QUEUED";
  if (request.status === "FAILED") return "FAILED";
  return o.approvedHash ? "APPROVED" : "DRAFT";
}

function groupOf(status: RequestStatus, nextAction: NextAction): TrackerGroup {
  if (status === "OVERDUE") return "OVERDUE";
  if (status === "ESCALATED") return "ESCALATED";
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "CANCELLED") return "CLOSED";
  if (["NONE", "CANCEL"].includes(nextAction.kind) && ["QUEUED", "SENT", "ACKNOWLEDGED"].includes(status)) return "WAITING";
  return "NEEDS_YOU";
}

interface RowInput {
  request: Request;
  outs: OutboundMessage[];
  replies: Pick<InboundReply, "id" | "receivedAt" | "suggestedClass" | "ownerConfirmed">[];
  account: { id: string; status: string; provider: "GOOGLE" | "MICROSOFT"; grantedScopes: string[] } | null;
  now: Date;
}

/** One primary next action per request (04-ux §7.1 table + §7.4). */
export function nextActionFor({ request, outs, replies, account, now }: RowInput): NextAction {
  const s = request.status;
  const main = outs.find((o) => !isFollowUp(o.kind)) ?? outs[0];
  const pendingFollow = outs.find((o) => isFollowUp(o.kind) && !o.sentAt && !(o.error && !o.sendAfter));
  const unconfirmed = replies.filter((r) => r.ownerConfirmed === null).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];
  const webForm = outs.find((o) => o.kind === "WEB_FORM_COPY");

  if (s === "DRAFT") {
    return request.type === "WEB_FORM" && webForm
      ? { kind: "SUBMIT_WEB_FORM", outboundId: webForm.id, url: webForm.toAddress ?? undefined }
      : { kind: "REVIEW_DRAFT", outboundId: main?.id };
  }
  if (s === "APPROVED") {
    return request.type === "WEB_FORM" && webForm
      ? { kind: "SUBMIT_WEB_FORM", outboundId: webForm.id, url: webForm.toAddress ?? undefined }
      : { kind: "SEND", outboundId: main?.id };
  }
  if (s === "QUEUED") return { kind: "CANCEL", outboundId: main?.id };
  if (s === "FAILED") return { kind: "FIX_ADDRESS", outboundId: main?.id };
  if (s === "CANCELLED") return { kind: "NONE" };
  if (s === "COMPLETED") {
    const done = replies.filter((r) => r.ownerConfirmed && r.suggestedClass === "COMPLETED").at(-1);
    return done ? { kind: "VIEW_REPLY", replyId: done.id } : { kind: "NONE" };
  }
  if (s === "NEEDS_ACTION" && request.needsActionReason === "SEND_PERMISSION") {
    return { kind: "GRANT_SEND_PERMISSION", accountId: request.mailAccountId, outboundId: main?.id };
  }
  if (TRACKED_STATUSES.includes(s) && account && account.status !== "ACTIVE") {
    return { kind: "RECONNECT_MAILBOX", accountId: account.id };
  }
  if (unconfirmed && s !== "ESCALATED") return { kind: "CONFIRM_REPLY", replyId: unconfirmed.id };
  if (pendingFollow) {
    if (pendingFollow.sendAfter) return { kind: "CANCEL", outboundId: pendingFollow.id };
    if (pendingFollow.approvedHash) return { kind: "SEND", outboundId: pendingFollow.id };
    return { kind: "REVIEW_DRAFT", outboundId: pendingFollow.id };
  }
  if (s === "NEEDS_ACTION") {
    if (request.needsActionReason === "WEB_FORM") return { kind: "SUBMIT_WEB_FORM", url: webForm?.toAddress ?? undefined };
    if (account && !hasSendScope(account)) return { kind: "GRANT_SEND_PERMISSION", accountId: account.id };
    return { kind: "REPLY_WITH_DETAILS" };
  }
  if (s === "OVERDUE") {
    const letter = outs.some((o) => o.kind === "INITIAL" && o.sentAt);
    if (letter && !request.reminderSentAt) return { kind: "SEND_REMINDER", availableAt: request.reminderOfferedAt };
    if (request.escalationOpenAt && request.escalationOpenAt > now) return { kind: "NONE", availableAt: request.escalationOpenAt };
    return { kind: "ESCALATE", availableAt: request.escalationOpenAt };
  }
  if (s === "REFUSED") return { kind: "ESCALATE" };
  if (s === "ESCALATED") return request.complaintRef ? { kind: "NONE" } : { kind: "ADD_COMPLAINT_REF" };
  return { kind: "NONE" };
}

async function buildRows(requests: Request[], now: Date): Promise<{ rows: TrackerRow[]; outs: OutboundMessage[]; replies: InboundReply[] }> {
  if (!requests.length) return { rows: [], outs: [], replies: [] };
  const ids = requests.map((r) => r.id);
  const [outs, replies, companies, accounts] = await Promise.all([
    db.outboundMessage.findMany({ where: { requestId: { in: ids } }, orderBy: { createdAt: "asc" } }),
    db.inboundReply.findMany({ where: { requestId: { in: ids } }, orderBy: { receivedAt: "asc" } }),
    db.company.findMany({ where: { id: { in: [...new Set(requests.map((r) => r.companyId))] } }, select: { id: true, name: true, primaryDomain: true } }),
    db.mailAccount.findMany({
      where: { id: { in: [...new Set(requests.map((r) => r.mailAccountId))] } },
      select: { id: true, address: true, status: true, provider: true, grantedScopes: true },
    }),
  ]);
  const company = new Map(companies.map((c) => [c.id, c]));
  const account = new Map(accounts.map((a) => [a.id, a]));
  const rows = requests.map((request): TrackerRow => {
    const o = outs.filter((x) => x.requestId === request.id);
    const rp = replies.filter((x) => x.requestId === request.id && x.suggestedClass !== "BOUNCE");
    const acc = account.get(request.mailAccountId) ?? null;
    const nextAction = nextActionFor({ request, outs: o, replies: rp, account: acc, now });
    const last = rp.at(-1);
    const c = company.get(request.companyId);
    return {
      requestId: request.id,
      reference: request.reference,
      companyId: request.companyId,
      companyName: c?.name ?? "",
      companyDomain: c?.primaryDomain ?? "",
      type: request.type,
      status: request.status,
      group: groupOf(request.status, nextAction),
      needsActionReason: request.needsActionReason,
      mailbox: acc?.address ?? null,
      lawKeys: request.lawKeys,
      clockStart: request.clockStart,
      dueAt: request.dueAt,
      latestDueAt: request.latestDueAt,
      extendedDueAt: request.extendedDueAt,
      daysLeft: request.dueAt ? Math.ceil((request.dueAt.getTime() - now.getTime()) / DAY) : null,
      extensionClaimed: request.extensionClaimed,
      stillEmailing: request.stillEmailing,
      bounced: request.bounced,
      lastReplyAt: last?.receivedAt ?? null,
      lastReplyClass: last?.suggestedClass ?? null,
      unconfirmedReplies: rp.filter((x) => x.ownerConfirmed === null).length,
      closedAt: request.closedAt,
      updatedAt: request.updatedAt,
      nextAction,
    };
  });
  return { rows, outs, replies };
}

const GROUP_ORDER: TrackerGroup[] = ["NEEDS_YOU", "OVERDUE", "ESCALATED", "WAITING", "COMPLETED", "CLOSED"];

/**
 * Tracker rows. Default: everything from QUEUED on (drafts live on /review); pass `status` to choose.
 * Sorted by group (needs you first), then by deadline.
 */
export async function trackerRows(filter?: { status?: string[] }, now = new Date()): Promise<TrackerRow[]> {
  const statuses = (filter?.status?.length ? filter.status : null) as RequestStatus[] | null;
  const requests = await db.request.findMany({
    where: statuses ? { status: { in: statuses } } : { status: { notIn: ["DRAFT", "APPROVED"] } },
  });
  const { rows } = await buildRows(requests, now);
  const far = Number.MAX_SAFE_INTEGER;
  return rows.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      (a.dueAt?.getTime() ?? far) - (b.dueAt?.getTime() ?? far) ||
      a.companyName.localeCompare(b.companyName),
  );
}

async function preview(r: InboundReply): Promise<string> {
  const raw = replyRaw(r.bodyCipher);
  if (!raw?.length) return "";
  try {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true });
    return (parsed.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}

export async function trackerDetail(requestId: string, now = new Date()): Promise<TrackerDetail> {
  const request = await db.request.findUnique({ where: { id: requestId } });
  if (!request) throw new TrackError("not_found");
  const { rows, outs, replies } = await buildRows([request], now);
  const row = rows[0];
  const [events, evidenceCount] = await Promise.all([
    db.requestEvent.findMany({ where: { requestId }, orderBy: { at: "asc" } }),
    db.evidenceHeader.count({ where: { requestId } }),
  ]);
  const webForm = outs.find((o) => o.kind === "WEB_FORM_COPY");
  const letterSent = outs.some((o) => o.kind === "INITIAL" && o.sentAt);
  return {
    ...row,
    citationsText: request.citationsText,
    lowConfidenceWording: request.lowConfidenceWording,
    reminderOfferedAt: request.reminderOfferedAt,
    reminderSentAt: request.reminderSentAt,
    escalationOpenAt: request.escalationOpenAt,
    complaintWindowEndsAt: request.complaintWindowEndsAt,
    complaintRef: request.complaintRef,
    webFormUrl: webForm?.toAddress ?? null,
    canSendReminder:
      request.status === "OVERDUE" && letterSent && !request.reminderSentAt &&
      (!request.reminderOfferedAt || request.reminderOfferedAt <= now) && !outs.some((o) => o.kind === "REMINDER" && o.sentAt),
    canEscalate: ["OVERDUE", "REFUSED", "ESCALATED"].includes(request.status) && Boolean(request.clockStart),
    evidenceCount,
    outbound: outs.map((o) => ({
      id: o.id,
      kind: o.kind,
      templateId: o.templateId,
      language: o.language,
      toAddress: o.kind === "ONE_CLICK_POST" ? null : o.toAddress,
      subject: o.subject,
      bodyText: o.kind === "ONE_CLICK_POST" ? null : o.bodyText,
      state: outState(o, request),
      approvedAt: o.approvedAt,
      sendAfter: o.sendAfter,
      sentAt: o.sentAt,
      internetMessageId: o.internetMessageId,
      httpStatus: o.httpStatus,
      error: o.error,
    })),
    replies: await Promise.all(
      replies.map(async (r) => ({
        id: r.id,
        receivedAt: r.receivedAt,
        fromAddress: r.fromAddress,
        subject: r.subject,
        preview: await preview(r),
        matchMethod: r.matchMethod,
        probable: r.probable,
        suggestedClass: r.suggestedClass,
        ownerConfirmed: r.ownerConfirmed,
      })),
    ),
    timeline: events.map((e) => ({ id: e.id, at: e.at, type: e.type, actor: e.actor, data: e.data })),
  };
}
