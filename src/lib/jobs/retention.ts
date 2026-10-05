import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { computeDraftHash } from "@/lib/legal/drafts";
import { ONE_CLICK_PREFIX, oneClickUrl } from "@/lib/enrich/contacts";
import { prunePayloadSamples } from "@/lib/llm/client";
import { safeSubject } from "@/lib/llm/redact";
import { loadPersonalContext } from "@/lib/scan/resolve";

// Daily retention job (00-brief §4, wired in src/worker.ts at 04:00 Asia/Riyadh):
//  - MessageHeader rows older than 90 days are deleted. A header that a ONE_CLICK contact points at
//    (`msg:<id>`) is first replaced by the newest surviving eligible header from the same company; if
//    none survives the contact is deleted, unless an unsent one-click item still needs it (kept until sent).
//  - Sender.exampleSubjects only keep subjects still backed by a surviving header.
//  - Closed requests (with messages, replies, evidence and events) go once closedAt + retentionYears passed.
//  - LlmCallLog 90 days; LlmPayloadSample newest 20 and ≤7 days; AppEvent 1 year.

export const HEADER_RETENTION_DAYS = 90;
export const LLM_LOG_RETENTION_DAYS = 90;
export const APP_EVENT_RETENTION_DAYS = 365;
export const RETENTION_YEARS_KEY = "retentionYears";
export const RETENTION_YEARS_DEFAULT = 1;
export const RETENTION_YEARS_OPTIONS = [1, 2, 3] as const;

const DAY = 24 * 3600 * 1000;

export async function getRetentionYears(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: RETENTION_YEARS_KEY } });
  const n = typeof row?.value === "number" ? row.value : Number(row?.value);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : RETENTION_YEARS_DEFAULT;
}

export async function setRetentionYears(years: number) {
  if (!RETENTION_YEARS_OPTIONS.includes(years as 1 | 2 | 3)) throw new Error("retentionYears must be 1, 2 or 3");
  await db.setting.upsert({ where: { key: RETENTION_YEARS_KEY }, create: { key: RETENTION_YEARS_KEY, value: years }, update: { value: years } });
  await db.auditLog.create({ data: { action: "settings.retention_years", entity: "setting", entityId: RETENTION_YEARS_KEY, data: { years } } });
}

function minusYears(d: Date, years: number) {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() - years);
  return out;
}

export type HeaderPurgeStats = { headers: number; contactsRepointed: number; contactsDeleted: number; headersKept: number };

/**
 * Deletes the headers matching `where`, keeping ONE_CLICK contacts and unsent one-click items working:
 * each reference to a doomed header moves to the newest surviving eligible header of the same company.
 */
export async function purgeHeaders(where: Prisma.MessageHeaderWhereInput, now = new Date()): Promise<HeaderPurgeStats> {
  const stats: HeaderPurgeStats = { headers: 0, contactsRepointed: 0, contactsDeleted: 0, headersKept: 0 };
  const doomed = await db.messageHeader.findMany({ where, select: { id: true } });
  if (!doomed.length) return stats;
  const doomedIds = new Set(doomed.map((d) => d.id));
  const keep = new Set<string>();

  const contacts = await db.companyContact.findMany({ where: { kind: "ONE_CLICK", value: { startsWith: ONE_CLICK_PREFIX } } });
  for (const c of contacts) {
    const headerId = c.value.slice(ONE_CLICK_PREFIX.length);
    if (!doomedIds.has(headerId)) continue;
    const replacement = await newestEligibleHeader(c.companyId, doomedIds);
    const oldValue = c.value;
    if (replacement) {
      const value = `${ONE_CLICK_PREFIX}${replacement}`;
      await db.companyContact.update({ where: { id: c.id }, data: { value, lastVerifiedAt: now } });
      await repointOutbound(oldValue, value, now);
      stats.contactsRepointed++;
    } else if (await hasUnsentOneClick(oldValue)) {
      keep.add(headerId); // a queued / approved one-click still needs this URL; purged once it is sent
    } else {
      await db.companyContact.delete({ where: { id: c.id } });
      stats.contactsDeleted++;
    }
  }
  // Unsent one-click items whose contact was already replaced or removed earlier.
  const orphanOuts = await db.outboundMessage.findMany({
    where: { kind: "ONE_CLICK_POST", sentAt: null, toAddress: { in: [...doomedIds].map((id) => `${ONE_CLICK_PREFIX}${id}`) } },
    select: { toAddress: true },
  });
  for (const o of orphanOuts) if (o.toAddress) keep.add(o.toAddress.slice(ONE_CLICK_PREFIX.length));

  const ids = [...doomedIds].filter((id) => !keep.has(id));
  for (let i = 0; i < ids.length; i += 5000) {
    const r = await db.messageHeader.deleteMany({ where: { id: { in: ids.slice(i, i + 5000) } } });
    stats.headers += r.count;
  }
  stats.headersKept = keep.size;
  return stats;
}

