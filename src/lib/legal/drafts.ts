import { createHash, randomInt } from "node:crypto";
import type { CompanyContact, Prisma, RequestType } from "@prisma/client";
import { db } from "@/lib/db";
import { isEmailAddress } from "@/lib/email-address";
import { addCalendarDays, DEADLINE_TZ } from "@/lib/deadlines";
import { decideJurisdiction, factsFromJson, type JurisdictionDecision, type JurisdictionFact } from "@/lib/legal/jurisdiction";
import { findBannedPhrases, renderTemplate, TemplateError, type TemplateId } from "@/lib/legal/render";

// Stage 6 Draft + stage 7 Approve (00-brief §5). Letters are filled from local templates only (00-review D12).

export const ARABIC_REVIEWED_KEY = "arabicTemplatesReviewed";
export const UNDO_WINDOW_MS = 10_000;

/** OutboundMessage.kind values written here (the dispatcher must never send WEB_FORM_COPY). */
export type OutboundKind = "INITIAL" | "UNSUB_MAILTO" | "ONE_CLICK_POST" | "WEB_FORM_COPY";

export class DraftError extends Error {
  constructor(
    public code:
      | "not_found" | "bad_status" | "not_approved" | "already_sent" | "missing_recipient" | "recipient_unconfirmed"
      | "unfilled" | "banned_phrase" | "not_sendable" | "owner_incomplete" | "invalid_recipient",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DraftError";
  }
}

// ---------- Small pure helpers ----------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newReference(): string {
  let s = "SD-";
  for (let i = 0; i < 4; i++) s += CROCKFORD[randomInt(32)];
  return s;
}

/** sha256(to + subject + body); fields are newline-joined so boundaries are unambiguous. */
export function computeDraftHash(to: string | null, subject: string | null, body: string | null): string {
  return createHash("sha256").update(`${to ?? ""}\n${subject ?? ""}\n${body ?? ""}`).digest("hex");
}

export function formatLetterDate(d: Date, lang: "en" | "ar"): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric", timeZone: DEADLINE_TZ };
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "ar-u-nu-latn", opts).format(d);
}

