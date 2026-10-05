import type { OutboundMessage } from "@prisma/client";
import { db } from "@/lib/db";
import {
  approveDraft,
  computeDraftHash,
  DraftError,
  formatLetterDate,
  queueApproved,
  UNDO_WINDOW_MS,
  undoQueued,
  updateDraft,
} from "@/lib/legal/drafts";
import { findBannedPhrases, renderTemplate } from "@/lib/legal/render";
import { replySubject } from "@/lib/send/mime";
import { caseContext } from "@/lib/track/context";
import { regulatorInfo } from "@/lib/track/regulators";
import { EMAIL_KINDS, initialSent, isFollowUp, logEvent, TrackError } from "@/lib/track/state";

// Follow-up drafts (6b reminder, 6e ID reply) and their approval/queue/undo. They need per-item approval
// like any other send (03-legal M4); drafts.ts covers the first letter (Request DRAFT→APPROVED→QUEUED),
// follow-ups keep the Request status (OVERDUE / NEEDS_ACTION) and carry the state on the OutboundMessage:
// approvedHash set = approved, sendAfter set = queued, sentAt set = sent.

export const MAX_REMINDERS = 1;
export const MAX_MESSAGES_PER_CASE = 3;
const SEPARATOR = "\n----------\n\n";

async function messagesInCase(requestId: string) {
  // Sent emails plus follow-ups still pending (drafted, approved or queued) count toward the cap.
  return db.outboundMessage.count({
    where: {
      requestId,
      kind: { in: [...EMAIL_KINDS] },
      OR: [{ sentAt: { not: null } }, { kind: { in: ["REMINDER", "ID_REPLY"] }, error: null }],
    },
  });
}

interface NewOutbound {
  kind: "REMINDER" | "ID_REPLY";
  templateId: string;
  templateVersion: string;
  language: string;
  toAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  threadId?: string | null;
}

function insert(requestId: string, data: NewOutbound) {
  const draftHash = computeDraftHash(data.toAddress, data.subject, data.bodyText);
  return db.$transaction(async (tx) => {
    const out = await tx.outboundMessage.create({ data: { ...data, requestId, draftHash } });
    await logEvent(tx, requestId, "DRAFT_CREATED", "SYSTEM", {
      outboundId: out.id, kind: out.kind, templateId: out.templateId, templateVersion: out.templateVersion, language: out.language,
    });
    return out;
  });
}

/** 6b reminder (max 1, offered from dueAt + 3 days, ≤3 messages per case). Needs approval before sending. */
export async function createReminderDraft(requestId: string, now = new Date()): Promise<{ outboundId: string }> {
  const request = await db.request.findUnique({ where: { id: requestId } });
  if (!request) throw new TrackError("not_found");
  if (request.status !== "OVERDUE") throw new TrackError("bad_status", `Cannot remind a ${request.status} request`);
  const reminders = await db.outboundMessage.findMany({ where: { requestId, kind: "REMINDER" } });
  if (reminders.some((r) => r.sentAt) || request.reminderSentAt) throw new TrackError("limit_reached", "Only one reminder per request");
  const pending = reminders.find((r) => !r.sentAt && !r.error);
  if (pending) return { outboundId: pending.id };
  if (request.reminderOfferedAt && now.getTime() < request.reminderOfferedAt.getTime()) {
    throw new TrackError("too_early", `Reminder available from ${request.reminderOfferedAt.toISOString()}`);
  }
  if ((await messagesInCase(requestId)) >= MAX_MESSAGES_PER_CASE) throw new TrackError("limit_reached", "At most 3 messages per company per case");
  const initial = await initialSent(requestId);
  if (!initial || initial.kind !== "INITIAL" || !initial.toAddress || !initial.subject) {
    throw new TrackError("not_supported", "Reminders answer a sent letter");
  }

  const ctx = await caseContext(request);
  const regulator = await regulatorInfo(ctx.jurisdiction.regulator, ctx.jurisdiction.euCountry);
  const evidence = await db.evidenceHeader.findMany({ where: { requestId }, orderBy: { receivedAt: "asc" }, take: 5, select: { receivedAt: true } });
  const replied = await db.inboundReply.count({ where: { requestId, ownerConfirmed: true } });
  const render = (lang: "en" | "ar") => {
    const parts: string[] = [];
    if (replied) parts.push(lang === "en" ? "an incomplete response" : "رداً غير مكتمل");
    if (evidence.length) {
      const dates = evidence.map((e) => formatLetterDate(e.receivedAt, lang)).join(", ");
      parts.push(lang === "en" ? `further marketing on ${dates}` : `رسائل تسويقية أخرى في ${dates}`);
    }
    const replyState = parts.length ? parts.join(lang === "en" ? " and " : " و") : lang === "en" ? "no response" : "أي رد";
    return renderTemplate("6b", lang, {
      reference_id: request.reference,
      original_send_date: formatLetterDate(request.clockStart!, lang),
      company: ctx.company.name,
      law_citations: ctx.jurisdiction.citationsText(lang),
      deadline_date: formatLetterDate(request.dueAt!, lang),
      reply_state: replyState,
      regulator: regulator.name[lang],
      full_name: ctx.owner.fullName,
    });
  };
  const arabic = initial.language.startsWith("ar");
  const en = render("en");
  const letters = arabic ? [render("ar"), en] : [en];
  const lead = letters.map((l) => `${l.subject}\n\n${l.body.trimEnd()}\n`).join(SEPARATOR);
  const copyHeader = arabic
    ? `الطلب الأصلي / Original request (${formatLetterDate(initial.sentAt!, "en")}):`
    : `Original request (sent ${formatLetterDate(initial.sentAt!, "en")}):`;
  const body = `${lead}${SEPARATOR}${copyHeader}\n\n${initial.bodyText ?? ""}`;
  // Same subject as the original (Gmail threads on it); the 6b subject line opens the body.
  const subject = replySubject(initial.subject);

  const out = await insert(requestId, {
    kind: "REMINDER",
    templateId: "6b",
    templateVersion: letters.map((l) => l.templateVersion).join("/"),
    language: arabic ? "ar+en" : "en",
    toAddress: initial.toAddress,
    subject,
    bodyText: body,
  });
  return { outboundId: out.id };
}

