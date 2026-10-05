import type { MailAccount, OutboundMessage, Prisma, Request } from "@prisma/client";
import { startOfDay } from "date-fns";
import { tz } from "@date-fns/tz";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { DEADLINE_TZ } from "@/lib/deadlines";
import { computeDraftHash } from "@/lib/legal/drafts";
import { ReconnectRequiredError } from "@/lib/mail/accounts";
import { GmailAuthError } from "@/lib/mail/gmail";
import { GraphAuthError } from "@/lib/mail/graph";
import { sendAlert } from "@/lib/notify/alerts";
import { SendHttpError, type ProviderSendResult } from "@/lib/send/gmail-send";
import { hasSendScope, MissingSendScopeError, sendEmail } from "@/lib/send/mailbox";
import { sendMailtoUnsub } from "@/lib/send/mailto-unsub";
import { oneClickPost } from "@/lib/send/one-click";
import { deadlineColumns, EMAIL_KINDS, extensionNoticeAt, isFollowUp, logEvent, TRACKED_STATUSES } from "@/lib/track/state";

// Stage 8 send dispatcher (00-brief §5): runs every 15 s in the worker.
// - picks QUEUED items whose 10 s undo window has passed (sendAfter ≤ now) — never WEB_FORM_COPY;
// - precondition approvedHash === sha256(current to/subject/body) (03-legal M4);
// - serial per mailbox, ≥30 s since that mailbox's last send, ≤ sendCapPerDay (default 50) per Riyadh day;
// - one retry, then FAILED with a reason; success → SENT, clockStart and deadlines.
// A claim (attempts compare-and-set) makes a second dispatcher instance skip an item already taken.

export const SEND_SPACING_MS = 30_000;
export const RETRY_DELAY_MS = 60_000;
export const MAX_ATTEMPTS = 2;
export const DEFAULT_SEND_CAP = 50;
export const SEND_CAP_KEY = "sendCapPerDay";

const NOT_SENDABLE = ["WEB_FORM_COPY"];

export interface DispatchOutcome {
  outboundId: string;
  result: "sent" | "failed" | "retry" | "revoked" | "skipped_cap" | "skipped_spacing" | "needs_permission" | "needs_reconnect";
  reason?: string;
}

export async function sendCapPerDay(): Promise<number> {
  const v = (await db.setting.findUnique({ where: { key: SEND_CAP_KEY } }))?.value;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), DEFAULT_SEND_CAP) : DEFAULT_SEND_CAP;
}

const riyadhDayStart = (now: Date) => new Date(startOfDay(now, { in: tz(DEADLINE_TZ) }).getTime());