export function formatHijriDate(d: Date): string {
  return new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura-nu-latn", {
    day: "numeric", month: "long", year: "numeric", timeZone: DEADLINE_TZ,
  }).format(d);
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames("en", { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Parse a List-Unsubscribe mailto (RFC 6068) or a bare address. */
export function parseMailto(value: string): { to: string; subject: string | null; body: string | null } {
  const v = value.trim().replace(/^<|>$/g, "");
  if (!/^mailto:/i.test(v)) return { to: v, subject: null, body: null };
  const [addr, query = ""] = v.slice(7).split("?", 2);
  const q = new URLSearchParams(query);
  return { to: decodeURIComponent(addr), subject: q.get("subject"), body: q.get("body") };
}

const CONF_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
const usable = (c: CompanyContact) => c.confidence !== "LOW" || c.ownerConfirmed;
const byQuality = (a: CompanyContact, b: CompanyContact) =>
  Number(b.ownerConfirmed) - Number(a.ownerConfirmed) ||
  CONF_RANK[b.confidence] - CONF_RANK[a.confidence] ||
  b.lastVerifiedAt.getTime() - a.lastVerifiedAt.getTime();

type Channel =
  | { kind: "EMAIL"; contact: CompanyContact }
  | { kind: "WEB_FORM"; contact: CompanyContact }
  | { kind: "ONE_CLICK"; contact: CompanyContact }
  | { kind: "MAILTO"; contact: CompanyContact };

/**
 * Letter channel order (03 S2 + 00-brief stage 4 cascade): confirmed/MEDIUM+ privacy email → web form →
 * MEDIUM+ support email → LOW guesses (need owner confirmation before approval).
 */
function letterChannel(contacts: CompanyContact[], allowAccountDelete: boolean): Channel | null {
  const of = (k: CompanyContact["kind"]) => contacts.filter((c) => c.kind === k).sort(byQuality);
  const privacy = of("PRIVACY_EMAIL");
  const support = of("SUPPORT_EMAIL");
  const forms = [...of("WEB_FORM"), ...(allowAccountDelete ? of("ACCOUNT_DELETE_URL") : [])];
  const goodPrivacy = privacy.find(usable);
  if (goodPrivacy) return { kind: "EMAIL", contact: goodPrivacy };
  if (forms[0]) return { kind: "WEB_FORM", contact: forms[0] };
  const goodSupport = support.find(usable);
  if (goodSupport) return { kind: "EMAIL", contact: goodSupport };
  const guess = privacy[0] ?? support[0];
  return guess ? { kind: "EMAIL", contact: guess } : null;
}

/** Channels per decision (00-brief §5 stage 6). */
export function planChannels(decision: "REMOVE" | "UNSUBSCRIBE", contacts: CompanyContact[]): Channel[] {
  const oneClick = contacts.filter((c) => c.kind === "ONE_CLICK").sort(byQuality)[0];
  if (decision === "REMOVE") {
    const letter = letterChannel(contacts, true);
    const out: Channel[] = letter ? [letter] : [];
    if (oneClick) out.push({ kind: "ONE_CLICK", contact: oneClick });
    return out;
  }
  if (oneClick) return [{ kind: "ONE_CLICK", contact: oneClick }];
  const mailto = contacts.filter((c) => c.kind === "MAILTO_UNSUB").sort(byQuality)[0];
  if (mailto) return [{ kind: "MAILTO", contact: mailto }];
  const letter = letterChannel(contacts, false);
  return letter ? [letter] : [];
}

// ---------- Mailboxes ----------

async function companyMailboxes(companyId: string) {
  const senders = await db.sender.findMany({ where: { companyId }, select: { id: true, accountIds: true, msgCount: true } });
  const ids = [...new Set(senders.flatMap((s) => s.accountIds))];
  if (!ids.length) return null;
  const accounts = await db.mailAccount.findMany({ where: { id: { in: ids } }, select: { id: true, address: true, status: true } });
  if (!accounts.length) return null;
  const headerCounts = await db.messageHeader.groupBy({
    by: ["accountId"],
    where: { senderId: { in: senders.map((s) => s.id) } },
    _count: { _all: true },
  });
  const hc = new Map(headerCounts.map((r) => [r.accountId, r._count._all]));
  const aggregate = (id: string) => senders.filter((s) => s.accountIds.includes(id)).reduce((n, s) => n + s.msgCount, 0);
  const ranked = [...accounts].sort(
    (a, b) =>
      Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE") ||
      (hc.get(b.id) ?? 0) - (hc.get(a.id) ?? 0) ||
      aggregate(b.id) - aggregate(a.id) ||
      a.address.localeCompare(b.address),
  );
  return { sending: ranked[0], addresses: ranked.map((a) => a.address) };
}

// ---------- Rendering ----------

export interface LetterContext {
  fullName: string;
  countryOfResidence: string;
  company: string;
  companyContact: string;
  emailAddresses: string[];
  reference: string;
  jurisdiction: JurisdictionDecision;
  now: Date;
}

export function letterValues(ctx: LetterContext, lang: "en" | "ar"): Record<string, string> {
  return {
    full_name: ctx.fullName,
    country_of_residence: ctx.countryOfResidence,
    company: ctx.company,
    company_contact: ctx.companyContact,
    email_addresses: ctx.emailAddresses.join(", "),
    reference_id: ctx.reference,
    law_citations: ctx.jurisdiction.citationsText(lang),
    law_citations_extra: ctx.jurisdiction.extraCitationsText("ar"),
    response_days: String(ctx.jurisdiction.deadlineDays),
    deadline_date: formatLetterDate(addCalendarDays(ctx.now, ctx.jurisdiction.deadlineDays), lang),
    date: formatLetterDate(ctx.now, lang),
    date_hijri: formatHijriDate(ctx.now),
  };
}

export interface ComposedLetter {
  templateId: TemplateId;
  templateVersion: string;
  language: "en" | "ar+en";
  lawyer: boolean;
  subject: string;
  body: string;
}

const SEPARATOR = "\n----------\n\n";

/** Render a letter in English, or Arabic first + English in one email. */
export function composeLetter(id: "6a" | "6d" | "webform" | "webform-6d", ctx: LetterContext, arabic: boolean): ComposedLetter {
  const en = renderTemplate(id, "en", letterValues(ctx, "en"));
  if (!arabic) {
    return { templateId: id, templateVersion: en.templateVersion, language: "en", lawyer: en.lawyer, subject: en.subject ?? "", body: en.body };
  }
  const ar = renderTemplate(id, "ar", letterValues(ctx, "ar"));
  return {
    templateId: id,
    templateVersion: `${ar.templateVersion}/${en.templateVersion}`,
    language: "ar+en",
    lawyer: ar.lawyer || en.lawyer,
    subject: `${ar.subject} / ${en.subject}`,
    body: `${ar.body.trimEnd()}\n${SEPARATOR}${en.body}`,
  };
}

// ---------- Jurisdiction on the company ----------

/** Stage 5 output: computes the decision and stores lawKeys/regulator/deadlineDays next to the facts. */
export async function applyJurisdiction(companyId: string, now = new Date()): Promise<JurisdictionDecision | null> {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) return null;
  const owner = await db.owner.findFirst();
  const decision = decideJurisdiction(withEmailType(factsFromJson(company.jurisdiction), company.sendsAds), { usState: owner?.usState ?? null }, now);
  const base = company.jurisdiction && typeof company.jurisdiction === "object" && !Array.isArray(company.jurisdiction)
    ? (company.jurisdiction as Record<string, unknown>)
    : {};
  const json = {
    ...base,
    facts: base.facts ?? [],
    lawKeys: decision.lawKeys,
    regulator: decision.regulator,
    regulators: decision.regulators,
    deadlineDays: decision.deadlineDays,
    lowConfidence: decision.lowConfidence,
    fallback: decision.fallback,
    rows: decision.rows,
  } as Prisma.InputJsonValue;
  await db.company.update({ where: { id: companyId }, data: { jurisdiction: json } });
  return decision;
}

/** The classifier's sendsAds flag stands in for email_type when enrichment recorded none. */
function withEmailType(facts: JurisdictionFact[], sendsAds: boolean): JurisdictionFact[] {
  if (facts.some((f) => f.key === "email_type")) return facts;
  return sendsAds ? [...facts, { key: "email_type", value: "marketing", confidence: "MEDIUM", source: "classifier" }] : facts;
}

// ---------- createDrafts ----------

export interface CreatedDraft {
  companyId: string;
  requestId: string;
  outboundId: string;
  reference: string;
  type: RequestType;
  kind: OutboundKind;
  templateId: string;
  language: string;
}

export type SkipReason = "not_found" | "no_decision" | "keep" | "open_request" | "no_mailbox" | "no_contact";

const CLOSED_STATUSES = ["COMPLETED", "REFUSED", "FAILED", "CANCELLED"] as const;

async function uniqueReference(tx: Prisma.TransactionClient): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const ref = newReference();
    if (!(await tx.request.findUnique({ where: { reference: ref }, select: { id: true } }))) return ref;
  }
  throw new Error("Could not allocate a unique reference");
}

