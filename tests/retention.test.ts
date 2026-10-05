import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/tokens";
import { computeDraftHash } from "@/lib/legal/drafts";
import { resolveOneClickUrl } from "@/lib/enrich/contacts";
import { getRetentionYears, runRetention, setRetentionYears } from "@/lib/jobs/retention";
import { resetDb } from "./helpers";
import { seedAccount, seedRequest } from "./m5-helpers";

const NOW = new Date("2026-10-05T01:00:00Z");
const DAY = 24 * 3600 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

beforeEach(resetDb);

async function companyWithSender(domain: string, subjects: string[] = [], lastSeen = NOW) {
  const company = await db.company.create({ data: { name: domain, primaryDomain: domain, decision: "UNSUBSCRIBE" } });
  const sender = await db.sender.create({
    data: { registrableDomain: domain, companyId: company.id, firstSeen: ago(400), lastSeen, exampleSubjects: subjects },
  });
  return { company, sender };
}

let n = 0;
async function header(accountId: string, senderId: string, ageDays: number, opts: { oneClick?: boolean; subject?: string; url?: string } = {}) {
  const oneClick = opts.oneClick ?? false;
  return db.messageHeader.create({
    data: {
      accountId, senderId, providerMsgId: `m${++n}`, receivedAt: ago(ageDays), createdAt: ago(ageDays),
      fromAddress: "news@shop.example", fromDomain: "shop.example", subject: opts.subject ?? `Sale ${n}`,
      oneClick, dkimPass: oneClick, dkimCoversListUnsub: oneClick,
      listUnsubHttpsCipher: oneClick ? encrypt(opts.url ?? `https://shop.example/u?t=TOKEN${n}`) : null,
    },
  });
}

describe("retention: message headers (90 days)", () => {
  it("deletes headers older than 90 days and keeps newer ones", async () => {
    const acct = await seedAccount();
    const { sender } = await companyWithSender("shop.example");
    const old = await header(acct.id, sender.id, 91);
    const fresh = await header(acct.id, sender.id, 89);
    const r = await runRetention(NOW);
    expect(r.headers).toBe(1);
    expect(await db.messageHeader.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.messageHeader.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  it("re-points a ONE_CLICK contact (and its unsent approved item) to the newest surviving eligible header", async () => {
    const acct = await seedAccount();
    const { company, sender } = await companyWithSender("shop.example");
    const old = await header(acct.id, sender.id, 120, { oneClick: true, url: "https://shop.example/u?t=OLD" });
    await header(acct.id, sender.id, 30, { oneClick: true, url: "https://shop.example/u?t=MID" });
    const newest = await header(acct.id, sender.id, 10, { oneClick: true, url: "https://shop.example/u?t=NEW" });
    await header(acct.id, sender.id, 5, { oneClick: false }); // newer but not eligible
    const contact = await db.companyContact.create({
      data: { companyId: company.id, kind: "ONE_CLICK", value: `msg:${old.id}`, source: "headers", confidence: "HIGH", lastVerifiedAt: ago(120) },
    });
    const { out } = await seedRequest({ companyId: company.id, accountId: acct.id, type: "ONE_CLICK", kind: "ONE_CLICK_POST", to: `msg:${old.id}`, body: "List-Unsubscribe=One-Click", status: "APPROVED" });

    const r = await runRetention(NOW);
    expect(r).toMatchObject({ contactsRepointed: 1, contactsDeleted: 0 });
    const c = await db.companyContact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(c.value).toBe(`msg:${newest.id}`);
    expect(await resolveOneClickUrl(c.value)).toBe("https://shop.example/u?t=NEW");

    const o = await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } });
    expect(o.toAddress).toBe(`msg:${newest.id}`);
    expect(o.draftHash).toBe(computeDraftHash(`msg:${newest.id}`, null, "List-Unsubscribe=One-Click"));
    expect(o.approvedHash).toBe(o.draftHash); // approval still valid
    expect(await db.requestEvent.count({ where: { requestId: out.requestId, type: "ONE_CLICK_REPOINTED" } })).toBe(1);
  });

  it("deletes the ONE_CLICK contact when no eligible header survives", async () => {
    const acct = await seedAccount();
    const { company, sender } = await companyWithSender("shop.example");
    const old = await header(acct.id, sender.id, 100, { oneClick: true });
    await header(acct.id, sender.id, 10, { oneClick: false });
    const contact = await db.companyContact.create({
      data: { companyId: company.id, kind: "ONE_CLICK", value: `msg:${old.id}`, source: "headers", confidence: "HIGH", lastVerifiedAt: ago(100) },
    });
    const r = await runRetention(NOW);
    expect(r).toMatchObject({ contactsRepointed: 0, contactsDeleted: 1, headersKept: 0 });
    expect(await db.companyContact.findUnique({ where: { id: contact.id } })).toBeNull();
  });

  it("keeps a header an unsent one-click item still needs when there is no replacement", async () => {
    const acct = await seedAccount();
    const { company, sender } = await companyWithSender("shop.example");
    const old = await header(acct.id, sender.id, 100, { oneClick: true });
    await db.companyContact.create({
      data: { companyId: company.id, kind: "ONE_CLICK", value: `msg:${old.id}`, source: "headers", confidence: "HIGH", lastVerifiedAt: ago(100) },
    });
    await seedRequest({ companyId: company.id, accountId: acct.id, type: "ONE_CLICK", kind: "ONE_CLICK_POST", to: `msg:${old.id}`, body: "List-Unsubscribe=One-Click" });
    const r = await runRetention(NOW);
    expect(r.headersKept).toBe(1);
    expect(await db.messageHeader.findUnique({ where: { id: old.id } })).not.toBeNull();

    // Once sent, the next run purges it.
    await db.outboundMessage.updateMany({ data: { sentAt: NOW } });
    const r2 = await runRetention(NOW);
    expect(r2.headers).toBe(1);
    expect(await db.companyContact.count()).toBe(0);
  });

  it("clears example subjects that are no longer backed by a surviving header", async () => {
    const acct = await seedAccount();
    const stale = await companyWithSender("old.example", ["Old subject"], ago(200));
    const live = await companyWithSender("live.example", ["Ancient deal", "Fresh deal"], ago(1));
    await header(acct.id, stale.sender.id, 200, { subject: "Old subject" });
    await header(acct.id, live.sender.id, 150, { subject: "Ancient deal" });
    await header(acct.id, live.sender.id, 1, { subject: "Fresh deal" });
    await runRetention(NOW);
    expect((await db.sender.findUniqueOrThrow({ where: { id: stale.sender.id } })).exampleSubjects).toEqual([]);
    expect((await db.sender.findUniqueOrThrow({ where: { id: live.sender.id } })).exampleSubjects).toEqual(["Fresh deal"]);
  });
});

