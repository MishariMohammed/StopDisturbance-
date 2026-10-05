import type { Classification, Confidence, MessageHeader } from "@prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { resolveBrand, signalsFromRow } from "@/lib/scan/resolve";
import {
  detectEsp,
  hasListHeaders,
  isAutoSubmitted,
  isJunk,
  isPromoSubject,
  isTransactionalSubject,
  messageClass,
  type HeaderSignals,
} from "@/lib/scan/signals";

// Stage 3 — rules classifier (02-capabilities §3.4, 04-ux §5.5 confidence).

export type Label = "ads" | "holds_data" | "personal";

/** Strong marketing signals: any one settles `ads`. */
export const AD_RULES = [
  "ONE_CLICK", "LIST_UNSUB", "LIST_ID", "FEEDBACK_ID", "PRECEDENCE_BULK", "GMAIL_PROMOTIONS", "ESP_MARKETING", "PROMO_SUBJECT",
] as const;
/** Strong transactional / account signals: any one settles `holds_data`. */
export const DATA_RULES = ["TXN_SUBJECT", "AUTO_SUBMITTED", "GMAIL_UPDATES", "TXN_ESP"] as const;
/** Weak signals: add confidence to a settled label but never settle a sender alone. */
export const WEAK_AD_RULES = ["OUTLOOK_OTHER"] as const;
export const WEAK_DATA_RULES = ["NO_LIST_HEADERS"] as const;

export type RuleId =
  | (typeof AD_RULES)[number]
  | (typeof DATA_RULES)[number]
  | (typeof WEAK_AD_RULES)[number]
  | (typeof WEAK_DATA_RULES)[number]
  | "AGG_MARKETING"
  | "AGG_TRANSACTIONAL";

export type SenderProfile = {
  isPersonal: boolean;
  marketingCount: number;
  transactionalCount: number;
  hasOneClick: boolean;
  /** Distinct rule ids seen across the sender's (non-personal) headers. Empty once headers are purged. */
  signals: ReadonlySet<RuleId>;
  headerCount: number;
  /** The brand came only from a display-name match (04 §5.5: "fuzzy name match" = Low). */
  fuzzyBrand: boolean;
};

export type RulesResult = { labels: Label[]; ruleIds: string[]; confidence: Confidence; settled: boolean };

/**
 * Rule ids one message contributes. Marketing rules count only on messages classed as marketing and
 * transactional rules only on transactional ones (Feedback-ID on an SES receipt is bulk, not an ad).
 */
export function messageRules(h: HeaderSignals): RuleId[] {
  const esp = detectEsp(h);
  const cls = messageClass(h, esp);
  const list = hasListHeaders(h);
  const out: RuleId[] = [];
  if (h.oneClick) out.push("ONE_CLICK");
  if (h.hasListUnsub) out.push("LIST_UNSUB");
  if (h.listId) out.push("LIST_ID");
  if (h.feedbackId) out.push("FEEDBACK_ID");
  if (h.precedence && ["bulk", "list", "junk"].includes(h.precedence)) out.push("PRECEDENCE_BULK");
  if (h.labels.includes("CATEGORY_PROMOTIONS")) out.push("GMAIL_PROMOTIONS");
  if (h.labels.includes("OTHER")) out.push("OUTLOOK_OTHER");
  if (esp?.kind === "marketing") out.push("ESP_MARKETING");
  if (isPromoSubject(h.subject)) out.push("PROMO_SUBJECT");
  if (isTransactionalSubject(h.subject)) out.push("TXN_SUBJECT");
  if (isAutoSubmitted(h)) out.push("AUTO_SUBMITTED");
  if (h.labels.includes("CATEGORY_UPDATES") && !list) out.push("GMAIL_UPDATES");
  if (esp?.kind === "transactional" && !list) out.push("TXN_ESP");
  if (!list) out.push("NO_LIST_HEADERS");
  return out.filter(
    (r) =>
      !((AD_RULES as readonly string[]).includes(r) && !cls.isMarketing) &&
      !((DATA_RULES as readonly string[]).includes(r) && !cls.isTransactional),
  );
}

