import { isEmailAddress } from "@/lib/email-address";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContactKind, Confidence, DecisionValue } from "@prisma/client";
import { db } from "@/lib/db";
import {
  ARABIC_REVIEWED_KEY,
  approveDraft,
  computeDraftHash,
  createDrafts,
  DraftError,
  newReference,
  parseMailto,
  queueApproved,
  undoQueued,
  updateDraft,
} from "@/lib/legal/drafts";
import { findBannedPhrases } from "@/lib/legal/render";
import { resetDb } from "./helpers";

const NOW = new Date("2026-10-05T10:00:00+03:00");
const REF_RE = /^SD-[0-9A-HJKMNP-TV-Z]{4}$/;

async function seedOwner(fullName = "Sara Al-Harbi") {
  await db.owner.create({ data: { id: "owner", fullName, loginEmails: ["sara@gmail.com"] } });
}

async function seedAccount(address: string, status: "ACTIVE" | "NEEDS_RECONNECT" = "ACTIVE") {
  return db.mailAccount.create({
    data: {
      provider: "GOOGLE", address, providerUserId: address, grantedScopes: [], tokenCipher: Buffer.from("x"), tokenKeyVersion: 1,
      scanFrom: new Date("2024-01-01"), status,
    },
  });
}

let gmail: { id: string };
let outlook: { id: string };

async function seedCompany(opts: {
  name?: string;
  decision?: DecisionValue | null;
  contacts?: { kind: ContactKind; value: string; confidence?: Confidence; ownerConfirmed?: boolean }[];
  facts?: unknown[];
  headers?: { gmail: number; outlook: number };
  accounts?: string[];
}) {
  const name = opts.name ?? "Acme";
  const domain = `${name.toLowerCase().replace(/\W/g, "")}.example`;
  const company = await db.company.create({
    data: {
      name, primaryDomain: domain, sendsAds: true, decision: opts.decision === undefined ? "REMOVE" : opts.decision,
      jurisdiction: opts.facts ? { facts: opts.facts } as object : undefined,
    },
  });
  const sender = await db.sender.create({
    data: {
      registrableDomain: domain, companyId: company.id, msgCount: 10, firstSeen: new Date("2025-01-01"), lastSeen: NOW,
      accountIds: opts.accounts ?? [gmail.id, outlook.id],
    },
  });
  const h = opts.headers ?? { gmail: 1, outlook: 3 };
  let n = 0;
  for (const [acc, count] of [[gmail.id, h.gmail], [outlook.id, h.outlook]] as const) {
    for (let i = 0; i < count; i++) {
      await db.messageHeader.create({
        data: { accountId: acc, providerMsgId: `${domain}-${n++}`, receivedAt: NOW, fromAddress: `news@${domain}`, fromDomain: domain, senderId: sender.id },
      });
    }
  }
  for (const c of opts.contacts ?? []) {
    await db.companyContact.create({
      data: {
        companyId: company.id, kind: c.kind, value: c.value, source: "test", confidence: c.confidence ?? "HIGH",
        ownerConfirmed: c.ownerConfirmed ?? false, lastVerifiedAt: NOW,
      },
    });
  }
  return company;
}

async function itemsFor(companyId: string) {
  const requests = await db.request.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });
  const outs = await db.outboundMessage.findMany({ where: { requestId: { in: requests.map((r) => r.id) } } });
  return requests.map((r) => ({ request: r, out: outs.find((o) => o.requestId === r.id)! }));
}

beforeEach(async () => {
  await resetDb();
  await seedOwner();
  gmail = await seedAccount("sara@gmail.com");
  outlook = await seedAccount("sara@outlook.com");
});

describe("helpers", () => {
  it("references are SD- + 4 Crockford base32 chars", () => {
    for (let i = 0; i < 200; i++) expect(newReference()).toMatch(REF_RE);
  });

  it("parses mailto unsubscribe values", () => {
    expect(parseMailto("<mailto:unsub@list.example?subject=unsubscribe%20me&body=x>")).toEqual({
      to: "unsub@list.example", subject: "unsubscribe me", body: "x",
    });
    expect(parseMailto("privacy@acme.example")).toEqual({ to: "privacy@acme.example", subject: null, body: null });
  });
});

