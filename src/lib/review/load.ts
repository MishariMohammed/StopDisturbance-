import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decideJurisdiction, factsFromJson, LAW_SUMMARIES } from "@/lib/legal/jurisdiction";
import { GMAIL_SCOPES } from "@/lib/mail/google-oauth";
import { MS_SCOPES } from "@/lib/mail/ms-oauth";
import { isApproved, lawSummaryKeys, type LawSummaryKey } from "./plan";

// Read model for /review (04-ux §3.4). Everything returned is plain JSON for client components.

export const ORIGINAL_EVENT = "DRAFT_ORIGINAL";
const FOLLOW_UP_KINDS = ["REMINDER", "ID_REPLY"];
// QUEUED items leave /review (the undo toast and the tracker's "Cancel" cover them).
const REVIEW_STATUSES = ["DRAFT", "APPROVED"] as const;
const CLOSED = ["COMPLETED", "REFUSED", "FAILED", "CANCELLED"] as const;

export interface ReviewItem {
  outboundId: string;
  requestId: string;
  reference: string;
  companyId: string;
  companyName: string;
  companyDomain: string;
  type: string;
  kind: string;
  status: string;
  templateId: string;
  language: string;
  lawyer: boolean;
  to: string | null;
  subject: string | null;
  body: string | null;
  approved: boolean;
  sendAfter: string | null;
  followUp: boolean;
  mailbox: { address: string; provider: "GOOGLE" | "MICROSOFT"; canSend: boolean };
  contact: { source: string; confidence: string; checkedAt: string | null; needsConfirmation: boolean; id: string | null } | null;
  law: { keys: LawSummaryKey[]; lawKeys: string[]; lowConfidence: boolean; why: { en: string; ar: string } | null };
  original: { to: string | null; subject: string | null; body: string | null } | null;
  error: string | null;
}

export interface ReviewData {
  items: ReviewItem[];
  owner: { fullName: string };
  mailboxes: string[];
  laws: typeof LAW_SUMMARIES;
}

