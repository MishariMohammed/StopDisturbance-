import type { MessageHeader, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentKeyVersion, decrypt } from "@/lib/crypto/tokens";
import { logger } from "@/lib/logger";
import { hashAddress, registrableDomain } from "@/lib/mail/headers";
import { ownerNameTerms, safeSubject } from "@/lib/llm/redact";
import {
  detectEsp,
  dkimRegistrable,
  hasBulkSignals,
  isBrandable,
  isEspDomain,
  isFreemailDomain,
  listIdDomain,
  listUnsubDomains,
  messageClass,
  urlHost,
  type EspMatch,
  type HeaderSignals,
} from "@/lib/scan/signals";

// Stage 2 — Resolve (00-brief §5, 02-capabilities §4). The personal filter runs first.

export type PersonalContext = {
  /** SHA-256 of every address the owner has written to (union over all mailboxes). */
  sentToHashes: ReadonlySet<string>;
  /** The owner's own addresses (login emails + connected mailboxes), lower-case. */
  ownerAddresses: ReadonlySet<string>;
  /** Registrable domains that are the owner's own or employer's (never companies). */
  ownerDomains: ReadonlySet<string>;
};

export type PersonalReason = "owner" | "owner_domain" | "sent_to" | "freemail";

export type BrandVia = "from_aligned" | "from" | "dkim" | "display_name" | "list_unsub" | "reply_to" | "list_id";

export type Resolution =
  | { kind: "personal"; reason: PersonalReason; senderDomain: string; esp: EspMatch | null }
  | { kind: "brand"; domain: string; via: BrandVia; esp: EspMatch | null }
  | { kind: "unresolved"; senderDomain: string; esp: EspMatch | null };

/** Normalised company-name key used for the display-name fallback ("Noon Deals" → "noon"). */
export function nameKey(name: string | null | undefined): string | null {
  const n = cleanDisplayName(name)?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return n && [...n].length >= 3 ? n : null;
}

const NAME_NOISE =
  /\b(team|news|newsletter|deals|offers|updates|notifications?|alerts?|support|customer (service|care)|care|rewards|insider|no-?reply|info|mail|marketing|store|shop|official)\b/giu;