describe("retention: closed requests (closedAt + retentionYears)", () => {
  async function closedRequest(closedDaysAgo: number) {
    const acct = (await db.mailAccount.findFirst()) ?? (await seedAccount());
    const company = await db.company.create({ data: { name: `c${++n}`, primaryDomain: `c${n}.example` } });
    const { request } = await seedRequest({ companyId: company.id, accountId: acct.id, status: "COMPLETED", sentAt: ago(closedDaysAgo + 30), extra: { closedAt: ago(closedDaysAgo) } });
    await db.inboundReply.create({ data: { requestId: request.id, providerMsgId: `r${n}`, receivedAt: ago(closedDaysAgo), fromAddress: "dpo@c.example", subject: "Done", bodyCipher: encrypt("x"), matchMethod: "THREAD" } });
    await db.evidenceHeader.create({ data: { requestId: request.id, receivedAt: ago(closedDaysAgo), rawHeadersCipher: encrypt("h") } });
    await db.requestEvent.create({ data: { requestId: request.id, type: "CLOSED", actor: "OWNER", data: {} } });
    return request;
  }

  it("defaults to 1 year and deletes the request with messages, replies, evidence and events", async () => {
    expect(await getRetentionYears()).toBe(1);
    const gone = await closedRequest(370);
    const kept = await closedRequest(300);
    const acct = await db.mailAccount.findFirstOrThrow();
    const open = await seedRequest({ companyId: (await db.company.findFirstOrThrow()).id, accountId: acct.id, status: "SENT" });
    const r = await runRetention(NOW);
    expect(r.requests).toBe(1);
    expect(await db.request.findUnique({ where: { id: gone.id } })).toBeNull();
    for (const m of [db.outboundMessage, db.inboundReply, db.evidenceHeader, db.requestEvent] as unknown as { count: (a: object) => Promise<number> }[]) {
      expect(await m.count({ where: { requestId: gone.id } })).toBe(0);
    }
    expect(await db.request.findUnique({ where: { id: kept.id } })).not.toBeNull();
    expect(await db.inboundReply.count({ where: { requestId: kept.id } })).toBe(1);
    expect(await db.request.findUnique({ where: { id: open.request.id } })).not.toBeNull();
  });

  it("honours retentionYears = 3", async () => {
    await setRetentionYears(3);
    expect(await getRetentionYears()).toBe(3);
    const twoYears = await closedRequest(2 * 366);
    const fourYears = await closedRequest(4 * 366);
    expect((await runRetention(NOW)).requests).toBe(1);
    expect(await db.request.findUnique({ where: { id: twoYears.id } })).not.toBeNull();
    expect(await db.request.findUnique({ where: { id: fourYears.id } })).toBeNull();
    await expect(setRetentionYears(5)).rejects.toThrow();
  });
});

describe("retention: LLM logs and app events", () => {
  it("prunes LlmCallLog > 90 days, keeps the newest 20 payload samples none older than 7 days, AppEvent > 1 year", async () => {
    await db.llmCallLog.create({ data: { at: ago(91), purpose: "classifySenders", model: "m", inTokens: 1, cacheHitTokens: 0, outTokens: 1, payloadHash: "h", fieldNames: [], ok: true } });
    await db.llmCallLog.create({ data: { at: ago(10), purpose: "classifySenders", model: "m", inTokens: 1, cacheHitTokens: 0, outTokens: 1, payloadHash: "h", fieldNames: [], ok: true } });
    for (let i = 0; i < 25; i++) {
      await db.llmPayloadSample.create({ data: { callId: `c${i}`, payloadCipher: encrypt("{}"), createdAt: new Date(NOW.getTime() - i * 3600_000) } });
    }
    await db.llmPayloadSample.create({ data: { callId: "old", payloadCipher: encrypt("{}"), createdAt: ago(8) } });
    await db.appEvent.create({ data: { at: ago(366), name: "old", props: {} } });
    await db.appEvent.create({ data: { at: ago(300), name: "recent", props: {} } });

    const r = await runRetention(NOW);
    expect(r).toMatchObject({ llmCalls: 1, appEvents: 1 });
    expect(await db.llmCallLog.count()).toBe(1);
    const samples = await db.llmPayloadSample.findMany({ orderBy: { createdAt: "desc" } });
    expect(samples).toHaveLength(20);
    expect(samples.map((s) => s.callId)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i}`));
    expect((await db.appEvent.findMany()).map((e) => e.name)).toEqual(["recent"]);
  });
});