const obj = (v: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function canSendFrom(provider: string, grantedScopes: string[]): boolean {
  return provider === "GOOGLE" ? grantedScopes.includes(GMAIL_SCOPES.send) : grantedScopes.includes(MS_SCOPES.send);
}

export async function loadReview(now = new Date()): Promise<ReviewData> {
  const outbound = await db.outboundMessage.findMany({ where: { sentAt: null }, orderBy: { createdAt: "asc" } });
  const requests = await db.request.findMany({ where: { id: { in: [...new Set(outbound.map((o) => o.requestId))] } } });
  const reqById = new Map(requests.map((r) => [r.id, r]));
  const rows = outbound.filter((o) => {
    const r = reqById.get(o.requestId);
    if (!r) return false;
    if (FOLLOW_UP_KINDS.includes(o.kind)) return o.sendAfter === null && !(CLOSED as readonly string[]).includes(r.status);
    return (REVIEW_STATUSES as readonly string[]).includes(r.status);
  });
  const reqIds = [...new Set(rows.map((o) => o.requestId))];
  const used = reqIds.map((id) => reqById.get(id)!);
  const [companies, accounts, events, owner] = await Promise.all([
    db.company.findMany({ where: { id: { in: [...new Set(used.map((r) => r.companyId))] } } }),
    db.mailAccount.findMany({ where: { id: { in: [...new Set(used.map((r) => r.mailAccountId))] } } }),
    db.requestEvent.findMany({
      where: { requestId: { in: reqIds }, type: { in: ["DRAFT_CREATED", ORIGINAL_EVENT, "DRAFT_EDITED"] } },
      orderBy: { at: "asc" },
    }),
    db.owner.findFirst(),
  ]);
  const contactIds = events.flatMap((e) => (e.type === "DRAFT_CREATED" && typeof obj(e.data).contactId === "string" ? [obj(e.data).contactId as string] : []));
  const contacts = await db.companyContact.findMany({ where: { id: { in: contactIds } } });
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const decisions = new Map<string, ReturnType<typeof decideJurisdiction>>();

  const items: ReviewItem[] = rows.map((o) => {
    const r = reqById.get(o.requestId)!;
    const company = companyById.get(r.companyId);
    const account = accountById.get(r.mailAccountId);
    const forOut = events.filter((e) => e.requestId === r.id && obj(e.data).outboundId === o.id);
    const created = forOut.find((e) => e.type === "DRAFT_CREATED");
    const originalEv = forOut.find((e) => e.type === ORIGINAL_EVENT);
    const edited = forOut.some((e) => e.type === "DRAFT_EDITED");
    const cd = obj(created?.data);
    const contact = typeof cd.contactId === "string" ? contactById.get(cd.contactId) : undefined;
    const contactMatches = contact && o.toAddress && (contact.value === o.toAddress || contact.value === `mailto:${o.toAddress}`);
    const jur = obj(company?.jurisdiction);
    if (company && !decisions.has(company.id)) decisions.set(company.id, decideJurisdiction(factsFromJson(company.jurisdiction), { usState: owner?.usState ?? null }, now));
    const decision = company ? decisions.get(company.id) : undefined;
    const sameLaws = decision && decision.lawKeys.join() === r.lawKeys.join();
    const od = obj(originalEv?.data);
    const original = originalEv
      ? { to: (od.to as string | null) ?? null, subject: (od.subject as string | null) ?? null, body: (od.body as string | null) ?? null }
      : edited
        ? null
        : { to: o.toAddress, subject: o.subject, body: o.bodyText };
    return {
      outboundId: o.id,
      requestId: r.id,
      reference: r.reference,
      companyId: r.companyId,
      companyName: company?.name ?? r.reference,
      companyDomain: company?.primaryDomain ?? "",
      type: r.type,
      kind: o.kind,
      status: r.status,
      templateId: o.templateId,
      language: o.language,
      lawyer: cd.lawyerFlag === true,
      to: o.toAddress,
      subject: o.subject,
      body: o.bodyText,
      approved: isApproved(o, r.status, FOLLOW_UP_KINDS.includes(o.kind)),
      sendAfter: o.sendAfter?.toISOString() ?? null,
      followUp: FOLLOW_UP_KINDS.includes(o.kind),
      mailbox: {
        address: account?.address ?? "",
        provider: account?.provider ?? "GOOGLE",
        canSend: account ? account.status === "ACTIVE" && canSendFrom(account.provider, account.grantedScopes) : false,
      },
      contact: contact
        ? {
            id: contact.id,
            source: contact.source,
            confidence: contact.confidence,
            checkedAt: contact.lastVerifiedAt.toISOString(),
            needsConfirmation: Boolean(contactMatches) && contact.confidence === "LOW" && !contact.ownerConfirmed,
          }
        : typeof cd.contactSource === "string"
          ? { id: null, source: cd.contactSource, confidence: "", checkedAt: null, needsConfirmation: false }
          : null,
      law: {
        keys: lawSummaryKeys(r.lawKeys, jur.fallback === true),
        lawKeys: r.lawKeys,
        lowConfidence: r.lowConfidenceWording,
        why: sameLaws ? { en: decision.whyLine("en"), ar: decision.whyLine("ar") } : null,
      },
      original,
      error: o.error,
    };
  });
  const mailboxes = [...new Set(accounts.map((a) => a.address))];
  return { items, owner: { fullName: owner?.fullName ?? "" }, mailboxes, laws: LAW_SUMMARIES };
}

/** Records the generated text once, before the first owner edit, so "Show changes" and "Reset" have a base. */
export async function snapshotOriginal(outboundId: string): Promise<void> {
  const out = await db.outboundMessage.findUnique({ where: { id: outboundId } });
  if (!out) return;
  const prior = await db.requestEvent.findMany({ where: { requestId: out.requestId, type: { in: [ORIGINAL_EVENT, "DRAFT_EDITED"] } } });
  if (prior.some((e) => obj(e.data).outboundId === outboundId)) return;
  await db.requestEvent.create({
    data: {
      requestId: out.requestId,
      type: ORIGINAL_EVENT,
      actor: "SYSTEM",
      data: { outboundId, to: out.toAddress, subject: out.subject, body: out.bodyText },
    },
  });
}

export async function loadOriginal(outboundId: string) {
  const out = await db.outboundMessage.findUnique({ where: { id: outboundId }, select: { requestId: true } });
  if (!out) return null;
  const evs = await db.requestEvent.findMany({ where: { requestId: out.requestId, type: ORIGINAL_EVENT } });
  const ev = evs.find((e) => obj(e.data).outboundId === outboundId);
  if (!ev) return null;
  const d = obj(ev.data);
  return { to: (d.to as string | null) ?? null, subject: (d.subject as string | null) ?? null, body: (d.body as string | null) ?? null };
}

/** Companies with a REMOVE/UNSUBSCRIBE decision and no open request: the "Create N drafts" set. */
export async function draftableCompanyIds(): Promise<string[]> {
  const [decided, open] = await Promise.all([
    db.company.findMany({ where: { decision: { in: ["REMOVE", "UNSUBSCRIBE"] } }, select: { id: true } }),
    db.request.findMany({ where: { status: { notIn: [...CLOSED] } }, select: { companyId: true } }),
  ]);
  const busy = new Set(open.map((r) => r.companyId));
  return decided.map((c) => c.id).filter((id) => !busy.has(id));
}

/**
 * Keeps queued items inside the undo window while the owner hovers/focuses the toast (WCAG 2.2.1).
 * Only items still QUEUED and unsent are touched; never moves sendAfter earlier.
 */
export async function holdQueued(outboundIds: string[], holdMs: number, now = new Date()): Promise<number> {
  const outs = await db.outboundMessage.findMany({
    where: { id: { in: outboundIds }, sentAt: null },
    select: { id: true, requestId: true, kind: true, sendAfter: true },
  });
  const queued = await db.request.findMany({ where: { id: { in: outs.map((o) => o.requestId) }, status: "QUEUED" }, select: { id: true } });
  const ok = new Set(queued.map((r) => r.id));
  // First letters are queued on the Request; follow-ups only through sendAfter on the message.
  const ids = outs.filter((o) => (FOLLOW_UP_KINDS.includes(o.kind) ? o.sendAfter !== null : ok.has(o.requestId))).map((o) => o.id);
  if (!ids.length) return 0;
  const until = new Date(now.getTime() + holdMs);
  const res = await db.outboundMessage.updateMany({
    where: { id: { in: ids }, sentAt: null, OR: [{ sendAfter: null, kind: { notIn: FOLLOW_UP_KINDS } }, { sendAfter: { lt: until } }] },
    data: { sendAfter: until },
  });
  return res.count;
}