export async function createDrafts(
  companyIds: string[],
  opts: { now?: Date } = {},
): Promise<{ created: CreatedDraft[]; skipped: { companyId: string; reason: SkipReason }[] }> {
  const now = opts.now ?? new Date();
  const owner = await db.owner.findFirst();
  if (!owner?.fullName.trim()) throw new DraftError("owner_incomplete", "Owner full name is not set (first-run card)");
  const reviewed = (await db.setting.findUnique({ where: { key: ARABIC_REVIEWED_KEY } }))?.value === true;

  const created: CreatedDraft[] = [];
  const skipped: { companyId: string; reason: SkipReason }[] = [];

  for (const companyId of [...new Set(companyIds)]) {
    const company = await db.company.findUnique({ where: { id: companyId } });
    if (!company) { skipped.push({ companyId, reason: "not_found" }); continue; }
    if (!company.decision) { skipped.push({ companyId, reason: "no_decision" }); continue; }
    if (company.decision === "KEEP") { skipped.push({ companyId, reason: "keep" }); continue; }
    const open = await db.request.findFirst({ where: { companyId, status: { notIn: [...CLOSED_STATUSES] } }, select: { id: true } });
    if (open) { skipped.push({ companyId, reason: "open_request" }); continue; }
    const boxes = await companyMailboxes(companyId);
    if (!boxes) { skipped.push({ companyId, reason: "no_mailbox" }); continue; }
    const contacts = await db.companyContact.findMany({ where: { companyId } });
    const channels = planChannels(company.decision, contacts);
    if (!channels.length) { skipped.push({ companyId, reason: "no_contact" }); continue; }

    const jurisdiction = (await applyJurisdiction(companyId, now))!;
    const arabic = jurisdiction.rows.includes(2) && reviewed;

    for (const ch of channels) {
      const item = await db.$transaction(async (tx) => {
        const reference = await uniqueReference(tx);
        const ctx: LetterContext = {
          fullName: owner.fullName.trim(),
          countryOfResidence: countryName(owner.country),
          company: company.name,
          companyContact: ch.contact.value,
          emailAddresses: boxes.addresses,
          reference,
          jurisdiction,
          now,
        };
        const draft = buildOutbound(ch, company.decision as "REMOVE" | "UNSUBSCRIBE", ctx, arabic);
        const request = await tx.request.create({
          data: {
            companyId,
            mailAccountId: boxes.sending.id,
            type: draft.type,
            status: "DRAFT",
            reference,
            lawKeys: jurisdiction.lawKeys,
            citationsText: jurisdiction.citationsText("en"),
            lowConfidenceWording: jurisdiction.lowConfidence,
          },
        });
        const out = await tx.outboundMessage.create({
          data: {
            requestId: request.id,
            kind: draft.kind,
            templateId: draft.templateId,
            templateVersion: draft.templateVersion,
            language: draft.language,
            toAddress: draft.to,
            subject: draft.subject,
            bodyText: draft.body,
            draftHash: computeDraftHash(draft.to, draft.subject, draft.body),
          },
        });
        const data = {
          outboundId: out.id, kind: draft.kind, templateId: draft.templateId, templateVersion: draft.templateVersion,
          language: draft.language, contactId: ch.contact.id, contactSource: ch.contact.source,
          recipientNeedsConfirmation: !usable(ch.contact), lawKeys: jurisdiction.lawKeys, lawyerFlag: draft.lawyer,
        };
        await tx.requestEvent.create({ data: { requestId: request.id, type: "DRAFT_CREATED", actor: "SYSTEM", data } });
        await tx.auditLog.create({ data: { action: "request.draft_created", entity: "request", entityId: request.id, data } });
        return { companyId, requestId: request.id, outboundId: out.id, reference, type: draft.type, kind: draft.kind, templateId: draft.templateId, language: draft.language };
      });
      created.push(item);
    }
  }
  return { created, skipped };
}