/** Display name → company name (02 §4.4): strip "via …", emoji, team/news suffixes. */
export function cleanDisplayName(name: string | null | undefined): string | null {
  if (!name) return null;
  const out = name
    .replace(/\s+(via|from|عبر)\s+.*$/iu, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/^(فريق|نشرة)\s+/u, "")
    .replace(NAME_NOISE, "")
    .replace(/[|•·:–—-]+\s*$/u, "")
    .replace(/^\s*[|•·:–—-]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return out || null;
}

export function personalReason(h: HeaderSignals, ctx: PersonalContext, esp: EspMatch | null): PersonalReason | null {
  const addr = h.fromAddress.toLowerCase();
  if (ctx.ownerAddresses.has(addr)) return "owner";
  if (ctx.ownerDomains.has(h.fromDomain)) return "owner_domain";
  const bulk = hasBulkSignals(h, esp);
  // 02 §3.4 rule 1: correspondents are personal only when the message carries no list/ESP signal,
  // so replying to a brand's newsletter address once does not hide the brand.
  if (!bulk && ctx.sentToHashes.has(hashAddress(addr))) return "sent_to";
  if (!bulk && isFreemailDomain(h.fromDomain)) return "freemail";
  return null;
}

/** Brand domain for one message, or null when every candidate is an ESP / free-mail domain. */
export function resolveBrand(
  h: HeaderSignals,
  knownNames: ReadonlyMap<string, string> = new Map(),
): { domain: string; via: BrandVia } | null {
  const dkim = dkimRegistrable(h);
  if (isBrandable(h.fromDomain)) {
    return { domain: h.fromDomain, via: dkim.includes(h.fromDomain) ? "from_aligned" : "from" };
  }
  // From is an ESP/shared or free-mail domain: brand d=, display name, List-Unsubscribe host, Reply-To, List-Id.
  const brandDkim = dkim.find(isBrandable);
  if (brandDkim) return { domain: brandDkim, via: "dkim" };
  const key = nameKey(h.fromName);
  const named = key ? knownNames.get(key) : undefined;
  if (named) return { domain: named, via: "display_name" };
  const lu = listUnsubDomains(h).find(isBrandable);
  if (lu) return { domain: lu, via: "list_unsub" };
  if (isBrandable(h.replyToDomain)) return { domain: h.replyToDomain, via: "reply_to" };
  const lid = listIdDomain(h.listId);
  if (isBrandable(lid)) return { domain: lid, via: "list_id" };
  return null;
}

export function resolveHeader(
  h: HeaderSignals,
  ctx: PersonalContext,
  knownNames: ReadonlyMap<string, string> = new Map(),
): Resolution {
  const esp = detectEsp(h);
  const reason = personalReason(h, ctx, esp);
  if (reason) return { kind: "personal", reason, senderDomain: h.fromDomain, esp };
  const brand = resolveBrand(h, knownNames);
  if (brand) return { kind: "brand", ...brand, esp };
  return { kind: "unresolved", senderDomain: h.fromDomain, esp };
}

/**
 * Resolves a batch in two passes so the display-name fallback can use brands seen in the same batch
 * (e.g. `"Nike" <x@mcsv.net>` with no brand d= maps to nike.com when nike.com mail is also present).
 */
export function resolveBatch(
  rows: HeaderSignals[],
  ctx: PersonalContext,
  knownNames: Map<string, string> = new Map(),
): Resolution[] {
  const first = rows.map((h) => resolveHeader(h, ctx, knownNames));
  first.forEach((r, i) => {
    if (r.kind === "brand" && (r.via === "from_aligned" || r.via === "from")) {
      const key = nameKey(rows[i].fromName);
      if (key && !knownNames.has(key)) knownNames.set(key, r.domain);
    }
  });
  return first.map((r, i) => (r.kind === "unresolved" ? resolveHeader(rows[i], ctx, knownNames) : r));
}

// ---------- DB step ----------

function decryptHost(cipher: Uint8Array | null): string | null {
  if (!cipher) return null;
  // Rows don't record the key version; try newest first so rotated keys still work.
  for (let v = currentKeyVersion(); v >= 1; v--) {
    try {
      return urlHost(decrypt(cipher, v));
    } catch {
      /* try the previous key */
    }
  }
  return null;
}

export function signalsFromRow(row: MessageHeader, opts: { decryptListUnsub?: boolean } = {}): HeaderSignals {
  return {
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    fromDomain: row.fromDomain,
    replyToDomain: row.replyToDomain,
    returnPathDomain: row.returnPathDomain,
    dkimDomains: row.dkimDomains,
    dkimPass: row.dkimPass,
    hasListUnsub: Boolean(row.listUnsubHttpsCipher || row.listUnsubMailto),
    listUnsubHttpsHost: opts.decryptListUnsub === false ? null : decryptHost(row.listUnsubHttpsCipher),
    listUnsubMailto: row.listUnsubMailto,
    oneClick: row.oneClick,
    listId: row.listId,
    feedbackId: row.feedbackId,
    precedence: row.precedence,
    autoSubmitted: row.autoSubmitted,
    labels: row.labels,
    subject: row.subject,
  };
}

export async function loadPersonalContext(): Promise<PersonalContext & { ownerNames: string[] }> {
  const [owner, accounts] = await Promise.all([
    db.owner.findUnique({ where: { id: "owner" } }),
    db.mailAccount.findMany({ select: { address: true, sentToHashes: true } }),
  ]);
  const ownerAddresses = new Set(
    [...(owner?.loginEmails ?? []), ...accounts.map((a) => a.address)].map((a) => a.trim().toLowerCase()),
  );
  const ownerDomains = new Set<string>((owner?.employerDomains ?? []).map((d) => registrableDomain(d)));
  // The owner's own non-free-mail domains (e.g. a vanity domain) are personal too.
  for (const a of ownerAddresses) {
    const d = registrableDomain(a);
    if (!isFreemailDomain(d) && !isEspDomain(d)) ownerDomains.add(d);
  }
  return {
    sentToHashes: new Set(accounts.flatMap((a) => a.sentToHashes)),
    ownerAddresses,
    ownerDomains,
    ownerNames: ownerNameTerms(owner?.fullName ?? ""),
  };
}

type Agg = {
  domain: string;
  companyDomain: string | null; // brand domain when this sender is a company
  isEsp: boolean;
  personal: { count: number; first?: Date; last?: Date };
  bulk: {
    count: number;
    marketing: number;
    transactional: number;
    first?: Date;
    last?: Date;
    oneClick: boolean;
    subjects: string[];
    names: Map<string, number>;
  };
  accountIds: Set<string>;
  rowUpdates: Map<string, { ids: string[]; data: Prisma.MessageHeaderUpdateManyMutationInput }>;
};

const minDate = (a: Date | undefined, b: Date) => (!a || b < a ? b : a);
const maxDate = (a: Date | undefined, b: Date) => (!a || b > a ? b : a);

function topName(names: Map<string, number>): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of names) if (v > n) [best, n] = [k, v];
  return best;
}