async function mailboxUsage(accountId: string, now: Date) {
  const where: Prisma.OutboundMessageWhereInput = { sentAt: { not: null }, kind: { in: [...EMAIL_KINDS] } };
  const requestIds = (await db.request.findMany({ where: { mailAccountId: accountId }, select: { id: true } })).map((r) => r.id);
  const [today, last] = await Promise.all([
    db.outboundMessage.count({ where: { ...where, requestId: { in: requestIds }, AND: [{ sentAt: { gte: riyadhDayStart(now) } }] } }),
    db.outboundMessage.findFirst({ where: { ...where, requestId: { in: requestIds } }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
  ]);
  return { today, lastSentAt: last?.sentAt ?? null };
}

/** Items due now, oldest first. Initial items need Request QUEUED; follow-ups need a tracked request. */
async function dueItems(now: Date) {
  const outs = await db.outboundMessage.findMany({
    where: {
      sentAt: null,
      sendAfter: { lte: now },
      approvedHash: { not: null },
      kind: { notIn: NOT_SENDABLE },
    },
    orderBy: [{ sendAfter: "asc" }, { createdAt: "asc" }],
  });
  if (!outs.length) return [];
  const reqs = await db.request.findMany({ where: { id: { in: [...new Set(outs.map((o) => o.requestId))] } } });
  const byId = new Map(reqs.map((r) => [r.id, r]));
  return outs.flatMap((out) => {
    const request = byId.get(out.requestId);
    if (!request) return [];
    const ok = isFollowUp(out.kind) ? TRACKED_STATUSES.includes(request.status) : request.status === "QUEUED";
    return ok ? [{ out, request }] : [];
  });
}

/** NEEDS_ACTION / SEND_PERMISSION items go back to QUEUED once the mailbox has the send scope. */
async function resumeGranted() {
  const waiting = await db.request.findMany({ where: { status: "NEEDS_ACTION", needsActionReason: "SEND_PERMISSION" } });
  for (const r of waiting) {
    const acc = await db.mailAccount.findUnique({ where: { id: r.mailAccountId } });
    if (!acc || acc.status !== "ACTIVE" || !hasSendScope(acc)) continue;
    await db.$transaction(async (tx) => {
      const n = await tx.request.updateMany({
        where: { id: r.id, status: "NEEDS_ACTION", needsActionReason: "SEND_PERMISSION" },
        data: { status: "QUEUED", needsActionReason: null },
      });
      if (n.count) await logEvent(tx, r.id, "SEND_PERMISSION_GRANTED", "SYSTEM", { accountId: acc.id });
    });
  }
}

export async function dispatchDue(now = new Date()): Promise<DispatchOutcome[]> {
  await resumeGranted();
  const items = await dueItems(now);
  const outcomes: DispatchOutcome[] = [];
  const cap = await sendCapPerDay();

  // Group by mailbox; each mailbox is processed serially, mailboxes one after the other.
  const byMailbox = new Map<string, typeof items>();
  for (const it of items) {
    const list = byMailbox.get(it.request.mailAccountId) ?? [];
    list.push(it);
    byMailbox.set(it.request.mailAccountId, list);
  }

  for (const [accountId, list] of byMailbox) {
    const account = await db.mailAccount.findUnique({ where: { id: accountId } });
    let usage = await mailboxUsage(accountId, now);
    for (const { out, request } of list) {
      const isEmail = (EMAIL_KINDS as readonly string[]).includes(out.kind);
      if (isEmail) {
        if (!account || account.status !== "ACTIVE") {
          outcomes.push({ outboundId: out.id, result: "needs_reconnect" });
          continue;
        }
        if (!hasSendScope(account)) {
          await needsSendPermission(request, out, now);
          outcomes.push({ outboundId: out.id, result: "needs_permission" });
          continue;
        }
        if (usage.today >= cap) {
          outcomes.push({ outboundId: out.id, result: "skipped_cap" });
          continue;
        }
        if (usage.lastSentAt && now.getTime() - usage.lastSentAt.getTime() < SEND_SPACING_MS) {
          outcomes.push({ outboundId: out.id, result: "skipped_spacing" });
          continue;
        }
      }
      const outcome = await dispatchOne(out, request, account, now);
      outcomes.push(outcome);
      if (isEmail && (outcome.result === "sent" || outcome.result === "retry" || outcome.result === "failed")) {
        // Any attempt that reached the provider counts for spacing; only successes count toward the cap.
        usage = { today: usage.today + (outcome.result === "sent" ? 1 : 0), lastSentAt: now };
      }
    }
  }
  return outcomes;
}

async function needsSendPermission(request: Request, out: OutboundMessage, now: Date) {
  if (isFollowUp(out.kind)) return; // the request keeps its status; the follow-up waits for the grant
  await db.$transaction(async (tx) => {
    const n = await tx.request.updateMany({
      where: { id: request.id, status: "QUEUED" },
      data: { status: "NEEDS_ACTION", needsActionReason: "SEND_PERMISSION" },
    });
    if (n.count) await logEvent(tx, request.id, "NEEDS_SEND_PERMISSION", "SYSTEM", { outboundId: out.id, accountId: request.mailAccountId }, now);
  });
  await sendAlert("NEEDS_ACTION", { requestId: request.id }, now);
}

async function dispatchOne(out: OutboundMessage, request: Request, account: MailAccount | null, now: Date): Promise<DispatchOutcome> {
  // Approval must match exactly what is about to be sent.
  if (out.approvedHash !== computeDraftHash(out.toAddress, out.subject, out.bodyText)) {
    await db.$transaction(async (tx) => {
      await tx.outboundMessage.update({ where: { id: out.id }, data: { approvedHash: null, approvedAt: null, sendAfter: null } });
      if (!isFollowUp(out.kind)) await tx.request.updateMany({ where: { id: request.id, status: "QUEUED" }, data: { status: "DRAFT" } });
      await logEvent(tx, request.id, "APPROVAL_REVOKED", "SYSTEM", { outboundId: out.id, reason: "hash_mismatch" }, now);
    });
    return { outboundId: out.id, result: "revoked", reason: "hash_mismatch" };
  }

  // Claim: compare-and-set on attempts, re-checking the undo state inside the same statement.
  const claimed = await db.outboundMessage.updateMany({
    where: { id: out.id, sentAt: null, attempts: out.attempts, sendAfter: { not: null, lte: now } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return { outboundId: out.id, result: "skipped_spacing", reason: "claimed_elsewhere" };
  if (!isFollowUp(out.kind)) {
    const still = await db.request.findUnique({ where: { id: request.id }, select: { status: true } });
    if (still?.status !== "QUEUED") return { outboundId: out.id, result: "skipped_spacing", reason: "undone" };
  }
  const attempt = out.attempts + 1;

  try {
    const result = await deliver(out, request, account, now);
    await markSent(out, request, result, now);
    return { outboundId: out.id, result: "sent" };
  } catch (err) {
    if (err instanceof ReconnectRequiredError || err instanceof GmailAuthError || err instanceof GraphAuthError) {
      // Not the item's fault: give the attempt back and wait for the owner to reconnect.
      await db.outboundMessage.update({ where: { id: out.id }, data: { attempts: out.attempts } });
      if (account) await sendAlert("MAILBOX_DISCONNECTED", { mailbox: account.address }, now);
      return { outboundId: out.id, result: "needs_reconnect" };
    }
    if (err instanceof MissingSendScopeError) {
      await db.outboundMessage.update({ where: { id: out.id }, data: { attempts: out.attempts } });
      await needsSendPermission(request, out, now);
      return { outboundId: out.id, result: "needs_permission" };
    }
    const reason = failureReason(err);
    const retryable = !(err instanceof DeliveryError && !err.retryable) && !(err instanceof SendHttpError && !err.retryable);
    if (retryable && attempt < MAX_ATTEMPTS) {
      await db.outboundMessage.update({
        where: { id: out.id },
        data: { error: reason, sendAfter: new Date(now.getTime() + RETRY_DELAY_MS) },
      });
      logger.warn({ outboundId: out.id, reason }, "send failed, will retry once");
      return { outboundId: out.id, result: "retry", reason };
    }
    await markFailed(out, request, reason, err instanceof DeliveryError ? err.httpStatus : undefined, now);
    return { outboundId: out.id, result: "failed", reason };
  }
}

class DeliveryError extends Error {
  constructor(
    public reason: string,
    public retryable: boolean,
    public httpStatus?: number,
  ) {
    super(reason);
  }
}

function failureReason(err: unknown): string {
  if (err instanceof DeliveryError) return err.reason;
  if (err instanceof SendHttpError) return `provider_http_${err.status}`;
  return (err as Error)?.message?.slice(0, 120) || "unknown_error";
}

type Delivered = ProviderSendResult & { httpStatus?: number };

async function deliver(out: OutboundMessage, request: Request, account: MailAccount | null, now: Date): Promise<Delivered> {
  if (out.kind === "ONE_CLICK_POST") {
    if (!out.toAddress) throw new DeliveryError("missing_target", false);
    const r = await oneClickPost(out.toAddress);
    if (!r.ok) throw new DeliveryError(r.status ? `one_click_http_${r.status}` : `one_click_${r.reason}`, r.retryable, r.status);
    return { providerMessageId: "", threadId: null, internetMessageId: null, sentAt: now, httpStatus: r.status };
  }
  if (!account) throw new DeliveryError("mailbox_missing", false);
  if (!out.toAddress) throw new DeliveryError("missing_recipient", false);
  const owner = await db.owner.findFirst({ select: { fullName: true } });
  const fromName = owner?.fullName?.trim() || null;
  if (out.kind === "UNSUB_MAILTO") {
    return sendMailtoUnsub(account, { to: out.toAddress, subject: out.subject, body: out.bodyText, fromName }, now);
  }
  const thread = isFollowUp(out.kind) ? await threadFor(out, request) : null;
  return sendEmail(
    account,
    {
      to: out.toAddress,
      subject: out.subject ?? "",
      text: out.bodyText ?? "",
      fromName,
      thread,
      lang: out.language === "ar" ? "ar" : out.language === "en" ? "en" : undefined,
    },
    now,
  );
}

/**
 * Threading data for a follow-up. The OutboundMessage `threadId` of a follow-up draft may name an inbound
 * message to answer (`reply:<MessageHeader.id>`, set by createIdReplyDraft); otherwise it answers the
 * request's first sent email.
 */
async function threadFor(out: OutboundMessage, request: Request) {
  const prior = await db.outboundMessage.findMany({
    where: { requestId: request.id, sentAt: { not: null }, kind: { in: [...EMAIL_KINDS] } },
    orderBy: { sentAt: "asc" },
  });
  const initial = prior[0];
  if (!initial) return null;
  const chain = prior.map((p) => p.internetMessageId).filter((x): x is string => Boolean(x));
  if (out.threadId?.startsWith("reply:")) {
    const h = await db.messageHeader.findUnique({ where: { id: out.threadId.slice(6) } });
    if (h?.internetMessageId) {
      return {
        threadId: h.threadId ?? initial.threadId,
        providerMessageId: h.providerMsgId,
        inReplyTo: h.internetMessageId,
        references: [...chain, h.internetMessageId],
      };
    }
  }
  return {
    threadId: initial.threadId,
    providerMessageId: initial.providerMessageId,
    inReplyTo: initial.internetMessageId,
    references: chain,
  };
}

async function markSent(out: OutboundMessage, request: Request, r: Delivered, now: Date) {
  await db.$transaction(async (tx) => {
    await tx.outboundMessage.update({
      where: { id: out.id },
      data: {
        sentAt: r.sentAt,
        providerMessageId: r.providerMessageId || null,
        threadId: r.threadId,
        internetMessageId: r.internetMessageId,
        httpStatus: r.httpStatus ?? null,
        error: null,
        sendAfter: null,
      },
    });
    if (isFollowUp(out.kind)) {
      const data: Parameters<typeof tx.request.update>[0]["data"] = {};
      if (out.kind === "REMINDER") {
        Object.assign(
          data,
          deadlineColumns(request, request.clockStart ?? r.sentAt, {
            extensionNoticeAt: await extensionNoticeAt(request.id, tx),
            reminderSentAt: r.sentAt,
          }),
          { reminderSentAt: r.sentAt },
        );
      }
      if (out.kind === "ID_REPLY" && request.status === "NEEDS_ACTION") Object.assign(data, { status: "ACKNOWLEDGED", needsActionReason: null });
      if (Object.keys(data).length) await tx.request.update({ where: { id: request.id }, data });
    } else {
      await tx.request.update({
        where: { id: request.id },
        data: { status: "SENT", needsActionReason: null, ...deadlineColumns(request, r.sentAt) },
      });
    }
    // Host/status only for one-click; never subjects or addresses (00-brief §8).
    await logEvent(
      tx,
      request.id,
      out.kind === "REMINDER" ? "REMINDER_SENT" : out.kind === "ID_REPLY" ? "ID_REPLY_SENT" : "SENT",
      "SYSTEM",
      {
        outboundId: out.id,
        kind: out.kind,
        approvedHash: out.approvedHash,
        providerMessageId: r.providerMessageId || null,
        threadId: r.threadId,
        internetMessageId: r.internetMessageId,
        httpStatus: r.httpStatus ?? null,
        sentAt: r.sentAt.toISOString(),
      },
      now,
    );
  });
  logger.info({ outboundId: out.id, kind: out.kind }, "sent");
}

async function markFailed(out: OutboundMessage, request: Request, reason: string, httpStatus: number | undefined, now: Date) {
  await db.$transaction(async (tx) => {
    await tx.outboundMessage.update({ where: { id: out.id }, data: { error: reason, sendAfter: null, httpStatus: httpStatus ?? null } });
    if (!isFollowUp(out.kind)) await tx.request.update({ where: { id: request.id }, data: { status: "FAILED" } });
    await logEvent(tx, request.id, "SEND_FAILED", "SYSTEM", { outboundId: out.id, kind: out.kind, reason, httpStatus: httpStatus ?? null }, now);
  });
  logger.warn({ outboundId: out.id, reason }, "send failed");
  await sendAlert("SEND_FAILED", { requestId: request.id }, now);
}