const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster)([+._-]|@)/i;

/** 6e reply to an identity-verification request (never ID documents by default, 03-legal §7). */
export async function createIdReplyDraft(requestId: string, now = new Date()): Promise<{ outboundId: string }> {
  void now;
  const request = await db.request.findUnique({ where: { id: requestId } });
  if (!request) throw new TrackError("not_found");
  if (request.status !== "NEEDS_ACTION" || request.needsActionReason === "SEND_PERMISSION") {
    throw new TrackError("bad_status", `Cannot answer a ${request.status} request`);
  }
  const pending = await db.outboundMessage.findFirst({ where: { requestId, kind: "ID_REPLY", sentAt: null, error: null } });
  if (pending) return { outboundId: pending.id };
  if ((await messagesInCase(requestId)) >= MAX_MESSAGES_PER_CASE) throw new TrackError("limit_reached", "At most 3 messages per company per case");
  const initial = await initialSent(requestId);
  if (!initial?.subject) throw new TrackError("not_supported", "No sent letter to follow up");

  const ask =
    (await db.inboundReply.findFirst({ where: { requestId, suggestedClass: "NEEDS_ID", ownerConfirmed: true }, orderBy: { receivedAt: "desc" } })) ??
    (await db.inboundReply.findFirst({ where: { requestId, ownerConfirmed: { not: false } }, orderBy: { receivedAt: "desc" } }));
  const header = ask
    ? await db.messageHeader.findFirst({ where: { accountId: request.mailAccountId, providerMsgId: ask.providerMsgId }, select: { id: true } })
    : null;
  const to = ask && !NO_REPLY.test(ask.fromAddress) ? ask.fromAddress : initial.toAddress;
  if (!to) throw new TrackError("not_supported", "No recipient");
  const strip = (s: string) => s.replace(/^\s*((re|aw|fwd?|رد)\s*:\s*)+/i, "").trim();
  const originalSubject = ask?.subject && ask.subject.includes(request.reference) ? strip(ask.subject) : strip(initial.subject);

  const ctx = await caseContext(request);
  const letter = renderTemplate("6e", "en", {
    original_subject: originalSubject,
    email_addresses: ctx.emailAddresses.join(", "),
    law_citations: ctx.jurisdiction.citationsText("en"),
    optional_identifier_line: "",
    reference_id: request.reference,
    full_name: ctx.owner.fullName,
  });
  const out = await insert(requestId, {
    kind: "ID_REPLY",
    templateId: "6e",
    templateVersion: letter.templateVersion,
    language: "en",
    toAddress: to,
    subject: letter.subject,
    bodyText: letter.body,
    // Until sent, threadId names the inbound message this answers (the dispatcher threads to it).
    threadId: header ? `reply:${header.id}` : null,
  });
  return { outboundId: out.id };
}

// ---------- approval / queue / undo for every outbound kind ----------

async function load(outboundId: string): Promise<OutboundMessage> {
  const out = await db.outboundMessage.findUnique({ where: { id: outboundId } });
  if (!out) throw new TrackError("not_found");
  return out;
}