interface OutboundDraft {
  type: RequestType;
  kind: OutboundKind;
  templateId: string;
  templateVersion: string;
  language: string;
  lawyer: boolean;
  to: string | null;
  subject: string | null;
  body: string | null;
}

function buildOutbound(ch: Channel, decision: "REMOVE" | "UNSUBSCRIBE", ctx: LetterContext, arabic: boolean): OutboundDraft {
  if (ch.kind === "ONE_CLICK") {
    return {
      type: "ONE_CLICK", kind: "ONE_CLICK_POST", templateId: "one-click", templateVersion: "rfc8058", language: "en", lawyer: false,
      to: ch.contact.value, subject: null, body: "List-Unsubscribe=One-Click",
    };
  }
  if (ch.kind === "MAILTO") {
    // The list's own subject/body are kept verbatim (list servers parse them); otherwise the subject carries the Ref.
    const m = parseMailto(ch.contact.value);
    const subject = m.subject ?? `Unsubscribe — Ref ${ctx.reference}`;
    const body = m.body ?? `Unsubscribe\n\nRef ${ctx.reference}\n`;
    const banned = findBannedPhrases(`${subject}\n${body}`);
    if (banned.length) throw new TemplateError(`Banned phrase(s) in mailto unsubscribe: ${banned.join(", ")}`);
    return {
      type: "MAILTO_UNSUB", kind: "UNSUB_MAILTO", templateId: "mailto-unsub", templateVersion: "rfc2369", language: "en", lawyer: false,
      to: m.to, subject, body,
    };
  }
  if (ch.kind === "WEB_FORM") {
    const letter = composeLetter(decision === "REMOVE" ? "webform" : "webform-6d", ctx, false);
    return {
      type: "WEB_FORM", kind: "WEB_FORM_COPY", templateId: letter.templateId, templateVersion: letter.templateVersion,
      language: letter.language, lawyer: letter.lawyer, to: ch.contact.value, subject: letter.subject, body: letter.body,
    };
  }
  const id = decision === "REMOVE" ? "6a" : "6d";
  const letter = composeLetter(id, ctx, arabic);
  return {
    type: decision === "REMOVE" ? "ERASURE_OBJECTION" : "STOP_MARKETING", kind: "INITIAL", templateId: letter.templateId,
    templateVersion: letter.templateVersion, language: letter.language, lawyer: letter.lawyer,
    to: parseMailto(ch.contact.value).to, subject: letter.subject, body: letter.body,
  };
}

