import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { computeDraftHash, updateDraft } from "@/lib/legal/drafts";
import { draftableCompanyIds, holdQueued, loadOriginal, loadReview, snapshotOriginal } from "@/lib/review/load";
import { resetDb } from "./helpers";

const NOW = new Date("2026-10-05T10:00:00+03:00");

async function seed() {
  await db.owner.create({ data: { id: "owner", fullName: "Sara Al-Harbi", loginEmails: ["sara@gmail.com"] } });
  const acc = await db.mailAccount.create({
    data: {
      provider: "GOOGLE", address: "sara@gmail.com", providerUserId: "g", grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      tokenCipher: Buffer.from("x"), tokenKeyVersion: 1, scanFrom: new Date("2024-01-01"),
    },
  });
  const company = await db.company.create({ data: { name: "Acme", primaryDomain: "acme.example", decision: "REMOVE" } });
  const other = await db.company.create({ data: { name: "Beta", primaryDomain: "beta.example", decision: "UNSUBSCRIBE" } });
  await db.company.create({ data: { name: "Kept", primaryDomain: "kept.example", decision: "KEEP" } });
  const contact = await db.companyContact.create({
    data: { companyId: company.id, kind: "PRIVACY_EMAIL", value: "privacy@acme.example", source: "guess", confidence: "LOW", lastVerifiedAt: NOW },
  });
  const request = await db.request.create({
    data: { companyId: company.id, mailAccountId: acc.id, type: "ERASURE_OBJECTION", status: "DRAFT", reference: "SD-TEST", lawKeys: ["PDPL", "GDPR"] },
  });
  const subject = "Delete my data — Ref SD-TEST";
  const body = "Under the Saudi Personal Data Protection Law, please delete my data.";
  const out = await db.outboundMessage.create({
    data: {
      requestId: request.id, kind: "INITIAL", templateId: "6a", templateVersion: "t", language: "en", toAddress: "privacy@acme.example",
      subject, bodyText: body, draftHash: computeDraftHash("privacy@acme.example", subject, body),
    },
  });
  await db.requestEvent.create({
    data: { requestId: request.id, type: "DRAFT_CREATED", actor: "SYSTEM", data: { outboundId: out.id, contactId: contact.id, contactSource: "guess", lawyerFlag: true } },
  });
  return { acc, company, other, request, out, subject, body };
}

describe("review read model", () => {
  beforeEach(resetDb);

  it("loads drafts with mailbox, recipient source and law rows; the unedited text is its own original", async () => {
    const s = await seed();
    const data = await loadReview(NOW);
    expect(data.items).toHaveLength(1);
    const item = data.items[0];
    expect(item).toMatchObject({
      outboundId: s.out.id, companyName: "Acme", approved: false, lawyer: true,
      mailbox: { address: "sara@gmail.com", provider: "GOOGLE", canSend: true },
      contact: { source: "guess", needsConfirmation: true },
      law: { keys: ["PDPL", "GDPR"] },
    });
    expect(item.original).toEqual({ to: "privacy@acme.example", subject: s.subject, body: s.body });
    expect(data.owner.fullName).toBe("Sara Al-Harbi");
  });

  it("snapshots the generated text once before the first edit", async () => {
    const s = await seed();
    await snapshotOriginal(s.out.id);
    await updateDraft(s.out.id, { body: "Changed." });
    await snapshotOriginal(s.out.id); // second call is a no-op
    const evs = await db.requestEvent.findMany({ where: { requestId: s.request.id, type: "DRAFT_ORIGINAL" } });
    expect(evs).toHaveLength(1);
    expect(await loadOriginal(s.out.id)).toEqual({ to: "privacy@acme.example", subject: s.subject, body: s.body });
    const item = (await loadReview(NOW)).items[0];
    expect(item.body).toBe("Changed.");
    expect(item.original?.body).toBe(s.body);
  });

  it("has no original after an edit that was not snapshotted", async () => {
    const s = await seed();
    await updateDraft(s.out.id, { body: "Edited elsewhere." });
    expect((await loadReview(NOW)).items[0].original).toBeNull();
  });

  it("lists decided companies without an open request as draftable", async () => {
    const s = await seed();
    expect(await draftableCompanyIds()).toEqual([s.other.id]);
    await db.request.update({ where: { id: s.request.id }, data: { status: "CANCELLED" } });
    expect((await draftableCompanyIds()).sort()).toEqual([s.company.id, s.other.id].sort());
  });

  it("holds only queued, unsent items and never moves sendAfter earlier", async () => {
    const s = await seed();
    expect(await holdQueued([s.out.id], 10_000, NOW)).toBe(0); // still a draft
    await db.request.update({ where: { id: s.request.id }, data: { status: "QUEUED" } });
    await db.outboundMessage.update({ where: { id: s.out.id }, data: { sendAfter: new Date(NOW.getTime() + 3_000) } });
    expect(await holdQueued([s.out.id], 10_000, NOW)).toBe(1);
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: s.out.id } })).sendAfter?.getTime()).toBe(NOW.getTime() + 10_000);
    expect(await holdQueued([s.out.id], 5_000, NOW)).toBe(0);
    await db.outboundMessage.update({ where: { id: s.out.id }, data: { sentAt: NOW } });
    expect(await holdQueued([s.out.id], 60_000, NOW)).toBe(0);
  });
});
