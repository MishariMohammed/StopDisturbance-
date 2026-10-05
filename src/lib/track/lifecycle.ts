import type { RequestStatus } from "@prisma/client";
import { simpleParser } from "mailparser";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/tokens";
import { logger } from "@/lib/logger";
import { replyRaw } from "@/lib/evidence/crypto";
import { sendAlert } from "@/lib/notify/alerts";
import { classifyReply } from "@/lib/track/classify";
import { fetchReplyBody, loadTracked } from "@/lib/track/poll";
import { readerFor } from "@/lib/track/reader";
import { deadlineColumns, extensionNoticeAt, logEvent, TrackError, TRACKED_STATUSES } from "@/lib/track/state";

// Owner actions on a request after it was sent (04-ux §7): web-form submission, reply confirmation,
// extension, escalation record, close. Every change writes a RequestEvent + AuditLog.

export type ConfirmClass = "ACKNOWLEDGED" | "COMPLETED" | "REFUSED" | "NEEDS_ID" | "EXTENSION" | "NOT_RELATED";

const MAX_FUTURE_MS = 5 * 60_000;

async function getRequest(requestId: string) {
  const r = await db.request.findUnique({ where: { id: requestId } });
  if (!r) throw new TrackError("not_found");
  return r;
}

/** "I submitted it" for a web form (also usable later, e.g. after a reply redirected to a form). */
export async function markWebFormSubmitted(requestId: string, submittedAt: Date, now = new Date()): Promise<void> {
  const r = await getRequest(requestId);
  if (Number.isNaN(submittedAt.getTime()) || submittedAt.getTime() > now.getTime() + MAX_FUTURE_MS || submittedAt.getUTCFullYear() < 2023) {
    throw new TrackError("bad_date");
  }
  const allowed: RequestStatus[] = ["DRAFT", "APPROVED", "NEEDS_ACTION", "SENT", "ACKNOWLEDGED", "OVERDUE", "FAILED"];
  if (!allowed.includes(r.status)) throw new TrackError("bad_status", `Cannot record a form for a ${r.status} request`);
  if (r.type !== "WEB_FORM" && r.status !== "NEEDS_ACTION" && r.status !== "FAILED") {
    throw new TrackError("bad_status", "Only web-form requests, or requests redirected to a form");
  }
  // An earlier emailed request keeps its clock (the email's receipt starts the period, 03-legal §7.5).
  const clockStart = r.type !== "WEB_FORM" && r.clockStart && !r.bounced ? r.clockStart : submittedAt;
  const cols = deadlineColumns(r, clockStart, { extensionNoticeAt: await extensionNoticeAt(r.id), reminderSentAt: r.reminderSentAt });
  await db.$transaction(async (tx) => {
    await tx.request.update({ where: { id: r.id }, data: { ...cols, status: "SENT", needsActionReason: null } });
    await tx.outboundMessage.updateMany({ where: { requestId: r.id, kind: "WEB_FORM_COPY", sentAt: null }, data: { sentAt: submittedAt } });
    await logEvent(tx, r.id, "WEB_FORM_SUBMITTED", "OWNER", { submittedAt: submittedAt.toISOString(), clockStart: clockStart.toISOString(), prevStatus: r.status }, now);
  });
}

/** Extension notice (PDPL +30 / GDPR +2 months) — counts only if dated inside the original period. */
export async function recordExtension(requestId: string, noticeDate: Date, now = new Date()): Promise<void> {
  const r = await getRequest(requestId);
  if (!r.clockStart) throw new TrackError("bad_status", "Nothing was sent yet");
  if (Number.isNaN(noticeDate.getTime()) || noticeDate.getTime() < r.clockStart.getTime() - 86_400_000) throw new TrackError("bad_date");
  const cols = deadlineColumns(r, r.clockStart, { extensionNoticeAt: noticeDate, reminderSentAt: r.reminderSentAt });
  const valid = cols.extendedDueAt !== null;
  let status = r.status;
  if (r.status === "OVERDUE" && cols.dueAt.getTime() > now.getTime()) status = "ACKNOWLEDGED";
  if (r.status === "SENT") status = "ACKNOWLEDGED";
  await db.$transaction(async (tx) => {
    await tx.request.update({ where: { id: r.id }, data: { ...cols, extensionClaimed: true, status } });
    await logEvent(tx, r.id, "EXTENSION_RECORDED", "OWNER", {
      noticeDate: noticeDate.toISOString(),
      valid,
      previousDueAt: r.dueAt?.toISOString() ?? null,
      dueAt: cols.dueAt.toISOString(),
      extendedDueAt: cols.extendedDueAt?.toISOString() ?? null,
      prevStatus: r.status,
    }, now);
  });
}

/** Fetch the body of a reply the owner just confirmed (probable domain matches have none until then). */
async function fetchBodyAfterConfirm(replyId: string) {
  const reply = await db.inboundReply.findUniqueOrThrow({ where: { id: replyId } });
  if (replyRaw(reply.bodyCipher)?.length) return;
  const request = await db.request.findUniqueOrThrow({ where: { id: reply.requestId } });
  const header = await db.messageHeader.findFirst({ where: { accountId: request.mailAccountId, providerMsgId: reply.providerMsgId } });
  const account = await db.mailAccount.findUnique({ where: { id: request.mailAccountId } });
  if (!header || !account || account.status !== "ACTIVE") return;
  try {
    const rd = await readerFor(account);
    // The owner confirmed this message is a reply: its thread is now a matched reply thread.
    const body = await fetchReplyBody(rd, header, await loadTracked(), header.threadId);
    if (body.raw) await db.inboundReply.update({ where: { id: reply.id }, data: { bodyCipher: encrypt(body.raw.toString("latin1")) } });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "body fetch after confirm failed");
  }
}

