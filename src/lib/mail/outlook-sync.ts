import type { MailAccount, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/tokens";
import { logger } from "@/lib/logger";
import { microsoftAccessTokenById } from "@/lib/mail/accounts";
import type { ScanProgress } from "@/lib/mail/gmail-sync";
import { GraphDeltaExpiredError, GraphNotFoundError, graphBatch, graphFetch } from "@/lib/mail/graph";
import { hashAddress, parseHeaders, type RawHeader } from "@/lib/mail/headers";
import { scanRangeChanged } from "@/lib/mail/restart-scan";

export const OUTLOOK_FOLDERS = ["inbox", "junkemail", "archive", "sentitems"] as const;
export type OutlookFolder = (typeof OUTLOOK_FOLDERS)[number];
export type OutlookCursor = { folders: Partial<Record<OutlookFolder, string>> };

const FOLDER_LABEL: Record<Exclude<OutlookFolder, "sentitems">, string> = {
  inbox: "FOLDER_INBOX",
  junkemail: "FOLDER_JUNK",
  archive: "FOLDER_ARCHIVE",
};

const DELTA_SELECT = "id,conversationId,receivedDateTime,from,internetMessageId,inferenceClassification";
// Sent mail: recipients only, to build sentToHashes; never stored (same as Gmail SENT).
const SENT_SELECT = "id,receivedDateTime,toRecipients";
const HEADER_SELECT = "internetMessageHeaders,conversationId,receivedDateTime,inferenceClassification,parentFolderId";

type EmailAddress = { emailAddress?: { address?: string; name?: string } };

export type DeltaItem = {
  id: string;
  conversationId?: string;
  receivedDateTime?: string;
  from?: EmailAddress;
  internetMessageId?: string;
  inferenceClassification?: "focused" | "other";
  toRecipients?: EmailAddress[];
  "@removed"?: unknown;
};

type DeltaPage = { value: DeltaItem[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

export type GraphMessageHeaders = {
  id?: string;
  internetMessageHeaders?: RawHeader[];
  conversationId?: string;
  receivedDateTime?: string;
  inferenceClassification?: "focused" | "other";
  parentFolderId?: string;
};

type SyncOpts = { sleep?: (ms: number) => Promise<void>; trackProgress?: boolean };

/** Converts a Graph message (headers from the per-message GET, fallbacks from the delta item) into a row. */
export function toOutlookHeaderRow(
  accountId: string,
  folder: Exclude<OutlookFolder, "sentitems">,
  item: DeltaItem,
  msg: GraphMessageHeaders | undefined,
) {
  let headers = msg?.internetMessageHeaders ?? [];
  if (!headers.some((h) => /^(from|sender)$/i.test(h.name)) && item.from?.emailAddress?.address) {
    // Some items (e.g. drafts saved by other clients) have no internet headers: fall back to `from`.
    const { address, name } = item.from.emailAddress;
    headers = [...headers, { name: "From", value: name ? `"${name}" <${address}>` : address }];
  }
  const parsed = parseHeaders(headers);
  if (!parsed) return { kind: "skip" as const };
  const classification = msg?.inferenceClassification ?? item.inferenceClassification;
  const labels = [FOLDER_LABEL[folder]];
  if (classification) labels.push(classification === "focused" ? "FOCUSED" : "OTHER");
  const received = msg?.receivedDateTime ?? item.receivedDateTime;

  const row: Prisma.MessageHeaderCreateManyInput = {
    accountId,
    providerMsgId: item.id,
    threadId: msg?.conversationId ?? item.conversationId ?? null,
    internetMessageId: parsed.internetMessageId ?? item.internetMessageId ?? null,
    receivedAt: received ? new Date(received) : new Date(),
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

async function addSentHashes(accountId: string, hashes: Set<string>) {
  if (!hashes.size) return;
  const current = await db.mailAccount.findUniqueOrThrow({ where: { id: accountId }, select: { sentToHashes: true } });
  const merged = [...new Set([...current.sentToHashes, ...hashes])];
  await db.mailAccount.update({ where: { id: accountId }, data: { sentToHashes: merged } });
}

/** Stores one delta page. Returns how many messages had their headers fetched. */
async function storePage(account: MailAccount, folder: OutlookFolder, items: DeltaItem[], opts: SyncOpts) {
  const live = items.filter((i) => !i["@removed"]);
  if (folder === "sentitems") {
    const hashes = new Set<string>();
    for (const item of live) {
      for (const r of item.toRecipients ?? []) {
        if (r.emailAddress?.address) hashes.add(hashAddress(r.emailAddress.address));
      }
    }
    await addSentHashes(account.id, hashes);
    return 0;
  }

  const ids = live.map((i) => i.id);
  const existing = new Set(
    (
      await db.messageHeader.findMany({
        where: { accountId: account.id, providerMsgId: { in: ids } },
        select: { providerMsgId: true },
      })
    ).map((r) => r.providerMsgId),
  );
  const todo = live.filter((i) => !existing.has(i.id));
  if (!todo.length) return 0;

  const token = await microsoftAccessTokenById(account.id);
  const results = await graphBatch<GraphMessageHeaders>(
    token,
    todo.map((i) => ({ id: i.id, url: `/me/messages/${encodeURIComponent(i.id)}?$select=${HEADER_SELECT}` })),
    { sleep: opts.sleep },
  );

  const rows: Prisma.MessageHeaderCreateManyInput[] = [];
  for (const item of todo) {
    const res = results.get(item.id);
    if (!res || res.status === 404) continue; // deleted between delta and get
    if (res.status >= 400) throw new Error(`graph_batch_item_${res.status}`);
    const r = toOutlookHeaderRow(account.id, folder, item, res.body);
    if (r.kind === "header") rows.push(r.row);
  }
  if (rows.length) await db.messageHeader.createMany({ data: rows, skipDuplicates: true });
  return todo.length;
}

function initialDeltaPath(folder: OutlookFolder, scanFrom: Date) {
  const select = folder === "sentitems" ? SENT_SELECT : DELTA_SELECT;
  // Message delta supports only `receivedDateTime ge|gt` in $filter.
  const filter = `receivedDateTime ge ${scanFrom.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  return { path: `/mailFolders/${folder}/messages/delta`, query: { $select: select, $filter: filter } };
}

const PAGE_HEADERS = { prefer: "odata.maxpagesize=100" };

/**
 * Runs one folder's delta from `startLink` (or from scratch) to the end and returns the new deltaLink.
 * `null` means the folder does not exist in this mailbox (e.g. no Archive folder).
 */
async function syncFolder(
  account: MailAccount,
  folder: OutlookFolder,
  startLink: string | undefined,
  progress: ScanProgress,
  opts: SyncOpts,
): Promise<string | null> {
  const first = startLink ? { path: startLink, query: undefined } : initialDeltaPath(folder, account.scanFrom);
  let next: { path: string; query?: Record<string, string> } | undefined = first;
  let deltaLink: string | undefined;
  while (next) {
    const token = await microsoftAccessTokenById(account.id);
    let page: DeltaPage;
    try {
      page = await graphFetch<DeltaPage>(token, next.path, { query: next.query, headers: PAGE_HEADERS, sleep: opts.sleep });
    } catch (err) {
      if (err instanceof GraphNotFoundError && !startLink) return null;
      throw err;
    }
    progress.listed += page.value.length;
    progress.phase = "fetching";
    progress.fetched += await storePage(account, folder, page.value, opts);
    // Like Gmail, only the initial scan reports progress; polls leave the finished scan's figures alone.
    if (opts.trackProgress) await db.mailAccount.update({ where: { id: account.id }, data: { scanProgress: progress } });
    deltaLink = page["@odata.deltaLink"] ?? deltaLink;
    next = page["@odata.nextLink"] ? { path: page["@odata.nextLink"] } : undefined;
  }
  return deltaLink ?? null;
}

async function syncFolderWithFallback(
  account: MailAccount,
  folder: OutlookFolder,
  link: string | undefined,
  progress: ScanProgress,
  opts: SyncOpts,
): Promise<{ link: string | null; resynced: boolean }> {
  try {
    return { link: await syncFolder(account, folder, link, progress, opts), resynced: !link };
  } catch (err) {
    if (link && (err instanceof GraphDeltaExpiredError || err instanceof GraphNotFoundError)) {
      logger.warn({ accountId: account.id, folder }, "graph delta token expired, folder resync");
      return { link: await syncFolder(account, folder, undefined, progress, opts), resynced: true };
    }
    throw err;
  }
}

async function runFolders(accountId: string, cursor: OutlookCursor | null, opts: SyncOpts) {
  const account = await db.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const progress: ScanProgress = { phase: "listing", listed: 0, fetched: 0, startedAt: new Date().toISOString() };
  const folders: OutlookCursor["folders"] = {};
  const resynced: OutlookFolder[] = [];
  for (const folder of OUTLOOK_FOLDERS) {
    const r = await syncFolderWithFallback(account, folder, cursor?.folders[folder], progress, opts);
    if (r.link) folders[folder] = r.link;
    if (r.resynced && cursor) resynced.push(folder);
    // Save per folder so an interrupted scan resumes the folders already done.
    await db.mailAccount.update({
      where: { id: accountId },
      data: { syncCursor: { folders: { ...cursor?.folders, ...folders } } },
    });
  }
  progress.phase = "done";
  await db.mailAccount.update({
    where: { id: accountId },
    data: {
      ...(opts.trackProgress ? { scanProgress: progress } : {}),
      syncCursor: { folders },
      lastSyncAt: new Date(),
    },
  });
  return { progress, resynced, scanFrom: account.scanFrom };
}

export async function outlookInitialSync(accountId: string, opts: SyncOpts = {}): Promise<ScanProgress> {
  const { progress, scanFrom } = await runFolders(accountId, null, { ...opts, trackProgress: true });
  // The range was changed while this scan ran (see restartScan): scan again with the new range.
  if (await scanRangeChanged(accountId, scanFrom)) {
    logger.info({ accountId }, "outlook scan range changed during initial sync, restarting");
    return outlookInitialSync(accountId, opts);
  }
  logger.info({ accountId, listed: progress.listed }, "outlook initial sync done");
  return progress;
}

export async function outlookIncrementalSync(
  accountId: string,
  opts: SyncOpts = {},
): Promise<{ mode: "incremental" | "full"; added: number; resynced: OutlookFolder[] }> {
  const account = await db.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const cursor = account.syncCursor as OutlookCursor | null;
  if (!cursor?.folders || !Object.keys(cursor.folders).length) {
    const p = await outlookInitialSync(accountId, opts);
    return { mode: "full", added: p.fetched, resynced: [...OUTLOOK_FOLDERS] };
  }
  const { progress, resynced } = await runFolders(accountId, cursor, opts);
  return { mode: "incremental", added: progress.fetched, resynced };
}
