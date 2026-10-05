import { resolveMx } from "node:dns/promises";
import type { CompanyContact, Confidence, ContactKind, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentKeyVersion, decrypt } from "@/lib/crypto/tokens";
import { logger } from "@/lib/logger";
import { registrableDomain } from "@/lib/mail/headers";
import { safeFetch } from "@/lib/net/safe-fetch";
import { isFreemailDomain } from "@/lib/scan/signals";
import { addressCountry } from "@/lib/enrich/countries";
import { lookupDatarequests, lookupJdm } from "@/lib/enrich/datasets";
import { dedupeFacts, mergeJurisdiction, type Fact } from "@/lib/enrich/facts";
import { discoverPolicy, llmExtractContacts, policyFacts, portalVendorFor } from "@/lib/enrich/policy";

// Stage 4 — Enrich contacts (00-brief §5, 01-research §2.4). Cascade, in order:
//   1 owner override (ownerConfirmed contacts) → 2 datarequests.org → 3 JustDeleteMe (account-delete link)
//   → 4 /.well-known/privacy.txt → 5 privacy-policy page (+ LLM in AI mode) → 6 guess privacy@/dpo@ with MX
//   (LOW, needs owner confirmation) → 7 the sender's own support address (LOW).
// The first step that yields a privacy channel (PRIVACY_EMAIL or WEB_FORM) settles the cascade; JDM and
// the header channels (ONE_CLICK, MAILTO_UNSUB) are always collected.

export const ENRICH_TTL_MS = 30 * 24 * 3600 * 1000;

const PRIVACY_KINDS = new Set<ContactKind>(["PRIVACY_EMAIL", "WEB_FORM"]);

export type ContactCandidate = {
  kind: ContactKind;
  value: string;
  source: string;
  confidence: Confidence;
  mxOk?: boolean | null;
  portalVendor?: string | null;
};

export type EnrichResult = {
  companyId: string;
  domain: string;
  cached: boolean;
  /** Cascade steps that ran, in order. */
  steps: string[];
  /** Step that produced the privacy channel (null: none found). */
  settledBy: string | null;
  contacts: CompanyContact[];
  facts: Fact[];
};

// ---------- header channels ----------

export type UnsubHeader = {
  id: string;
  listUnsubHttpsCipher: Uint8Array | null;
  listUnsubMailto: string | null;
  oneClick: boolean;
  dkimPass: boolean;
  dkimCoversListUnsub: boolean;
};

function decryptAnyVersion(cipher: Uint8Array): string | null {
  for (let v = currentKeyVersion(); v >= 1; v--) {
    try {
      return decrypt(cipher, v);
    } catch {
      /* older key */
    }
  }
  return null;
}

/**
 * RFC 8058 eligibility (02-capabilities §5.3): an https List-Unsubscribe URI, List-Unsubscribe-Post
 * One-Click, dkim=pass, and that signature's h= covering both headers. Returns the URL or null.
 */
export function oneClickUrl(h: UnsubHeader): string | null {
  if (!h.listUnsubHttpsCipher || !h.oneClick || !h.dkimPass || !h.dkimCoversListUnsub) return null;
  const url = decryptAnyVersion(h.listUnsubHttpsCipher);
  return url && /^https:\/\//i.test(url) ? url : null;
}

/**
 * ONE_CLICK contacts don't store the URL (it carries a per-recipient token and is kept encrypted on the
 * header row). The value is `msg:<MessageHeader.id>`; the sender resolves it with this function.
 */
export const ONE_CLICK_PREFIX = "msg:";

export async function resolveOneClickUrl(contactValue: string): Promise<string | null> {
  if (!contactValue.startsWith(ONE_CLICK_PREFIX)) return null;
  const h = await db.messageHeader.findUnique({ where: { id: contactValue.slice(ONE_CLICK_PREFIX.length) } });
  return h ? oneClickUrl(h) : null;
}

export function headerChannels(headers: UnsubHeader[]): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  const oneClick = headers.find((h) => oneClickUrl(h));
  if (oneClick) out.push({ kind: "ONE_CLICK", value: `${ONE_CLICK_PREFIX}${oneClick.id}`, source: "headers", confidence: "HIGH" });
  const mailto = headers.find((h) => h.listUnsubMailto && /^mailto:[^@\s]+@[^@\s]+/i.test(h.listUnsubMailto));
  if (mailto?.listUnsubMailto) {
    out.push({
      kind: "MAILTO_UNSUB",
      value: mailto.listUnsubMailto,
      source: "headers",
      confidence: mailto.dkimPass && mailto.dkimCoversListUnsub ? "HIGH" : "MEDIUM",
    });
  }
  return out;
}