async function newestEligibleHeader(companyId: string, exclude: Set<string>): Promise<string | null> {
  const senders = await db.sender.findMany({ where: { companyId }, select: { id: true } });
  if (!senders.length) return null;
  const candidates = await db.messageHeader.findMany({
    where: { senderId: { in: senders.map((s) => s.id) }, oneClick: true, dkimPass: true, dkimCoversListUnsub: true, listUnsubHttpsCipher: { not: null } },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  for (const h of candidates) if (!exclude.has(h.id) && oneClickUrl(h)) return h.id;
  return null;
}

async function hasUnsentOneClick(value: string) {
  return (await db.outboundMessage.count({ where: { kind: "ONE_CLICK_POST", sentAt: null, toAddress: value } })) > 0;
}

/**
 * Unsent one-click items carry the header reference as `toAddress`. The approval covered the company's
 * one-click channel, not a particular header row, so an approved item stays approved on the new row.
 */
async function repointOutbound(oldValue: string, newValue: string, now: Date) {
  const outs = await db.outboundMessage.findMany({ where: { kind: "ONE_CLICK_POST", sentAt: null, toAddress: oldValue } });
  for (const o of outs) {
    const draftHash = computeDraftHash(newValue, o.subject, o.bodyText);
    const approvedHash = o.approvedHash && o.approvedHash === o.draftHash ? draftHash : o.approvedHash;
    await db.outboundMessage.update({ where: { id: o.id }, data: { toAddress: newValue, draftHash, approvedHash } });
    await db.requestEvent.create({ data: { requestId: o.requestId, type: "ONE_CLICK_REPOINTED", actor: "SYSTEM", at: now, data: { reason: "retention" } } });
  }
}

/** Keeps only example subjects that are still backed by a surviving header of that sender. */
export async function pruneExampleSubjects(cutoff: Date): Promise<number> {
  const senders = await db.sender.findMany({ where: { NOT: { exampleSubjects: { isEmpty: true } } }, select: { id: true, exampleSubjects: true, lastSeen: true } });
  if (!senders.length) return 0;
  const ctx = await loadPersonalContext();
  let changed = 0;
  for (const s of senders) {
    let next: string[] = [];
    if (s.lastSeen >= cutoff) {
      const rows = await db.messageHeader.findMany({ where: { senderId: s.id, subject: { not: null } }, select: { subject: true } });
      const live = new Set(rows.map((r) => safeSubject(r.subject, { ownerNames: ctx.ownerNames })).filter(Boolean));
      next = s.exampleSubjects.filter((x) => live.has(x));
    }
    if (next.length !== s.exampleSubjects.length) {
      await db.sender.update({ where: { id: s.id }, data: { exampleSubjects: next } });
      changed++;
    }
  }
  return changed;
}

/** Deletes closed requests whose closedAt + retentionYears has passed, with everything hanging off them. */
export async function purgeClosedRequests(now = new Date(), years?: number): Promise<number> {
  const y = years ?? (await getRetentionYears());
  const old = await db.request.findMany({ where: { closedAt: { not: null, lt: minusYears(now, y) } }, select: { id: true } });
  if (!old.length) return 0;
  const ids = old.map((r) => r.id);
  await db.$transaction([
    db.outboundMessage.deleteMany({ where: { requestId: { in: ids } } }),
    db.inboundReply.deleteMany({ where: { requestId: { in: ids } } }),
    db.evidenceHeader.deleteMany({ where: { requestId: { in: ids } } }),
    db.requestEvent.deleteMany({ where: { requestId: { in: ids } } }),
    db.request.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return ids.length;
}

export type RetentionStats = HeaderPurgeStats & {
  subjectsPruned: number;
  requests: number;
  llmCalls: number;
  appEvents: number;
};

export async function runRetention(now = new Date()): Promise<RetentionStats> {
  const headerCutoff = new Date(now.getTime() - HEADER_RETENTION_DAYS * DAY);
  const headers = await purgeHeaders({ createdAt: { lt: headerCutoff } }, now);
  const subjectsPruned = await pruneExampleSubjects(headerCutoff);
  const requests = await purgeClosedRequests(now);
  const llmCalls = (await db.llmCallLog.deleteMany({ where: { at: { lt: new Date(now.getTime() - LLM_LOG_RETENTION_DAYS * DAY) } } })).count;
  await prunePayloadSamples(now);
  const appEvents = (await db.appEvent.deleteMany({ where: { at: { lt: new Date(now.getTime() - APP_EVENT_RETENTION_DAYS * DAY) } } })).count;
  const stats = { ...headers, subjectsPruned, requests, llmCalls, appEvents };
  logger.info(stats, "retention done");
  return stats;
}