// ---------- Edit / approve / queue / undo ----------

async function loadItem(outboundId: string) {
  const out = await db.outboundMessage.findUnique({ where: { id: outboundId } });
  if (!out) throw new DraftError("not_found");
  const request = await db.request.findUnique({ where: { id: out.requestId } });
  if (!request) throw new DraftError("not_found");
  return { out, request };
}

const CITATION_MARKERS = ["Personal Data Protection Law", "نظام حماية البيانات الشخصية"];

/** Owner edit. Recomputes draftHash and clears any approval. Returns non-blocking guardrail warnings (04-ux §6.2). */
export async function updateDraft(
  outboundId: string,
  patch: { subject?: string | null; body?: string | null; to?: string | null },
): Promise<{ draftHash: string; warnings: string[] }> {
  const { out, request } = await loadItem(outboundId);
  if (out.sentAt) throw new DraftError("already_sent");
  if (request.status !== "DRAFT" && request.status !== "APPROVED") throw new DraftError("bad_status", `Cannot edit a ${request.status} item`);
  const to = patch.to !== undefined ? patch.to?.trim() || null : out.toAddress;
  // The owner may redirect a letter (e.g. to their own address for a first test send): one valid address.
  if (patch.to !== undefined && to !== null && !isEmailAddress(to)) throw new DraftError("invalid_recipient");
  const subject = patch.subject !== undefined ? patch.subject : out.subject;
  const body = patch.body !== undefined ? patch.body : out.bodyText;
  const draftHash = computeDraftHash(to, subject, body);
  const all = `${subject ?? ""}\n${body ?? ""}`;
  const warnings: string[] = [];
  if (findBannedPhrases(all).length) warnings.push("banned_phrase");
  if (all.includes("{{")) warnings.push("unfilled_placeholder");
  if (out.kind === "INITIAL" && !CITATION_MARKERS.some((m) => all.includes(m))) warnings.push("citation_removed");
  if (out.kind === "INITIAL" && !subject?.includes(request.reference)) warnings.push("reference_removed");
  if (/\b\d{10}\b/.test(all)) warnings.push("possible_id_number");

  await db.$transaction(async (tx) => {
    await tx.outboundMessage.update({ where: { id: out.id }, data: { toAddress: to, subject, bodyText: body, draftHash, approvedHash: null, approvedAt: null } });
    if (request.status === "APPROVED") await tx.request.update({ where: { id: request.id }, data: { status: "DRAFT" } });
    const data = { outboundId, draftHash, approvalCleared: out.approvedHash !== null, warnings, fields: Object.keys(patch) };
    await tx.requestEvent.create({ data: { requestId: request.id, type: "DRAFT_EDITED", actor: "OWNER", data } });
    await tx.auditLog.create({ data: { action: "request.draft_edited", entity: "request", entityId: request.id, data } });
  });
  return { draftHash, warnings };
}