// ---------- individual steps ----------

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

export type PrivacyTxt = { emails: string[]; urls: string[] };

/** draft-colwell-privacy-txt: `Field: value` lines; emails (bare or mailto:) and https action URLs. */
export function parsePrivacyTxt(text: string): PrivacyTxt {
  const emails = new Set<string>();
  const urls = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.+)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    if (field !== "contact" && !field.startsWith("action-") && field !== "privacy-office") continue;
    const value = m[2].trim();
    const email = value.replace(/^mailto:/i, "").split("?")[0];
    if (EMAIL_RE.test(email)) emails.add(email.toLowerCase());
    else if (/^https:\/\//i.test(value)) urls.add(value);
  }
  return { emails: [...emails], urls: [...urls] };
}

async function fetchPrivacyTxt(domain: string): Promise<PrivacyTxt | null> {
  try {
    const res = await safeFetch(`https://${domain}/.well-known/privacy.txt`, { maxBytes: 64 * 1024, headers: { accept: "text/plain" } });
    const type = res.headers.get("content-type") ?? "";
    const text = res.text();
    if (!res.ok || /html/i.test(type) || /^\s*</.test(text)) return null;
    return parsePrivacyTxt(text);
  } catch {
    return null;
  }
}

/** MX check: null MX (RFC 7505 ".") or no records → false; lookup error → null (unknown). */
export async function hasMx(domain: string): Promise<boolean | null> {
  try {
    const mx = await resolveMx(domain);
    return mx.some((r) => r.exchange && r.exchange !== ".");
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code === "ENODATA" || code === "ENOTFOUND" ? false : null;
  }
}

const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|bounces?|postmaster|notifications?|news(letter)?|marketing|info-?noreply)([+._-]|$)/i;

async function senderSupportAddress(companyId: string, domains: Set<string>): Promise<string | null> {
  const senders = await db.sender.findMany({ where: { companyId, isPersonal: false }, select: { id: true } });
  if (!senders.length) return null;
  const rows = await db.messageHeader.groupBy({
    by: ["fromAddress"],
    where: { senderId: { in: senders.map((s) => s.id) }, isPersonal: false },
    _count: { _all: true },
  });
  const ranked = rows
    .filter((r) => {
      const addr = r.fromAddress.toLowerCase();
      const d = registrableDomain(addr);
      return EMAIL_RE.test(addr) && !NO_REPLY.test(addr.split("@")[0]) && domains.has(d) && !isFreemailDomain(d);
    })
    .sort((a, b) => b._count._all - a._count._all || a.fromAddress.localeCompare(b.fromAddress));
  return ranked[0]?.fromAddress.toLowerCase() ?? null;
}

// ---------- persistence ----------

const norm = (c: { kind: ContactKind; value: string }) => `${c.kind}|${c.value.trim().toLowerCase()}`;

async function saveContacts(companyId: string, found: ContactCandidate[], now: Date): Promise<CompanyContact[]> {
  const unique = new Map<string, ContactCandidate>();
  for (const c of found) if (!unique.has(norm(c))) unique.set(norm(c), c);
  await db.$transaction(async (tx) => {
    const existing = await tx.companyContact.findMany({ where: { companyId } });
    const byKey = new Map(existing.map((e) => [norm(e), e]));
    for (const [key, c] of unique) {
      const e = byKey.get(key);
      if (e?.ownerConfirmed) {
        // The owner's word stands; just record that we saw it again.
        await tx.companyContact.update({ where: { id: e.id }, data: { lastVerifiedAt: now, mxOk: c.mxOk ?? e.mxOk } });
      } else if (e) {
        await tx.companyContact.update({
          where: { id: e.id },
          data: { source: c.source, confidence: c.confidence, mxOk: c.mxOk ?? null, portalVendor: c.portalVendor ?? null, lastVerifiedAt: now },
        });
      } else {
        await tx.companyContact.create({
          data: {
            companyId,
            kind: c.kind,
            value: c.value.trim(),
            source: c.source,
            confidence: c.confidence,
            mxOk: c.mxOk ?? null,
            portalVendor: c.portalVendor ?? null,
            lastVerifiedAt: now,
            ownerConfirmed: false,
          },
        });
      }
    }
    const stale = existing.filter((e) => !e.ownerConfirmed && !unique.has(norm(e))).map((e) => e.id);
    if (stale.length) await tx.companyContact.deleteMany({ where: { id: { in: stale } } });
  });
  return db.companyContact.findMany({ where: { companyId }, orderBy: [{ kind: "asc" }, { confidence: "asc" }, { value: "asc" }] });
}