/** Edit any draft. Follow-ups: recompute the hash, clear approval and any queued send. */
export async function updateOutbound(outboundId: string, patch: { subject?: string | null; body?: string | null; to?: string | null }) {
  const out = await load(outboundId);
  if (!isFollowUp(out.kind)) return updateDraft(outboundId, patch);
  if (out.sentAt) throw new TrackError("already_sent");
  const to = patch.to !== undefined ? patch.to?.trim() || null : out.toAddress;
  const subject = patch.subject !== undefined ? patch.subject : out.subject;
  const body = patch.body !== undefined ? patch.body : out.bodyText;
  const draftHash = computeDraftHash(to, subject, body);
  const all = `${subject ?? ""}\n${body ?? ""}`;
  const warnings: string[] = [];
  if (findBannedPhrases(all).length) warnings.push("banned_phrase");
  if (all.includes("{{")) warnings.push("unfilled_placeholder");
  if (/\b\d{10}\b/.test(all)) warnings.push("possible_id_number");
  await db.$transaction(async (tx) => {
    await tx.outboundMessage.update({
      where: { id: out.id },
      data: { toAddress: to, subject, bodyText: body, draftHash, approvedHash: null, approvedAt: null, sendAfter: null },
    });
    await logEvent(tx, out.requestId, "DRAFT_EDITED", "OWNER", { outboundId, draftHash, approvalCleared: out.approvedHash !== null, warnings });
  });
  return { draftHash, warnings };
}

/** Per-item approval for any kind (follow-ups here, first letters via drafts.approveDraft). */
export async function approveOutbound(outboundId: string, now = new Date()): Promise<{ approvedHash: string }> {
  const out = await load(outboundId);
  if (!isFollowUp(out.kind)) return approveDraft(outboundId, now);
  if (out.sentAt) throw new TrackError("already_sent");
  if (!out.toAddress) throw new DraftError("missing_recipient");
  const all = `${out.subject ?? ""}\n${out.bodyText ?? ""}`;
  if (all.includes("{{") || all.includes("}}")) throw new DraftError("unfilled");
  const banned = findBannedPhrases(all);
  if (banned.length) throw new DraftError("banned_phrase", `Remove: ${banned.join(", ")}`);
  const hash = computeDraftHash(out.toAddress, out.subject, out.bodyText);
  await db.$transaction(async (tx) => {
    await tx.outboundMessage.update({ where: { id: out.id }, data: { draftHash: hash, approvedHash: hash, approvedAt: now } });
    await logEvent(tx, out.requestId, "APPROVED", "OWNER", { outboundId, kind: out.kind, draftHash: hash, approvedAt: now.toISOString() }, now);
  });
  return { approvedHash: hash };
}

/** Send confirmation: queue with the 10 s undo window. */
export async function queueOutbound(outboundId: string, now = new Date()): Promise<{ sendAfter: Date }> {
  const out = await load(outboundId);
  if (!isFollowUp(out.kind)) return queueApproved(outboundId, now);
  if (out.sentAt) throw new TrackError("already_sent");
  if (!out.approvedHash || out.approvedHash !== computeDraftHash(out.toAddress, out.subject, out.bodyText)) throw new TrackError("not_approved");
  const sendAfter = new Date(now.getTime() + UNDO_WINDOW_MS);
  await db.$transaction(async (tx) => {
    const n = await tx.outboundMessage.updateMany({ where: { id: out.id, sentAt: null }, data: { sendAfter, error: null } });
    if (n.count !== 1) throw new TrackError("already_sent");
    await logEvent(tx, out.requestId, "QUEUED", "OWNER", { outboundId, kind: out.kind, sendAfter: sendAfter.toISOString(), approvedHash: out.approvedHash }, now);
  });
  return { sendAfter };
}

/** Undo / cancel while queued (any kind). The item goes back to approved, nothing is sent. */
export async function cancelQueued(outboundId: string, now = new Date()): Promise<void> {
  const out = await load(outboundId);
  if (out.sentAt) throw new TrackError("already_sent");
  if (out.kind === "WEB_FORM_COPY") throw new TrackError("not_queued");
  if (!isFollowUp(out.kind)) {
    const request = await db.request.findUniqueOrThrow({ where: { id: out.requestId } });
    if (request.status === "NEEDS_ACTION" && request.needsActionReason === "SEND_PERMISSION") {
      // Waiting for the send grant counts as queued: cancel back to APPROVED.
      await db.$transaction(async (tx) => {
        const sent = await tx.outboundMessage.updateMany({ where: { id: out.id, sentAt: null }, data: { sendAfter: null } });
        if (sent.count !== 1) throw new TrackError("already_sent");
        await tx.request.update({ where: { id: request.id }, data: { status: "APPROVED", needsActionReason: null } });
        await logEvent(tx, request.id, "UNDO", "OWNER", { outboundId }, now);
      });
      return;
    }
    if (request.status !== "QUEUED") throw new TrackError("not_queued");
    try {
      await undoQueued(outboundId, now);
    } catch (err) {
      if (err instanceof DraftError && err.code === "already_sent") throw new TrackError("already_sent");
      if (err instanceof DraftError && err.code === "bad_status") throw new TrackError("not_queued");
      throw err;
    }
    return;
  }
  if (!out.sendAfter) throw new TrackError("not_queued");
  await db.$transaction(async (tx) => {
    const n = await tx.outboundMessage.updateMany({ where: { id: out.id, sentAt: null, sendAfter: { not: null } }, data: { sendAfter: null } });
    if (n.count !== 1) throw new TrackError("already_sent");
    await logEvent(tx, out.requestId, "UNDO", "OWNER", { outboundId, kind: out.kind }, now);
  });
}