/** Owner confirms (or rejects) a reply's class; applies the status transition (04-ux §7.1, §7.3). */
export async function confirmReply(replyId: string, cls: ConfirmClass, extensionNoticeDate?: Date, now = new Date()): Promise<void> {
  const reply = await db.inboundReply.findUnique({ where: { id: replyId } });
  if (!reply) throw new TrackError("not_found");
  const r = await getRequest(reply.requestId);
  const tracked = TRACKED_STATUSES.includes(r.status);

  if (cls === "NOT_RELATED") {
    // Undo an automatic acknowledgement that this reply caused.
    const auto = await db.requestEvent.findFirst({
      where: { requestId: r.id, type: "AUTO_ACKNOWLEDGED", data: { path: ["replyId"], equals: replyId } },
      orderBy: { at: "desc" },
    });
    const prev = (auto?.data as { prevStatus?: RequestStatus } | null)?.prevStatus;
    await db.$transaction(async (tx) => {
      await tx.inboundReply.update({ where: { id: replyId }, data: { ownerConfirmed: false } });
      if (prev && r.status === "ACKNOWLEDGED") await tx.request.update({ where: { id: r.id }, data: { status: prev } });
      await logEvent(tx, r.id, "REPLY_REJECTED", "OWNER", { replyId, revertedTo: prev && r.status === "ACKNOWLEDGED" ? prev : null }, now);
    });
    return;
  }

  if (reply.probable) await fetchBodyAfterConfirm(replyId);

  let status: RequestStatus = r.status;
  let needsActionReason = r.needsActionReason;
  let closedAt = r.closedAt;
  if (tracked) {
    if (cls === "ACKNOWLEDGED" && r.status === "SENT") status = "ACKNOWLEDGED";
    if (cls === "COMPLETED") {
      status = "COMPLETED";
      closedAt = now;
    }
    if (cls === "REFUSED") status = "REFUSED";
    if (cls === "NEEDS_ID") {
      status = "NEEDS_ACTION";
      needsActionReason = "ID_VERIFICATION";
    }
  }
  await db.$transaction(async (tx) => {
    await tx.inboundReply.update({ where: { id: replyId }, data: { ownerConfirmed: true, suggestedClass: cls } });
    if (status !== r.status || needsActionReason !== r.needsActionReason || closedAt !== r.closedAt) {
      await tx.request.update({ where: { id: r.id }, data: { status, needsActionReason, closedAt } });
    }
    await logEvent(tx, r.id, "REPLY_CONFIRMED", "OWNER", { replyId, cls, prevStatus: r.status, status }, now);
  });
  if (cls === "EXTENSION" && r.clockStart) await recordExtension(r.id, extensionNoticeDate ?? reply.receivedAt, now);
  if (status === "NEEDS_ACTION" && r.status !== "NEEDS_ACTION") await sendAlert("NEEDS_ACTION", { requestId: r.id }, now);
}

export async function markEscalated(requestId: string, complaintRef?: string, now = new Date()): Promise<void> {
  const r = await getRequest(requestId);
  const allowed: RequestStatus[] = ["SENT", "ACKNOWLEDGED", "NEEDS_ACTION", "OVERDUE", "REFUSED", "ESCALATED"];
  if (!allowed.includes(r.status)) throw new TrackError("bad_status", `Cannot escalate a ${r.status} request`);
  const ref = complaintRef?.trim().slice(0, 200) || null;
  await db.$transaction(async (tx) => {
    await tx.request.update({ where: { id: r.id }, data: { status: "ESCALATED", complaintRef: ref ?? r.complaintRef } });
    await logEvent(tx, r.id, "ESCALATED", "OWNER", { complaintRef: ref, prevStatus: r.status }, now);
  });
}

export async function closeRequest(requestId: string, outcome: "COMPLETED" | "REFUSED" | "CANCELLED", now = new Date()): Promise<void> {
  const r = await getRequest(requestId);
  if (r.status === outcome && r.closedAt) return;
  await db.$transaction(async (tx) => {
    // Nothing still waiting to go out may be sent after the owner closes the case.
    await tx.outboundMessage.updateMany({ where: { requestId: r.id, sentAt: null, sendAfter: { not: null } }, data: { sendAfter: null } });
    await tx.request.update({ where: { id: r.id }, data: { status: outcome, closedAt: now, needsActionReason: null } });
    await logEvent(tx, r.id, "CLOSED", "OWNER", { outcome, prevStatus: r.status }, now);
  });
}

/** Full text of a stored reply ("Show full reply", 04-ux §7.3). Empty when no body was fetched. */
export async function replyText(replyId: string): Promise<string> {
  const reply = await db.inboundReply.findUnique({ where: { id: replyId } });
  if (!reply) throw new TrackError("not_found");
  const raw = replyRaw(reply.bodyCipher);
  if (!raw?.length) return "";
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true });
  return parsed.text ?? "";
}

/** Re-run the keyword classifier on a stored reply (e.g. after the body arrived on confirmation). */
export async function reclassifyReply(replyId: string): Promise<string | null> {
  const reply = await db.inboundReply.findUniqueOrThrow({ where: { id: replyId } });
  const cls = classifyReply({ text: await replyText(replyId), subject: reply.subject });
  if (reply.ownerConfirmed === null) await db.inboundReply.update({ where: { id: replyId }, data: { suggestedClass: cls.cls } });
  return cls.cls;
}