function fallbackName(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function companyFor(domain: string, displayName: string | null): Promise<string> {
  const existing = await db.companyDomain.findUnique({ where: { domain } });
  if (existing) return existing.companyId; // psl, llm or manual: never overwritten
  const company =
    (await db.company.findUnique({ where: { primaryDomain: domain } })) ??
    (await db.company.create({
      data: { primaryDomain: domain, name: cleanDisplayName(displayName) ?? fallbackName(domain) },
    }));
  await db.companyDomain.createMany({ data: [{ domain, companyId: company.id, source: "psl" }], skipDuplicates: true });
  return company.id;
}

async function knownCompanyNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const c of await db.company.findMany({ select: { name: true, primaryDomain: true } })) {
    const k = nameKey(c.name);
    if (k && !map.has(k)) map.set(k, c.primaryDomain);
  }
  return map;
}

export type ResolveStats = { headers: number; personal: number; brand: number; unresolved: number; senderIds: string[] };

/** Aggregates unprocessed MessageHeader rows (senderId null) into Sender / Company / CompanyDomain. */
export async function resolvePending(opts: { accountId?: string; batchSize?: number } = {}): Promise<ResolveStats> {
  const batchSize = opts.batchSize ?? 500;
  const ctx = await loadPersonalContext();
  const knownNames = await knownCompanyNames();
  const stats: ResolveStats = { headers: 0, personal: 0, brand: 0, unresolved: 0, senderIds: [] };
  const touched = new Set<string>();

  for (;;) {
    const rows = await db.messageHeader.findMany({
      where: { senderId: null, ...(opts.accountId ? { accountId: opts.accountId } : {}) },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (!rows.length) break;
    const signals = rows.map((r) => signalsFromRow(r));
    const results = resolveBatch(signals, ctx, knownNames);
    const aggs = new Map<string, Agg>();

    rows.forEach((row, i) => {
      const r = results[i];
      const h = signals[i];
      // Unresolvable bulk mail from a free-mail address (a small business on gmail.com via Mailchimp)
      // is keyed by its address so it never merges with the personal free-mail bucket.
      const domain =
        r.kind === "brand"
          ? r.domain
          : r.kind === "unresolved" && isFreemailDomain(r.senderDomain)
            ? row.fromAddress.toLowerCase()
            : r.senderDomain;
      let a = aggs.get(domain);
      if (!a) {
        a = {
          domain,
          companyDomain: null,
          isEsp: false,
          personal: { count: 0 },
          bulk: { count: 0, marketing: 0, transactional: 0, oneClick: false, subjects: [], names: new Map() },
          accountIds: new Set(),
          rowUpdates: new Map(),
        };
        aggs.set(domain, a);
      }
      a.accountIds.add(row.accountId);
      const flags = { isPersonal: false, isMarketing: false, isTransactional: false, esp: r.esp?.name ?? null };
      if (r.kind === "personal") {
        stats.personal++;
        flags.isPersonal = true;
        a.personal.count++;
        a.personal.first = minDate(a.personal.first, row.receivedAt);
        a.personal.last = maxDate(a.personal.last, row.receivedAt);
      } else {
        if (r.kind === "brand") stats.brand++;
        else stats.unresolved++;
        if (r.kind === "brand") a.companyDomain = r.domain;
        if (r.kind === "unresolved" && isEspDomain(r.senderDomain)) a.isEsp = true;
        const cls = messageClass(h, r.esp);
        Object.assign(flags, cls);
        const b = a.bulk;
        b.count++;
        if (cls.isMarketing) b.marketing++;
        if (cls.isTransactional) b.transactional++;
        b.first = minDate(b.first, row.receivedAt);
        b.last = maxDate(b.last, row.receivedAt);
        b.oneClick ||= row.oneClick;
        const s = safeSubject(row.subject, { ownerNames: ctx.ownerNames });
        if (s && b.subjects.length < 3 && !b.subjects.includes(s)) b.subjects.push(s);
        if (row.fromName) b.names.set(row.fromName, (b.names.get(row.fromName) ?? 0) + 1);
      }
      const key = JSON.stringify(flags);
      const u = a.rowUpdates.get(key) ?? { ids: [] as string[], data: flags };
      u.ids.push(row.id);
      a.rowUpdates.set(key, u);
    });

    for (const a of aggs.values()) {
      const senderId = await upsertSender(a);
      touched.add(senderId);
      for (const u of a.rowUpdates.values()) {
        await db.messageHeader.updateMany({ where: { id: { in: u.ids } }, data: { ...u.data, senderId } });
      }
    }
    stats.headers += rows.length;
    if (rows.length < batchSize) break;
  }
  stats.senderIds = [...touched];
  logger.info({ headers: stats.headers, senders: touched.size }, "resolve done");
  return stats;
}

export const resolveAccount = (accountId: string) => resolvePending({ accountId });

async function upsertSender(a: Agg): Promise<string> {
  const existing = await db.sender.findUnique({ where: { registrableDomain: a.domain } });
  const b = a.bulk;
  const hasBulk = b.count > 0;
  const displayName = topName(b.names);
  const companyId = a.companyDomain ? await companyFor(a.companyDomain, displayName) : null;
  const accountIds = [...new Set([...(existing?.accountIds ?? []), ...a.accountIds])];

  if (!existing) {
    const personalOnly = !hasBulk;
    const src = personalOnly ? a.personal : b;
    const created = await db.sender.create({
      data: {
        registrableDomain: a.domain,
        displayName: personalOnly ? null : displayName,
        companyId,
        isEsp: a.isEsp,
        isPersonal: personalOnly,
        msgCount: src.count,
        marketingCount: personalOnly ? 0 : b.marketing,
        transactionalCount: personalOnly ? 0 : b.transactional,
        firstSeen: src.first!,
        lastSeen: src.last!,
        hasOneClick: personalOnly ? false : b.oneClick,
        exampleSubjects: personalOnly ? [] : b.subjects,
        accountIds,
      },
    });
    return created.id;
  }

  // Personal mail never counts toward a non-personal sender; a personal-only sender restarts its
  // counts when its first non-personal message arrives.
  const data: Prisma.SenderUpdateInput = { accountIds };
  if (hasBulk) {
    const reset = existing.isPersonal;
    data.isPersonal = false;
    data.isEsp = existing.isEsp || a.isEsp;
    data.msgCount = (reset ? 0 : existing.msgCount) + b.count;
    data.marketingCount = (reset ? 0 : existing.marketingCount) + b.marketing;
    data.transactionalCount = (reset ? 0 : existing.transactionalCount) + b.transactional;
    data.firstSeen = reset ? b.first! : minDate(existing.firstSeen, b.first!);
    data.lastSeen = reset ? b.last! : maxDate(existing.lastSeen, b.last!);
    data.hasOneClick = (!reset && existing.hasOneClick) || b.oneClick;
    data.exampleSubjects = [...new Set([...(reset ? [] : existing.exampleSubjects), ...b.subjects])].slice(0, 3);
    if (!existing.displayName || reset) data.displayName = displayName;
    if (companyId) data.companyId = existing.companyId && !reset ? existing.companyId : companyId;
  } else if (existing.isPersonal) {
    data.msgCount = existing.msgCount + a.personal.count;
    data.firstSeen = minDate(existing.firstSeen, a.personal.first!);
    data.lastSeen = maxDate(existing.lastSeen, a.personal.last!);
  }
  await db.sender.update({ where: { id: existing.id }, data });
  return existing.id;
}