function level(n: number): Confidence {
  return n >= 3 ? "HIGH" : n === 2 ? "MEDIUM" : "LOW";
}

const RANK: Record<Confidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export const maxConfidence = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);
export const minConfidence = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);

/** Pure rules classifier over a sender's aggregate profile. */
export function classifyProfile(p: SenderProfile): RulesResult {
  if (p.isPersonal) return { labels: ["personal"], ruleIds: ["PERSONAL_FILTER"], confidence: "HIGH", settled: true };

  const has = (ids: readonly string[]) => ids.filter((id) => p.signals.has(id as RuleId));
  let ad: string[] = has(AD_RULES);
  let data: string[] = has(DATA_RULES);

  // Headers already purged (90-day retention): fall back to the stored counts.
  if (p.headerCount === 0) {
    if (p.hasOneClick) ad.push("ONE_CLICK");
    if (p.marketingCount > 0) ad.push("AGG_MARKETING");
    if (p.transactionalCount > 0) data.push("AGG_TRANSACTIONAL");
  }
  if (ad.length) ad = [...ad, ...has(WEAK_AD_RULES)];
  if (data.length) data = [...data, ...has(WEAK_DATA_RULES)];

  const labels: Label[] = [];
  if (ad.length) labels.push("ads");
  if (data.length) labels.push("holds_data");
  if (!labels.length) {
    const weak = has([...WEAK_AD_RULES, ...WEAK_DATA_RULES]);
    return { labels: [], ruleIds: ["UNSETTLED", ...weak], confidence: "LOW", settled: false };
  }
  // High = 3+ independent signals agree, Medium = 2, Low = 1 or a fuzzy name match.
  let confidence = level(Math.max(ad.length, data.length));
  if (p.fuzzyBrand) confidence = "LOW";
  return { labels, ruleIds: [...new Set([...ad, ...data])], confidence, settled: true };
}

// ---------- DB step ----------

export async function senderHeaders(senderId: string): Promise<MessageHeader[]> {
  return db.messageHeader.findMany({ where: { senderId, isPersonal: false } });
}

export async function senderProfile(senderId: string): Promise<SenderProfile> {
  const sender = await db.sender.findUniqueOrThrow({ where: { id: senderId } });
  const headers = sender.isPersonal ? [] : await senderHeaders(senderId);
  const signals = new Set<RuleId>();
  let direct = false;
  for (const row of headers) {
    const h = signalsFromRow(row);
    messageRules(h).forEach((r) => signals.add(r));
    if (!direct && resolveBrand(h)?.domain === sender.registrableDomain) direct = true;
  }
  return {
    isPersonal: sender.isPersonal,
    marketingCount: sender.marketingCount,
    transactionalCount: sender.transactionalCount,
    hasOneClick: sender.hasOneClick,
    signals,
    headerCount: headers.length,
    fuzzyBrand: Boolean(sender.companyId) && headers.length > 0 && !direct,
  };
}

export const isUnsettled = (c: Pick<Classification, "method" | "ruleIds">) =>
  c.method === "RULES" && c.ruleIds.includes("UNSETTLED");

/** Runs the rules over the given senders (default: all) and refreshes the affected companies. */
export async function classifySenders(senderIds?: string[]) {
  const senders = await db.sender.findMany({
    where: senderIds ? { id: { in: senderIds } } : {},
    select: { id: true, companyId: true },
  });
  let unsettled = 0;
  const companies = new Set<string>();
  for (const s of senders) {
    const r = classifyProfile(await senderProfile(s.id));
    if (!r.settled) unsettled++;
    await db.classification.deleteMany({ where: { senderId: s.id, method: "RULES" } });
    await db.classification.create({
      data: { senderId: s.id, companyId: s.companyId, method: "RULES", labels: r.labels, ruleIds: r.ruleIds, confidence: r.confidence },
    });
    if (s.companyId) companies.add(s.companyId);
  }
  for (const id of companies) await refreshCompanyFlags(id);
  logger.info({ senders: senders.length, unsettled }, "classify (rules) done");
  return { senders: senders.length, unsettled, companies: companies.size };
}

