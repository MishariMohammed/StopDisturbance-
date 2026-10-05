import type { MailAccount, MessageHeader, Prisma } from "@prisma/client";
import { simpleParser } from "mailparser";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/tokens";
import { logger } from "@/lib/logger";
import { addBusinessDays, addCalendarDays } from "@/lib/deadlines";
import { ReconnectRequiredError } from "@/lib/mail/accounts";
import { sendAlert } from "@/lib/notify/alerts";
import { classifyReply, type ReplyClassification } from "@/lib/track/classify";
import { isDsn, matchReply, type ReplyCandidate, type ReplyMatch, type TrackedRequest } from "@/lib/track/match";
import { readerFor, type MailReader } from "@/lib/track/reader";
import { ReplyBodyGuardError } from "@/lib/track/reply-body";
import { companyDomains, logEvent, TRACKED_STATUSES } from "@/lib/track/state";

// replies.poll (00-brief §5 stage 9): runs after incremental sync (every 10 min). Looks at MessageHeader
// rows that arrived since the last poll, matches replies to open requests, stores matched reply bodies
// encrypted, turns bounces into FAILED + bounced, and records "still emailing" evidence.

export const POLL_CURSOR_KEY = "replyPollCursor";
export const STILL_EMAILING_BUSINESS_DAYS = 10;
export const MAX_EVIDENCE_PER_REQUEST = 20;
const BATCH = 500;

export function isListMail(h: Pick<MessageHeader, "isMarketing" | "listId" | "listUnsubHttpsCipher" | "listUnsubMailto" | "precedence">) {
  return Boolean(h.isMarketing || h.listId || h.listUnsubHttpsCipher || h.listUnsubMailto || (h.precedence && /^(bulk|list)$/i.test(h.precedence)));
}

/** Requests whose replies we match (tracked statuses), plus COMPLETED ones (still-emailing only). */
export async function loadTracked(opts: { includeCompleted?: boolean } = {}): Promise<TrackedRequest[]> {
  const statuses = opts.includeCompleted ? [...TRACKED_STATUSES, "COMPLETED" as const] : TRACKED_STATUSES;
  const reqs = await db.request.findMany({ where: { status: { in: statuses }, clockStart: { not: null } } });
  if (!reqs.length) return [];
  const outs = await db.outboundMessage.findMany({
    where: { requestId: { in: reqs.map((r) => r.id) }, sentAt: { not: null } },
    select: { requestId: true, threadId: true, internetMessageId: true },
  });
  const domains = new Map<string, string[]>();
  for (const cid of new Set(reqs.map((r) => r.companyId))) domains.set(cid, await companyDomains(cid));
  return reqs.map((r) => {
    const mine = outs.filter((o) => o.requestId === r.id);
    const last = r.latestDueAt ?? r.dueAt;
    return {
      id: r.id,
      reference: r.reference,
      type: r.type,
      mailAccountId: r.mailAccountId,
      companyId: r.companyId,
      companyDomains: domains.get(r.companyId) ?? [],
      clockStart: r.clockStart,
      windowEnd: r.closedAt ?? (last ? addCalendarDays(last, 90) : null),
      threadIds: mine.map((o) => o.threadId).filter((t): t is string => Boolean(t)),
      messageIds: mine.map((o) => o.internetMessageId?.toLowerCase()).filter((t): t is string => Boolean(t)).map((m) => (m.startsWith("<") ? m : `<${m}>`)),
      status: r.status,
    } as TrackedRequest & { status: string };
  });
}

export interface PollResult {
  scanned: number;
  matched: number;
  bounced: number;
  evidence: number;
}