// ---------- the cascade ----------

/** Enrich one company. Results are cached for 30 days (Company.enrichedAt) unless `force`. */
export async function enrichCompany(companyId: string, opts: { force?: boolean; now?: Date } = {}): Promise<EnrichResult> {
  const now = opts.now ?? new Date();
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId } });
  const domain = company.primaryDomain.toLowerCase();

  if (!opts.force && company.enrichedAt && now.getTime() - company.enrichedAt.getTime() < ENRICH_TTL_MS) {
    const contacts = await db.companyContact.findMany({ where: { companyId } });
    const facts = ((company.jurisdiction as { facts?: Fact[] } | null)?.facts ?? []) as Fact[];
    return { companyId, domain, cached: true, steps: [], settledBy: null, contacts, facts };
  }

  const aliases = await db.companyDomain.findMany({ where: { companyId }, select: { domain: true } });
  const domains = new Set([domain, ...aliases.map((a) => a.domain.toLowerCase())]);
  const found: ContactCandidate[] = [];
  const facts: Fact[] = [];
  const steps: string[] = [];
  const checkedSources = new Set<string>(["domain"]);
  let settledBy: string | null = null;
  const settle = (step: string) => {
    if (!settledBy && found.some((c) => PRIVACY_KINDS.has(c.kind))) settledBy = step;
  };

  if (/\.sa$/.test(domain)) facts.push({ key: "ksa_presence", value: "tld", confidence: "HIGH", source: "domain" });

  // 1. Owner override.
  steps.push("override");
  const confirmed = await db.companyContact.findMany({ where: { companyId, ownerConfirmed: true } });
  if (confirmed.some((c) => PRIVACY_KINDS.has(c.kind))) settledBy = "override";

  // 2. datarequests.org (local snapshot; always read for its jurisdiction facts).
  steps.push("datarequests");
  checkedSources.add("datarequests");
  let dr: Awaited<ReturnType<typeof lookupDatarequests>> = null;
  for (const d of domains) if ((dr = await lookupDatarequests(d))) break;
  if (dr) {
    if (dr.relevantCountries.length) facts.push({ key: "relevant_countries", value: dr.relevantCountries, confidence: "HIGH", source: "datarequests" });
    const cc = addressCountry(dr.address);
    if (cc) {
      facts.push({ key: "hq_country", value: cc, confidence: "MEDIUM", source: "datarequests" });
      if (cc === "SA") facts.push({ key: "ksa_presence", value: "address", confidence: "MEDIUM", source: "datarequests" });
    }
    if (!settledBy) {
      if (dr.email && EMAIL_RE.test(dr.email)) found.push({ kind: "PRIVACY_EMAIL", value: dr.email, source: "datarequests", confidence: "HIGH" });
      if (dr.webform && /^https:\/\//i.test(dr.webform)) {
        found.push({ kind: "WEB_FORM", value: dr.webform, source: "datarequests", confidence: "HIGH", portalVendor: portalVendorFor(dr.webform)?.vendor ?? null });
      }
      settle("datarequests");
    }
  }

  // 3. JustDeleteMe: an account-deletion link (never settles the privacy channel).
  steps.push("justdeleteme");
  let jdm: Awaited<ReturnType<typeof lookupJdm>> = null;
  for (const d of domains) if ((jdm = await lookupJdm(d))) break;
  if (jdm) found.push({ kind: "ACCOUNT_DELETE_URL", value: jdm.url, source: "justdeleteme", confidence: "MEDIUM" });

  // 4. /.well-known/privacy.txt
  if (!settledBy) {
    steps.push("privacy.txt");
    const txt = await fetchPrivacyTxt(domain);
    for (const e of txt?.emails ?? []) found.push({ kind: "PRIVACY_EMAIL", value: e, source: "privacy.txt", confidence: "HIGH" });
    for (const u of txt?.urls ?? []) found.push({ kind: "WEB_FORM", value: u, source: "privacy.txt", confidence: "HIGH", portalVendor: portalVendorFor(u)?.vendor ?? null });
    settle("privacy.txt");
  }

  // 5. Privacy-policy page. Also run for its jurisdiction facts when nothing else supplied any.
  if (!settledBy || !dr) {
    steps.push("policy");
    checkedSources.add("homepage").add("policy").add("llm_policy");
    const p = await discoverPolicy(domain);
    if (p.arabicSite) facts.push({ key: "ksa_presence", value: "arabic_site", confidence: "MEDIUM", source: "homepage" });
    if (p.analysis && p.policyUrl) {
      facts.push(...policyFacts(p.analysis.text));
      if (!settledBy) {
        for (const e of p.analysis.emails) found.push({ kind: "PRIVACY_EMAIL", value: e.address, source: "policy", confidence: "MEDIUM" });
        for (const m of p.analysis.portals) found.push({ kind: "WEB_FORM", value: m.url, source: "policy", confidence: "MEDIUM", portalVendor: m.vendor });
        settle("policy");
      }
      // LLM only in AI mode (gate checked inside), and only when the regex pass found nothing.
      if (!settledBy) {
        const llm = await llmExtractContacts(registrableDomain(domain), p.policyUrl, p.analysis);
        if (llm) {
          for (const e of llm.emails) found.push({ kind: "PRIVACY_EMAIL", value: e, source: "llm_policy", confidence: "MEDIUM" });
          for (const u of llm.webForms) found.push({ kind: "WEB_FORM", value: u, source: "llm_policy", confidence: "MEDIUM", portalVendor: portalVendorFor(u)?.vendor ?? null });
          if (llm.controllerCountry) facts.push({ key: "hq_country", value: llm.controllerCountry, confidence: "LOW", source: "llm_policy" });
          settle("llm_policy");
        }
      }
    }
  }

  // 6. Guess privacy@ then dpo@, only if the domain accepts mail. LOW; the owner must confirm.
  if (!settledBy) {
    steps.push("guess");
    const mx = await hasMx(domain);
    if (mx) {
      for (const local of ["privacy", "dpo"]) {
        found.push({ kind: "PRIVACY_EMAIL", value: `${local}@${domain}`, source: "guess", confidence: "LOW", mxOk: true });
      }
    }
  }

  // 7. Last resort: the address the company itself mails from (not no-reply).
  if (!settledBy && !found.some((c) => c.kind === "PRIVACY_EMAIL")) {
    steps.push("sender");
    const support = await senderSupportAddress(companyId, domains);
    if (support) found.push({ kind: "SUPPORT_EMAIL", value: support, source: "sender", confidence: "LOW" });
  }

  // Unsubscribe channels from the headers we already hold.
  steps.push("headers");
  const senders = await db.sender.findMany({ where: { companyId }, select: { id: true } });
  if (senders.length) {
    const rows = await db.messageHeader.findMany({
      where: { senderId: { in: senders.map((s) => s.id) }, OR: [{ listUnsubHttpsCipher: { not: null } }, { listUnsubMailto: { not: null } }] },
      orderBy: { receivedAt: "desc" },
      take: 100,
      select: { id: true, listUnsubHttpsCipher: true, listUnsubMailto: true, oneClick: true, dkimPass: true, dkimCoversListUnsub: true },
    });
    found.push(...headerChannels(rows));
  }

  const contacts = await saveContacts(companyId, found, now);
  const fresh = dedupeFacts(facts);
  await db.company.update({
    where: { id: companyId },
    data: { enrichedAt: now, jurisdiction: mergeJurisdiction(company.jurisdiction, fresh, [...checkedSources]) as Prisma.InputJsonValue },
  });
  logger.info({ companyId, steps: steps.length, settledBy, contacts: contacts.length }, "company enriched");
  return { companyId, domain, cached: false, steps, settledBy, contacts, facts: fresh };
}