describe("createDrafts", () => {
  it("REMOVE → 6a email to the privacy address + a ONE_CLICK item; both mailboxes listed; busiest mailbox sends", async () => {
    const c = await seedCompany({
      contacts: [
        { kind: "SUPPORT_EMAIL", value: "help@acme.example" },
        { kind: "PRIVACY_EMAIL", value: "privacy@acme.example", confidence: "MEDIUM" },
        { kind: "ONE_CLICK", value: "https://acme.example/u/abc" },
      ],
      facts: [{ key: "hq_country", value: "JP", confidence: "HIGH", source: "datarequests" }],
    });
    const res = await createDrafts([c.id], { now: NOW });
    expect(res.skipped).toEqual([]);
    expect(res.created.map((x) => x.type)).toEqual(["ERASURE_OBJECTION", "ONE_CLICK"]);

    const [letter, oneClick] = await itemsFor(c.id);
    expect(letter.request.status).toBe("DRAFT");
    expect(letter.request.mailAccountId).toBe(outlook.id); // 3 headers vs 1
    expect(letter.request.reference).toMatch(REF_RE);
    expect(letter.request.lawKeys).toEqual(["PDPL"]);
    expect(letter.request.citationsText).toMatch(/^the Saudi Personal Data Protection Law/);
    expect(letter.out).toMatchObject({ kind: "INITIAL", templateId: "6a", language: "en", toAddress: "privacy@acme.example" });
    expect(letter.out.subject).toBe(`Request to delete my personal data and stop direct marketing — Ref ${letter.request.reference}`);
    expect(letter.out.bodyText).toContain("I, Sara Al-Harbi, residing in Saudi Arabia, make this request under the Saudi Personal Data Protection Law");
    expect(letter.out.bodyText).toContain("Email addresses this request covers: sara@outlook.com, sara@gmail.com");
    expect(letter.out.bodyText).toContain("To: Acme — Data Protection / Privacy Team (privacy@acme.example)");
    expect(letter.out.bodyText).toContain("within 30 days of receiving this request (by 4 November 2026)");
    expect(letter.out.bodyText).not.toContain("{{");
    expect(findBannedPhrases(`${letter.out.subject}\n${letter.out.bodyText}`)).toEqual([]);
    expect(letter.out.draftHash).toBe(computeDraftHash(letter.out.toAddress, letter.out.subject, letter.out.bodyText));
    expect(letter.out.approvedHash).toBeNull();

    expect(oneClick.request.reference).not.toBe(letter.request.reference);
    expect(oneClick.out).toMatchObject({ kind: "ONE_CLICK_POST", toAddress: "https://acme.example/u/abc", bodyText: "List-Unsubscribe=One-Click" });

    const events = await db.requestEvent.findMany({ where: { requestId: letter.request.id } });
    expect(events.map((e) => e.type)).toEqual(["DRAFT_CREATED"]);
    expect(await db.auditLog.count({ where: { action: "request.draft_created" } })).toBe(2);

    // Stage 5 output is stored beside the facts.
    const stored = (await db.company.findUniqueOrThrow({ where: { id: c.id } })).jurisdiction as Record<string, unknown>;
    expect(stored).toMatchObject({ lawKeys: ["PDPL"], regulator: "SDAIA", deadlineDays: 30 });
    expect((stored.facts as unknown[]).length).toBe(1);
  });

  it("uses only the owner's name and email addresses (no phone, no ID)", async () => {
    await db.owner.update({ where: { id: "owner" }, data: { loginEmails: ["sara@gmail.com"], employerDomains: [] } });
    const c = await seedCompany({ contacts: [{ kind: "PRIVACY_EMAIL", value: "privacy@acme.example" }] });
    await createDrafts([c.id], { now: NOW });
    const [{ out }] = await itemsFor(c.id);
    expect(out.bodyText).not.toMatch(/\+?\d[\d\s-]{8,}\d/); // no phone/ID-like numbers
    expect(out.bodyText).not.toMatch(/iqama|passport|national id/i);
  });

  it("KSA company + arabicTemplatesReviewed → Arabic first, then English, in one email", async () => {
    await db.setting.create({ data: { key: ARABIC_REVIEWED_KEY, value: true } });
    const c = await seedCompany({
      name: "Jarir",
      contacts: [{ kind: "PRIVACY_EMAIL", value: "privacy@jarir.example" }],
      facts: [{ key: "ksa_presence", value: "tld", confidence: "HIGH", source: "domain" }],
    });
    await createDrafts([c.id], { now: NOW });
    const [{ request, out }] = await itemsFor(c.id);
    expect(out.language).toBe("ar+en");
    expect(out.templateId).toBe("6a");
    expect(out.subject).toContain(`المرجع ${request.reference}`);
    expect(out.subject).toContain(`Ref ${request.reference}`);
    const body = out.bodyText!;
    expect(body.indexOf("أنا Sara Al-Harbi")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("أنا Sara Al-Harbi")).toBeLessThan(body.indexOf("I, Sara Al-Harbi"));
    expect(body).toContain("من اللائحة التنفيذية، وكذلك لائحة الحد من الرسائل");
    expect(body).toContain("24 ربيع الآخر 1448");
    expect(body).not.toContain("{{");
    expect(findBannedPhrases(body)).toEqual([]);
    expect(request.lawKeys).toEqual(["PDPL", "CST_ANTISPAM"]);
  });

  it("KSA company without the review flag → English with PDPL cited in English", async () => {
    const c = await seedCompany({
      name: "Noon",
      contacts: [{ kind: "PRIVACY_EMAIL", value: "privacy@noon.example" }],
      facts: [{ key: "ksa_presence", value: "tld", confidence: "HIGH", source: "domain" }],
    });
    await createDrafts([c.id], { now: NOW });
    const [{ out }] = await itemsFor(c.id);
    expect(out.language).toBe("en");
    expect(out.bodyText).toContain("the Saudi Personal Data Protection Law");
    expect(out.bodyText).not.toMatch(/[؀-ۿ]/);
  });

  it("UNSUBSCRIBE → ONE_CLICK first", async () => {
    const c = await seedCompany({
      decision: "UNSUBSCRIBE",
      contacts: [
        { kind: "ONE_CLICK", value: "https://acme.example/u/1" },
        { kind: "MAILTO_UNSUB", value: "mailto:u@acme.example" },
        { kind: "PRIVACY_EMAIL", value: "privacy@acme.example" },
      ],
    });
    const res = await createDrafts([c.id], { now: NOW });
    expect(res.created.map((x) => x.type)).toEqual(["ONE_CLICK"]);
  });

  it("UNSUBSCRIBE → MAILTO_UNSUB when no one-click (list subject kept, Ref in default subject)", async () => {
    const a = await seedCompany({ name: "A", decision: "UNSUBSCRIBE", contacts: [{ kind: "MAILTO_UNSUB", value: "mailto:u@a.example?subject=unsubscribe" }] });
    const b = await seedCompany({ name: "B", decision: "UNSUBSCRIBE", contacts: [{ kind: "MAILTO_UNSUB", value: "u@b.example" }] });
    await createDrafts([a.id, b.id], { now: NOW });
    const [ia] = await itemsFor(a.id);
    const [ib] = await itemsFor(b.id);
    expect(ia.out).toMatchObject({ kind: "UNSUB_MAILTO", toAddress: "u@a.example", subject: "unsubscribe" });
    expect(ia.request.type).toBe("MAILTO_UNSUB");
    expect(ib.out.subject).toBe(`Unsubscribe — Ref ${ib.request.reference}`);
  });

  it("UNSUBSCRIBE → 6d letter when only an email contact exists", async () => {
    const c = await seedCompany({ decision: "UNSUBSCRIBE", contacts: [{ kind: "PRIVACY_EMAIL", value: "privacy@acme.example" }] });
    await createDrafts([c.id], { now: NOW });
    const [{ request, out }] = await itemsFor(c.id);
    expect(request.type).toBe("STOP_MARKETING");
    expect(out.templateId).toBe("6d");
    expect(out.subject).toBe(`Stop direct marketing to me — Ref ${request.reference}`);
    expect(out.bodyText).toContain("Keep my email addresses below only on a suppression list");
    expect(out.bodyText).not.toContain("{{");
  });

  it("6d-AR fills for a KSA unsubscribe-only company when Arabic is reviewed", async () => {
    await db.setting.create({ data: { key: ARABIC_REVIEWED_KEY, value: true } });
    const c = await seedCompany({
      decision: "UNSUBSCRIBE",
      contacts: [{ kind: "PRIVACY_EMAIL", value: "privacy@acme.example" }],
      facts: [{ key: "hq_country", value: "SA", confidence: "HIGH", source: "datarequests" }],
    });
    await createDrafts([c.id], { now: NOW });
    const [{ out }] = await itemsFor(c.id);
    expect(out.language).toBe("ar+en");
    expect(out.subject).toContain("طلب إيقاف الرسائل التسويقية");
    expect(out.bodyText).not.toContain("{{");
  });

  it("web-form-only → WEB_FORM with the 6a copy block (REMOVE) or the 6d block (UNSUBSCRIBE)", async () => {
    const r = await seedCompany({ name: "Shein", contacts: [{ kind: "WEB_FORM", value: "https://shein.example/privacy-form" }] });
    const u = await seedCompany({ name: "Temu", decision: "UNSUBSCRIBE", contacts: [{ kind: "WEB_FORM", value: "https://temu.example/form" }] });
    await createDrafts([r.id, u.id], { now: NOW });
    const [ri] = await itemsFor(r.id);
    const [ui] = await itemsFor(u.id);
    expect(ri.request.type).toBe("WEB_FORM");
    expect(ri.out).toMatchObject({ kind: "WEB_FORM_COPY", templateId: "webform", toAddress: "https://shein.example/privacy-form" });
    expect(ri.out.bodyText).toContain("2. Deletion. Delete (destroy) all personal data you hold about me");
    expect(ri.out.subject).toContain(`Ref ${ri.request.reference}`);
    expect(ri.out.bodyText).not.toContain("{{");
    expect(ui.out.templateId).toBe("webform-6d");
    expect(ui.out.bodyText).not.toContain("Deletion.");
  });

  it("prefers a web form over a LOW guessed email, and uses the guess only as a last resort", async () => {
    const a = await seedCompany({
      name: "A",
      contacts: [{ kind: "PRIVACY_EMAIL", value: "privacy@a.example", confidence: "LOW" }, { kind: "WEB_FORM", value: "https://a.example/f" }],
    });
    const b = await seedCompany({ name: "B", contacts: [{ kind: "PRIVACY_EMAIL", value: "dpo@b.example", confidence: "LOW" }] });
    await createDrafts([a.id, b.id], { now: NOW });
    expect((await itemsFor(a.id))[0].request.type).toBe("WEB_FORM");
    const [bi] = await itemsFor(b.id);
    expect(bi.out.toAddress).toBe("dpo@b.example");
    const ev = await db.requestEvent.findFirstOrThrow({ where: { requestId: bi.request.id } });
    expect(ev.data).toMatchObject({ recipientNeedsConfirmation: true });
  });

  it("skips KEEP, undecided, unknown, contactless, mailbox-less and already-open companies", async () => {
    const keep = await seedCompany({ name: "K", decision: "KEEP", contacts: [{ kind: "PRIVACY_EMAIL", value: "p@k.example" }] });
    const none = await seedCompany({ name: "N", decision: null });
    const noContact = await seedCompany({ name: "C" });
    const noBox = await seedCompany({ name: "M", accounts: [], headers: { gmail: 0, outlook: 0 }, contacts: [{ kind: "PRIVACY_EMAIL", value: "p@m.example" }] });
    const ok = await seedCompany({ name: "O", contacts: [{ kind: "PRIVACY_EMAIL", value: "p@o.example" }] });
    await createDrafts([ok.id], { now: NOW });
    const res = await createDrafts([keep.id, none.id, noContact.id, noBox.id, ok.id, "missing"], { now: NOW });
    expect(res.created).toEqual([]);
    expect(Object.fromEntries(res.skipped.map((s) => [s.companyId, s.reason]))).toEqual({
      [keep.id]: "keep", [none.id]: "no_decision", [noContact.id]: "no_contact", [noBox.id]: "no_mailbox", [ok.id]: "open_request", missing: "not_found",
    });
  });

  it("refuses to draft without the owner's name", async () => {
    await db.owner.update({ where: { id: "owner" }, data: { fullName: " " } });
    const c = await seedCompany({ contacts: [{ kind: "PRIVACY_EMAIL", value: "p@acme.example" }] });
    await expect(createDrafts([c.id], { now: NOW })).rejects.toThrow(/full name/);
  });
});

