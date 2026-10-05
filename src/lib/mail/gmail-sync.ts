import type { MailAccount, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/tokens";
import { logger } from "@/lib/logger";
import { googleAccessToken } from "@/lib/mail/accounts";
import {
  getMessageMetadata,
  getProfile,
  GmailNotFoundError,
  listHistory,
  listMessages,
  type GmailMessageMeta,
} from "@/lib/mail/gmail";
import { parseHeaders } from "@/lib/mail/headers";

export type GmailCursor = { historyId: string };
export type ScanProgress = { phase: "listing" | "fetching" | "done"; listed: number; fetched: number; startedAt: string };

const GET_CONCURRENCY = 5;

function yearsBetween(from: Date, to = new Date()) {
  return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (365.25 * 24 * 3600 * 1000)));
}

/** Converts one Gmail metadata response into a MessageHeader row (or sent-to hashes for SENT mail). */
export function toHeaderRow(accountId: string, msg: GmailMessageMeta) {
  const labels = msg.labelIds ?? [];
  if (labels.includes("TRASH")) return { kind: "skip" as const };
  const parsed = parseHeaders(msg.payload?.headers ?? []);
  if (!parsed) return { kind: "skip" as const };
  if (labels.includes("SENT")) return { kind: "sent" as const, toHashes: parsed.toHashes };

  const row: Prisma.MessageHeaderCreateManyInput = {
    accountId,
    providerMsgId: msg.id,
    threadId: msg.threadId,
    internetMessageId: parsed.internetMessageId,
    receivedAt: new Date(Number(msg.internalDate)),
    fromAddress: parsed.fromAddress,
    fromName: parsed.fromName,
    fromDomain: parsed.fromDomain,
    replyToDomain: parsed.replyToDomain,
    returnPathDomain: parsed.returnPathDomain,
    dkimDomains: parsed.dkimDomains,
    dkimPass: parsed.dkimPass,
    dkimCoversListUnsub: parsed.dkimCoversListUnsub,
    subject: parsed.subject,
    listUnsubHttpsCipher: parsed.listUnsubHttps ? encrypt(parsed.listUnsubHttps) : null,
    listUnsubMailto: parsed.listUnsubMailto,
    oneClick: parsed.oneClick,
    listId: parsed.listId,
    feedbackId: parsed.feedbackId,
    precedence: parsed.precedence,
    autoSubmitted: parsed.autoSubmitted,
    labels,
  };
  return { kind: "header" as const, row };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function storeMessages(account: MailAccount, token: string, ids: string[]) {
  const existing = new Set(
    (
      await db.messageHeader.findMany({
        where: { accountId: account.id, providerMsgId: { in: ids } },
        select: { providerMsgId: true },
      })
    ).map((r) => r.providerMsgId),
  );
  const todo = ids.filter((id) => !existing.has(id));
  const metas = await mapLimit(todo, GET_CONCURRENCY, async (id) => {
    try {
      return await getMessageMetadata(token, id);
    } catch (err) {
      if (err instanceof GmailNotFoundError) return null; // deleted between list and get
      throw err;
    }
  });

  const rows: Prisma.MessageHeaderCreateManyInput[] = [];
  const sentHashes = new Set<string>();
  for (const meta of metas) {
    if (!meta) continue;
    const r = toHeaderRow(account.id, meta);
    if (r.kind === "header") rows.push(r.row);
    if (r.kind === "sent") r.toHashes.forEach((h) => sentHashes.add(h));
  }
  if (rows.length) await db.messageHeader.createMany({ data: rows, skipDuplicates: true });
  if (sentHashes.size) {
    const current = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id }, select: { sentToHashes: true } });
    const merged = [...new Set([...current.sentToHashes, ...sentHashes])];
    await db.mailAccount.update({ where: { id: account.id }, data: { sentToHashes: merged } });
  }
  return { fetched: todo.length, stored: rows.length };
}

export async function initialSync(accountId: string) {
  const account = await db.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const token = await googleAccessToken(account);
  // Take the history cursor first so nothing that arrives during the scan is missed.
  const profile = await getProfile(token);
  const q = `newer_than:${yearsBetween(account.scanFrom)}y`;
  const progress: ScanProgress = { phase: "listing", listed: 0, fetched: 0, startedAt: new Date().toISOString() };

  let pageToken: string | undefined;
  do {
    const page = await listMessages(token, q, pageToken);
    const ids = (page.messages ?? []).map((m) => m.id);
    progress.listed += ids.length;
    progress.phase = "fetching";
    const { fetched } = await storeMessages(account, await googleAccessToken(account), ids);
    progress.fetched += fetched;
    await db.mailAccount.update({ where: { id: accountId }, data: { scanProgress: progress } });
    pageToken = page.nextPageToken;
  } while (pageToken);

  progress.phase = "done";
  const cursor: GmailCursor = { historyId: profile.historyId };
  await db.mailAccount.update({
    where: { id: accountId },
    data: { scanProgress: progress, syncCursor: cursor, lastSyncAt: new Date() },
  });
  logger.info({ accountId, listed: progress.listed }, "gmail initial sync done");
  return progress;
}

export async function incrementalSync(accountId: string): Promise<{ mode: "incremental" | "full"; added: number }> {
  const account = await db.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const cursor = account.syncCursor as GmailCursor | null;
  if (!cursor?.historyId) {
    const p = await initialSync(accountId);
    return { mode: "full", added: p.fetched };
  }
  const token = await googleAccessToken(account);
  let pageToken: string | undefined;
  let latest = cursor.historyId;
  let added = 0;
  try {
    do {
      const page = await listHistory(token, cursor.historyId, pageToken);
      const ids = [
        ...new Set((page.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id))),
      ];
      if (ids.length) added += (await storeMessages(account, token, ids)).fetched;
      latest = page.historyId ?? latest;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    // A startHistoryId older than Gmail keeps (about a week) returns 404: start over.
    if (err instanceof GmailNotFoundError) {
      logger.warn({ accountId }, "gmail history expired, full resync");
      await db.mailAccount.update({ where: { id: accountId }, data: { syncCursor: undefined } });
      const p = await initialSync(accountId);
      return { mode: "full", added: p.fetched };
    }
    throw err;
  }
  await db.mailAccount.update({
    where: { id: accountId },
    data: { syncCursor: { historyId: latest }, lastSyncAt: new Date() },
  });
  return { mode: "incremental", added };
}