export async function pollReplies(now = new Date()): Promise<PollResult> {
  const result: PollResult = { scanned: 0, matched: 0, bounced: 0, evidence: 0 };
  const all = (await loadTracked({ includeCompleted: true })) as (TrackedRequest & { status: string })[];
  const tracked = all.filter((r) => r.status !== "COMPLETED");
  const cursorRow = await db.setting.findUnique({ where: { key: POLL_CURSOR_KEY } });
  const earliest = all.reduce<Date | null>((m, r) => (r.clockStart && (!m || r.clockStart < m) ? r.clockStart : m), null);
  const cursor = typeof cursorRow?.value === "string" ? new Date(cursorRow.value) : (earliest ?? now);

  const headers = await db.messageHeader.findMany({
    where: { createdAt: { gt: cursor } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  if (!headers.length) return result;

  const readers = new Map<string, MailReader | null>();
  const accounts = new Map<string, MailAccount | null>();
  const reader = async (accountId: string) => {
    if (!readers.has(accountId)) {
      const acc = await db.mailAccount.findUnique({ where: { id: accountId } });
      accounts.set(accountId, acc);
      let r: MailReader | null = null;
      if (acc && acc.status === "ACTIVE") {
        try {
          r = await readerFor(acc);
        } catch (err) {
          if (!(err instanceof ReconnectRequiredError)) throw err;
        }
      }
      readers.set(accountId, r);
    }
    return readers.get(accountId) ?? null;
  };
  const activeMailboxes = new Set(all.map((r) => r.mailAccountId));
  const allDomains = new Set(all.flatMap((r) => r.companyDomains));

  for (const h of headers) {
    result.scanned++;
    const list = isListMail(h);
    // Only mailboxes with requests can hold replies; skip everything unrelated without any API call.
    const maybeReply = tracked.length > 0 && activeMailboxes.has(h.accountId) && !list;
    const maybeEvidence = list && allDomains.has(h.fromDomain);
    if (!maybeReply && !maybeEvidence) continue;
    const rd = await reader(h.accountId);

    if (maybeReply) {
      let refs: { referenceIds: string[]; contentType: string | null } = { referenceIds: [], contentType: null };
      if (rd) {
        try {
          refs = await rd.refs(h.providerMsgId);
        } catch (err) {
          logger.warn({ err: (err as Error).message }, "reply refs fetch failed");
        }
      }
      const candidate: ReplyCandidate = {
        accountId: h.accountId,
        threadId: h.threadId,
        subject: h.subject,
        fromAddress: h.fromAddress,
        fromDomain: h.fromDomain,
        receivedAt: h.receivedAt,
        referenceIds: refs.referenceIds,
        isList: list,
        isDsn: isDsn({ fromAddress: h.fromAddress, subject: h.subject, contentType: refs.contentType }),
      };
      const m = matchReply(candidate, tracked);
      if (m && candidate.isDsn) {
        if (await recordBounce(h, m, rd, all, now)) result.bounced++;
        continue;
      }
      if (m) {
        if (await recordReply(h, m, rd, all, now)) result.matched++;
        continue;
      }
    }
    if (maybeEvidence) result.evidence += await recordStillEmailing(h, rd, all, now);
  }

  const last = headers[headers.length - 1].createdAt.toISOString();
  await db.setting.upsert({ where: { key: POLL_CURSOR_KEY }, create: { key: POLL_CURSOR_KEY, value: last }, update: { value: last } });
  return result;
}

function guardLists(all: TrackedRequest[], accountId: string, extraThread?: string | null) {
  const threads = all.filter((r) => r.mailAccountId === accountId).flatMap((r) => r.threadIds);
  if (extraThread) threads.push(extraThread);
  return { threads, ours: all.flatMap((r) => r.messageIds) };
}

/** Fetches (guarded) and parses a reply body. Returns the raw MIME and the plain text. */
export async function fetchReplyBody(
  rd: MailReader | null,
  h: Pick<MessageHeader, "providerMsgId" | "accountId">,
  all: TrackedRequest[],
  extraThread?: string | null,
): Promise<{ raw: Buffer | null; text: string }> {
  if (!rd) return { raw: null, text: "" };
  const { threads, ours } = guardLists(all, h.accountId, extraThread);
  try {
    const raw = await rd.body(h.providerMsgId, threads, ours);
    const parsed = await simpleParser(raw, { skipHtmlToText: false, skipImageLinks: true, skipTextLinks: true });
    return { raw, text: (parsed.text ?? "").slice(0, 50_000) };
  } catch (err) {
    if (!(err instanceof ReplyBodyGuardError)) logger.warn({ err: (err as Error).message }, "reply body fetch failed");
    return { raw: null, text: "" };
  }
}

async function recordReply(h: MessageHeader, m: ReplyMatch, rd: MailReader | null, all: TrackedRequest[], now: Date): Promise<boolean> {
  const dup = await db.inboundReply.findFirst({ where: { requestId: m.request.id, providerMsgId: h.providerMsgId } });
  if (dup) return false;
  // Domain-only (probable) matches: no body until the owner confirms the match (privacy by default).
  const body = m.probable ? { raw: null, text: "" } : await fetchReplyBody(rd, h, all, m.method === "SUBJECT_TOKEN" ? h.threadId : null);
  const cls: ReplyClassification = classifyReply({ text: body.text, subject: h.subject, autoSubmitted: h.autoSubmitted });

  const request = await db.request.findUniqueOrThrow({ where: { id: m.request.id } });
  const autoAck = !m.probable && cls.autoAck && request.status === "SENT";
  const reply = await db.$transaction(async (tx) => {
    const reply = await tx.inboundReply.create({
      data: {
        requestId: request.id,
        providerMsgId: h.providerMsgId,
        receivedAt: h.receivedAt,
        fromAddress: h.fromAddress,
        subject: h.subject ?? "",
        bodyCipher: encrypt(body.raw ? body.raw.toString("latin1") : ""),
        matchMethod: m.method,
        probable: m.probable,
        suggestedClass: cls.cls,
        ownerConfirmed: null,
      },
    });
    await logEvent(tx, request.id, "REPLY_RECEIVED", "SYSTEM", {
      replyId: reply.id, headerId: h.id, matchMethod: m.method, probable: m.probable, suggestedClass: cls.cls, confidence: cls.confidence,
    }, now);
    if (autoAck) {
      await tx.request.update({ where: { id: request.id }, data: { status: "ACKNOWLEDGED" } });
      await logEvent(tx, request.id, "AUTO_ACKNOWLEDGED", "SYSTEM", { replyId: reply.id, prevStatus: request.status, undoable: true }, now);
    }
    return reply;
  });
  if (!autoAck) await sendAlert("REPLY_RECEIVED", { requestId: request.id }, now);
  logger.info({ requestId: request.id, replyId: reply.id, method: m.method }, "reply matched");
  return true;
}

async function recordBounce(h: MessageHeader, m: ReplyMatch, rd: MailReader | null, all: TrackedRequest[], now: Date): Promise<boolean> {
  const dup = await db.inboundReply.findFirst({ where: { requestId: m.request.id, providerMsgId: h.providerMsgId } });
  if (dup) return false;
  const body = await fetchReplyBody(rd, h, all);
  const request = await db.request.findUniqueOrThrow({ where: { id: m.request.id } });
  const refs = new Set(m.request.messageIds);
  const outs = await db.outboundMessage.findMany({ where: { requestId: request.id, sentAt: { not: null } }, orderBy: { sentAt: "desc" } });
  const bouncedOut = outs.find((o) => o.internetMessageId && refs.has(o.internetMessageId.toLowerCase())) ?? outs[0];
  await db.$transaction(async (tx) => {
    await tx.inboundReply.create({
      data: {
        requestId: request.id,
        providerMsgId: h.providerMsgId,
        receivedAt: h.receivedAt,
        fromAddress: h.fromAddress,
        subject: h.subject ?? "",
        bodyCipher: encrypt(body.raw ? body.raw.toString("latin1") : ""),
        matchMethod: `DSN_${m.method}`,
        probable: false,
        suggestedClass: "BOUNCE",
        ownerConfirmed: true,
      },
    });
    if (bouncedOut) await tx.outboundMessage.update({ where: { id: bouncedOut.id }, data: { error: "bounced" } });
    await tx.request.update({ where: { id: request.id }, data: { status: "FAILED", bounced: true } });
    await logEvent(tx, request.id, "BOUNCED", "SYSTEM", { outboundId: bouncedOut?.id ?? null, prevStatus: request.status, headerId: h.id }, now);
  });
  await sendAlert("BOUNCED", { requestId: request.id }, now);
  return true;
}

async function recordStillEmailing(h: MessageHeader, rd: MailReader | null, all: TrackedRequest[], now: Date): Promise<number> {
  const sender = h.senderId ? await db.sender.findUnique({ where: { id: h.senderId }, select: { companyId: true } }) : null;
  const hits = all.filter(
    (r) =>
      (r.companyDomains.includes(h.fromDomain) || (sender?.companyId && sender.companyId === r.companyId)) &&
      r.clockStart &&
      h.receivedAt.getTime() > addBusinessDays(r.clockStart, STILL_EMAILING_BUSINESS_DAYS).getTime(),
  );
  if (!hits.length) return 0;
  let raw = "";
  if (rd) {
    try {
      raw = await rd.rawHeaders(h.providerMsgId);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "evidence header fetch failed");
    }
  }
  let stored = 0;
  for (const r of hits) {
    const count = await db.evidenceHeader.count({ where: { requestId: r.id } });
    const req = await db.request.findUniqueOrThrow({ where: { id: r.id }, select: { stillEmailing: true } });
    await db.$transaction(async (tx) => {
      if (count < MAX_EVIDENCE_PER_REQUEST && raw) {
        await tx.evidenceHeader.create({ data: { requestId: r.id, receivedAt: h.receivedAt, rawHeadersCipher: encrypt(raw) } });
        stored++;
      }
      if (!req.stillEmailing) {
        await tx.request.update({ where: { id: r.id }, data: { stillEmailing: true } });
      }
      const data: Prisma.InputJsonValue = { headerId: h.id, receivedAt: h.receivedAt.toISOString(), evidenceStored: Boolean(raw) && count < MAX_EVIDENCE_PER_REQUEST };
      await logEvent(tx, r.id, req.stillEmailing ? "MARKETING_AFTER_REQUEST" : "STILL_EMAILING", "SYSTEM", data as Record<string, unknown>, now);
    });
  }
  return stored;
}