/** Per-item approval (03 M4): approvedHash = draftHash, logged with the hash. */
export async function approveDraft(outboundId: string, now = new Date()): Promise<{ approvedHash: string }> {
  const { out, request } = await loadItem(outboundId);
  if (out.sentAt) throw new DraftError("already_sent");
  if (request.status === "APPROVED" && out.approvedHash === out.draftHash) return { approvedHash: out.draftHash };
  if (request.status !== "DRAFT") throw new DraftError("bad_status", `Cannot approve a ${request.status} item`);
  if (!out.toAddress) throw new DraftError("missing_recipient");
  const all = `${out.subject ?? ""}\n${out.bodyText ?? ""}`;
  if (all.includes("{{") || all.includes("}}")) throw new DraftError("unfilled");
  const banned = findBannedPhrases(all);
  if (banned.length) throw new DraftError("banned_phrase", `Remove: ${banned.join(", ")}`);
  if (out.kind === "INITIAL") {
    const matches = await db.companyContact.findMany({ where: { companyId: request.companyId, value: { in: [out.toAddress, `mailto:${out.toAddress}`] } } });
    if (matches.length && !matches.some(usable)) throw new DraftError("recipient_unconfirmed", "Confirm the guessed recipient first");
  }
  await db.$transaction(async (tx) => {
    await tx.outboundMessage.update({ where: { id: out.id }, data: { approvedHash: out.draftHash, approvedAt: now } });
    await tx.request.update({ where: { id: request.id }, data: { status: "APPROVED" } });
    const data = { outboundId, draftHash: out.draftHash, approvedAt: now.toISOString() };
    await tx.requestEvent.create({ data: { requestId: request.id, type: "APPROVED", actor: "OWNER", at: now, data } });
    await tx.auditLog.create({ data: { action: "request.approved", entity: "request", entityId: request.id, at: now, data } });
  });
  return { approvedHash: out.draftHash };
}

/** Send confirmation (04-ux §6.5): QUEUED with a 10 s undo window. */
export async function queueApproved(outboundId: string, now = new Date()): Promise<{ sendAfter: Date }> {
  const { out, request } = await loadItem(outboundId);
  if (out.kind === "WEB_FORM_COPY") throw new DraftError("not_sendable", "Web forms are submitted by the owner");
  if (out.sentAt) throw new DraftError("already_sent");
  if (request.status !== "APPROVED") throw new DraftError("bad_status", `Cannot queue a ${request.status} item`);
  if (!out.approvedHash || out.approvedHash !== out.draftHash) throw new DraftError("not_approved");
  const sendAfter = new Date(now.getTime() + UNDO_WINDOW_MS);
  await db.$transaction(async (tx) => {
    const n = await tx.request.updateMany({ where: { id: request.id, status: "APPROVED" }, data: { status: "QUEUED" } });
    if (n.count !== 1) throw new DraftError("bad_status");
    await tx.outboundMessage.update({ where: { id: out.id }, data: { sendAfter } });
    const data = { outboundId, sendAfter: sendAfter.toISOString(), approvedHash: out.approvedHash };
    await tx.requestEvent.create({ data: { requestId: request.id, type: "QUEUED", actor: "OWNER", at: now, data } });
    await tx.auditLog.create({ data: { action: "request.queued", entity: "request", entityId: request.id, at: now, data } });
  });
  return { sendAfter };
}

/** Undo / cancel while queued: back to APPROVED if the worker has not sent it yet. */
export async function undoQueued(outboundId: string, now = new Date()): Promise<void> {
  const { out, request } = await loadItem(outboundId);
  if (out.sentAt) throw new DraftError("already_sent");
  if (request.status !== "QUEUED") throw new DraftError("bad_status", `Cannot undo a ${request.status} item`);
  await db.$transaction(async (tx) => {
    const sent = await tx.outboundMessage.updateMany({ where: { id: out.id, sentAt: null }, data: { sendAfter: null } });
    if (sent.count !== 1) throw new DraftError("already_sent");
    const n = await tx.request.updateMany({ where: { id: request.id, status: "QUEUED" }, data: { status: "APPROVED" } });
    if (n.count !== 1) throw new DraftError("bad_status");
    const data = { outboundId };
    await tx.requestEvent.create({ data: { requestId: request.id, type: "UNDO", actor: "OWNER", at: now, data } });
    await tx.auditLog.create({ data: { action: "request.undo", entity: "request", entityId: request.id, at: now, data } });
  });
}