// ---------- job entry + coverage ----------

/**
 * Job-friendly batch: companies never enriched or older than 30 days, decided (REMOVE/UNSUBSCRIBE) first,
 * then undecided. KEEP companies are skipped (no request will go to them).
 */
export async function enrichPending(opts: { limit?: number; now?: Date } = {}): Promise<{ enriched: number; failed: number; ids: string[] }> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 25;
  const stale = { OR: [{ enrichedAt: null }, { enrichedAt: { lt: new Date(now.getTime() - ENRICH_TTL_MS) } }] };
  const decided = await db.company.findMany({
    where: { ...stale, decision: { in: ["REMOVE", "UNSUBSCRIBE"] } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  const rest =
    decided.length < limit
      ? await db.company.findMany({
          where: { ...stale, decision: null },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: limit - decided.length,
          select: { id: true },
        })
      : [];
  let enriched = 0;
  let failed = 0;
  const ids: string[] = [];
  for (const { id } of [...decided, ...rest]) {
    try {
      await enrichCompany(id, { now });
      enriched++;
      ids.push(id);
    } catch (err) {
      failed++;
      logger.warn({ companyId: id, err: (err as Error).name }, "enrich failed");
    }
  }
  return { enriched, failed, ids };
}

export type CoverageReport = {
  decided: number;
  covered: number;
  /** covered / decided, 0..1 (0 when nothing is decided). */
  share: number;
  notEnriched: number;
  byDecision: Record<"REMOVE" | "UNSUBSCRIBE", { decided: number; covered: number }>;
  /** .sa / KSA companies whose only privacy channel is a guess or the sender's support address. */
  ksaGuessFallbacks: { companyId: string; name: string; domain: string; decision: string | null; contacts: string[] }[];
};

const STRONG: Confidence[] = ["HIGH", "MEDIUM"];

/**
 * Share of decided companies with a usable MEDIUM/HIGH (or owner-confirmed) contact. REMOVE needs a
 * privacy channel (PRIVACY_EMAIL / WEB_FORM); UNSUBSCRIBE also accepts ONE_CLICK / MAILTO_UNSUB.
 */
export async function coverageReport(): Promise<CoverageReport> {
  const companies = await db.company.findMany({ select: { id: true, name: true, primaryDomain: true, decision: true, enrichedAt: true, jurisdiction: true } });
  const contacts = await db.companyContact.findMany();
  const byCompany = new Map<string, CompanyContact[]>();
  for (const c of contacts) byCompany.set(c.companyId, [...(byCompany.get(c.companyId) ?? []), c]);
  const strong = (c: CompanyContact) => c.ownerConfirmed || STRONG.includes(c.confidence);

  const report: CoverageReport = {
    decided: 0,
    covered: 0,
    share: 0,
    notEnriched: 0,
    byDecision: { REMOVE: { decided: 0, covered: 0 }, UNSUBSCRIBE: { decided: 0, covered: 0 } },
    ksaGuessFallbacks: [],
  };
  for (const co of companies) {
    const list = byCompany.get(co.id) ?? [];
    if (co.decision === "REMOVE" || co.decision === "UNSUBSCRIBE") {
      const kinds: ContactKind[] = co.decision === "REMOVE" ? ["PRIVACY_EMAIL", "WEB_FORM"] : ["PRIVACY_EMAIL", "WEB_FORM", "ONE_CLICK", "MAILTO_UNSUB"];
      const ok = list.some((c) => kinds.includes(c.kind) && strong(c));
      report.decided++;
      report.byDecision[co.decision].decided++;
      if (ok) {
        report.covered++;
        report.byDecision[co.decision].covered++;
      }
      if (!co.enrichedAt) report.notEnriched++;
    }
    const facts = ((co.jurisdiction as { facts?: Fact[] } | null)?.facts ?? []) as Fact[];
    const ksa = /\.sa$/.test(co.primaryDomain) || facts.some((f) => f.key === "ksa_presence");
    if (!ksa || !co.enrichedAt) continue;
    const hasStrongPrivacy = list.some((c) => PRIVACY_KINDS.has(c.kind) && strong(c));
    const fallbacks = list.filter((c) => c.source === "guess" || c.source === "sender");
    if (!hasStrongPrivacy && (fallbacks.length || !list.some((c) => PRIVACY_KINDS.has(c.kind)))) {
      report.ksaGuessFallbacks.push({
        companyId: co.id,
        name: co.name,
        domain: co.primaryDomain,
        decision: co.decision,
        contacts: fallbacks.map((c) => c.value),
      });
    }
  }
  report.share = report.decided ? report.covered / report.decided : 0;
  return report;
}