/**
 * Company.sendsAds / holdsData / confidence from its senders' classifications.
 * Per sender: RULES unless unsettled, then the latest LLM suggestion. A MANUAL classification on
 * the company or any of its senders freezes the flags (owner edits are never overridden).
 */
export async function refreshCompanyFlags(companyId: string) {
  const senders = await db.sender.findMany({ where: { companyId, isPersonal: false }, select: { id: true } });
  const senderIds = senders.map((s) => s.id);
  const cls = await db.classification.findMany({
    where: { OR: [{ companyId }, { senderId: { in: senderIds } }] },
    orderBy: { createdAt: "desc" },
  });
  if (cls.some((c) => c.method === "MANUAL")) return;

  let sendsAds = false;
  let holdsData = false;
  let confidence: Confidence | null = null;
  for (const id of senderIds) {
    const mine = cls.filter((c) => c.senderId === id);
    const rules = mine.find((c) => c.method === "RULES");
    const llm = mine.find((c) => c.method === "LLM");
    const pick = rules && !isUnsettled(rules) ? rules : (llm ?? null);
    if (!pick) continue;
    sendsAds ||= pick.labels.includes("ads");
    holdsData ||= pick.labels.includes("holds_data");
    if (pick.labels.some((l) => l === "ads" || l === "holds_data")) {
      confidence = confidence ? maxConfidence(confidence, pick.confidence) : pick.confidence;
    }
  }
  await db.company.update({ where: { id: companyId }, data: { sendsAds, holdsData, confidence: confidence ?? "LOW" } });
}

// ---------- flags for the LLM payload (00-brief §8) ----------

export type SenderFlags = {
  listUnsub: boolean;
  oneClick: boolean;
  listId: boolean;
  feedbackId: boolean;
  esp: string | null;
  gmailCategory: "PROMOTIONS" | "UPDATES" | "SOCIAL" | "FORUMS" | "PERSONAL" | null;
  outlookFocused: boolean | null;
  junk: boolean;
  precedence: "bulk" | "list" | "junk" | null;
  autoSubmitted: boolean;
};

const CATEGORIES = ["PROMOTIONS", "UPDATES", "SOCIAL", "FORUMS", "PERSONAL"] as const;

/** Header flags aggregated over a sender's headers (presence only: no header values). */
export function aggregateFlags(rows: (HeaderSignals & { esp?: string | null })[]): SenderFlags {
  const cat = new Map<SenderFlags["gmailCategory"], number>();
  let focused = 0;
  let other = 0;
  const f: SenderFlags = {
    listUnsub: false, oneClick: false, listId: false, feedbackId: false, esp: null, gmailCategory: null,
    outlookFocused: null, junk: false, precedence: null, autoSubmitted: false,
  };
  for (const h of rows) {
    f.listUnsub ||= h.hasListUnsub;
    f.oneClick ||= h.oneClick;
    f.listId ||= Boolean(h.listId);
    f.feedbackId ||= Boolean(h.feedbackId);
    f.esp ??= h.esp ?? detectEsp(h)?.name ?? null;
    f.junk ||= isJunk(h);
    f.autoSubmitted ||= isAutoSubmitted(h);
    if (!f.precedence && (h.precedence === "bulk" || h.precedence === "list" || h.precedence === "junk")) f.precedence = h.precedence;
    for (const c of CATEGORIES) if (h.labels.includes(`CATEGORY_${c}`)) cat.set(c, (cat.get(c) ?? 0) + 1);
    if (h.labels.includes("FOCUSED")) focused++;
    if (h.labels.includes("OTHER")) other++;
  }
  let best = 0;
  for (const [c, n] of cat) if (n > best) [f.gmailCategory, best] = [c, n];
  if (focused || other) f.outlookFocused = focused >= other;
  return f;
}