describe("approve / edit / queue / undo", () => {
  async function oneDraft(contacts: Parameters<typeof seedCompany>[0]["contacts"] = [{ kind: "PRIVACY_EMAIL", value: "privacy@acme.example" }]) {
    const c = await seedCompany({ contacts });
    await createDrafts([c.id], { now: NOW });
    const [item] = await itemsFor(c.id);
    return item;
  }
  const status = async (id: string) => (await db.request.findUniqueOrThrow({ where: { id } })).status;

  it("approval stores approvedHash = draftHash and logs it", async () => {
    const { request, out } = await oneDraft();
    const at = new Date("2026-10-05T11:00:00+03:00");
    expect(await approveDraft(out.id, at)).toEqual({ approvedHash: out.draftHash });
    const o = await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } });
    expect(o.approvedHash).toBe(out.draftHash);
    expect(o.approvedAt).toEqual(at);
    expect(await status(request.id)).toBe("APPROVED");
    const ev = await db.requestEvent.findFirstOrThrow({ where: { requestId: request.id, type: "APPROVED" } });
    expect(ev).toMatchObject({ actor: "OWNER", data: { draftHash: out.draftHash } });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "request.approved" } });
    expect(audit.data).toMatchObject({ draftHash: out.draftHash });
    // Idempotent re-approve.
    expect(await approveDraft(out.id)).toEqual({ approvedHash: out.draftHash });
  });

  it("an edit after approval clears the approval and recomputes the hash", async () => {
    const { request, out } = await oneDraft();
    await approveDraft(out.id);
    const body = `${out.bodyText}\nOrder number 12345.`;
    const res = await updateDraft(out.id, { body });
    const o = await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } });
    expect(o.approvedHash).toBeNull();
    expect(o.approvedAt).toBeNull();
    expect(o.draftHash).toBe(computeDraftHash(o.toAddress, o.subject, body));
    expect(res.draftHash).toBe(o.draftHash);
    expect(res.warnings).toEqual([]);
    expect(await status(request.id)).toBe("DRAFT");
    const ev = await db.requestEvent.findFirstOrThrow({ where: { requestId: request.id, type: "DRAFT_EDITED" } });
    expect(ev.data).toMatchObject({ approvalCleared: true });
    await expect(queueApproved(out.id)).rejects.toMatchObject({ code: "bad_status" });
  });

  it("edits return guardrail warnings; approval refuses banned phrases and unfilled placeholders", async () => {
    const { request, out } = await oneDraft();
    const res = await updateDraft(out.id, { subject: "Hello", body: "I write on behalf of Sara {{x}} 1234567890" });
    expect(res.warnings.sort()).toEqual(["banned_phrase", "citation_removed", "possible_id_number", "reference_removed", "unfilled_placeholder"]);
    await expect(approveDraft(out.id)).rejects.toMatchObject({ code: "unfilled" });
    await updateDraft(out.id, { body: "I write on behalf of Sara" });
    await expect(approveDraft(out.id)).rejects.toMatchObject({ code: "banned_phrase" });
    await updateDraft(out.id, { to: "  " });
    await expect(approveDraft(out.id)).rejects.toMatchObject({ code: "missing_recipient" });
    expect(await status(request.id)).toBe("DRAFT");
  });

  it("the owner can redirect a letter to another valid address; the edit clears approval", async () => {
    const { request, out } = await oneDraft();
    await approveDraft(out.id);
    for (const bad of ["not-an-email", "a@b", "me@example.com, you@example.com", "Me <me@example.com>", "me@example.com\r\nBcc: x@y.com"]) {
      await expect(updateDraft(out.id, { to: bad })).rejects.toMatchObject({ code: "invalid_recipient" });
    }
    // Rejected edits change nothing.
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } })).approvedHash).toBe(out.draftHash);

    await updateDraft(out.id, { to: "  owner.test+sd@gmail.com " });
    const o = await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } });
    expect(o.toAddress).toBe("owner.test+sd@gmail.com");
    expect(o.approvedHash).toBeNull();
    expect(o.draftHash).toBe(computeDraftHash("owner.test+sd@gmail.com", o.subject, o.bodyText));
    expect(await status(request.id)).toBe("DRAFT");
    // The owner's own address isn't a company contact, so it needs no confirmation.
    await expect(approveDraft(out.id)).resolves.toEqual({ approvedHash: o.draftHash });
  });

  it("isEmailAddress accepts one plain address only", () => {
    for (const ok of ["a@example.com", "first.last+tag@sub.example.co.uk", "x@xn--mgbh0fb.xn--mgberp4a5d4ar"]) expect(isEmailAddress(ok)).toBe(true);
    for (const bad of ["", "a@b", "a@@b.com", ".a@b.com", "a..b@c.com", "a@b.com,c@d.com", "a b@c.com", "a@-b.com", "<a@b.com>"]) expect(isEmailAddress(bad)).toBe(false);
  });

  it("a LOW guessed recipient must be confirmed before approval", async () => {
    const { out } = await oneDraft([{ kind: "PRIVACY_EMAIL", value: "privacy@acme.example", confidence: "LOW" }]);
    await expect(approveDraft(out.id)).rejects.toMatchObject({ code: "recipient_unconfirmed" });
    await db.companyContact.updateMany({ data: { ownerConfirmed: true } });
    await expect(approveDraft(out.id)).resolves.toBeTruthy();
  });

  it("queue sets QUEUED + sendAfter = now + 10 s; undo returns to APPROVED; queue again works", async () => {
    const { request, out } = await oneDraft();
    await expect(queueApproved(out.id)).rejects.toMatchObject({ code: "bad_status" }); // not approved yet
    await approveDraft(out.id);
    const now = new Date("2026-10-05T12:00:00+03:00");
    const { sendAfter } = await queueApproved(out.id, now);
    expect(sendAfter).toEqual(new Date(now.getTime() + 10_000));
    expect(await status(request.id)).toBe("QUEUED");
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } })).sendAfter).toEqual(sendAfter);
    await expect(updateDraft(out.id, { subject: "x" })).rejects.toMatchObject({ code: "bad_status" });

    await undoQueued(out.id);
    expect(await status(request.id)).toBe("APPROVED");
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } })).sendAfter).toBeNull();
    await expect(undoQueued(out.id)).rejects.toMatchObject({ code: "bad_status" });

    await queueApproved(out.id, now);
    const types = (await db.requestEvent.findMany({ where: { requestId: request.id }, orderBy: { at: "asc" } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["DRAFT_CREATED", "APPROVED", "QUEUED", "UNDO"]));
    expect(await db.auditLog.count({ where: { action: { in: ["request.queued", "request.undo"] } } })).toBe(3);
  });

  it("undo is refused once the worker has sent the message", async () => {
    const { out } = await oneDraft();
    await approveDraft(out.id);
    await queueApproved(out.id);
    await db.outboundMessage.update({ where: { id: out.id }, data: { sentAt: new Date() } });
    await expect(undoQueued(out.id)).rejects.toMatchObject({ code: "already_sent" });
    await expect(updateDraft(out.id, { body: "x" })).rejects.toMatchObject({ code: "already_sent" });
    await expect(approveDraft(out.id)).rejects.toMatchObject({ code: "already_sent" });
  });

  it("queue refuses a hash mismatch and web-form items; unknown ids are not_found", async () => {
    const { out } = await oneDraft();
    await approveDraft(out.id);
    await db.outboundMessage.update({ where: { id: out.id }, data: { draftHash: "tampered" } });
    await expect(queueApproved(out.id)).rejects.toMatchObject({ code: "not_approved" });

    const wf = await seedCompany({ name: "W", contacts: [{ kind: "WEB_FORM", value: "https://w.example/f" }] });
    await createDrafts([wf.id], { now: NOW });
    const [w] = await itemsFor(wf.id);
    await approveDraft(w.out.id);
    await expect(queueApproved(w.out.id)).rejects.toMatchObject({ code: "not_sendable" });
    await expect(approveDraft("nope")).rejects.toBeInstanceOf(DraftError);
  });
});
