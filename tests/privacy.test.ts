import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encrypt, encryptJson } from "@/lib/crypto/tokens";
import { googleAccessToken, ReconnectRequiredError } from "@/lib/mail/accounts";
import { disconnectMailbox, eraseEverything, MICROSOFT_CONSENT_URL } from "@/lib/privacy/erase";
import { exportData } from "@/lib/privacy/export";
import { json, mockFetch, resetDb } from "./helpers";
import { FAR, seedAccount, seedOwner, seedRequest } from "./m5-helpers";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

const REVOKE = /oauth2\.googleapis\.com\/revoke$/;

function revokeEndpoint(status = 200) {
  const bodies: string[] = [];
  const m = mockFetch([[REVOKE, (_u, init) => {
    bodies.push(String(init?.body));
    return status === 200 ? new Response("", { status }) : json({ error: "invalid_token" }, status);
  }]]);
  vi.stubGlobal("fetch", m.fn);
  return { ...m, bodies };
}

async function googleAccount(address = "sara@gmail.com", refresh = "1//REFRESH-SECRET-TOKEN") {
  const { cipher, keyVersion } = encryptJson({ access_token: "ya29.ACCESS", refresh_token: refresh, expires_at: FAR, scope: "" });
  return db.mailAccount.create({
    data: { provider: "GOOGLE", address, providerUserId: address, grantedScopes: ["gmail.readonly"], tokenCipher: cipher, tokenKeyVersion: keyVersion, scanFrom: new Date("2024-01-01"), syncCursor: { historyId: "1" } },
  });
}

/** A realistic spread of rows across every table. Returns the id of a request that was sent. */
async function seedEverything() {
  await seedOwner();
  const g = await googleAccount();
  const m = await seedAccount({ provider: "MICROSOFT" });
  const company = await db.company.create({ data: { name: "Shop", primaryDomain: "shop.example", decision: "REMOVE" } });
  const sender = await db.sender.create({ data: { registrableDomain: "shop.example", companyId: company.id, firstSeen: new Date(), lastSeen: new Date(), exampleSubjects: ["Big sale"] } });
  await db.messageHeader.create({ data: { accountId: g.id, senderId: sender.id, providerMsgId: "p1", receivedAt: new Date(), fromAddress: "news@shop.example", fromDomain: "shop.example", subject: "Big sale", listUnsubHttpsCipher: encrypt("https://shop.example/u?t=SECRETURL") } });
  await db.companyDomain.create({ data: { domain: "shop.example", companyId: company.id, source: "psl" } });
  await db.companyContact.create({ data: { companyId: company.id, kind: "PRIVACY_EMAIL", value: "privacy@shop.example", source: "policy", confidence: "HIGH", lastVerifiedAt: new Date() } });
  await db.classification.create({ data: { companyId: company.id, method: "RULES", labels: ["ads"], ruleIds: [], confidence: "HIGH" } });
  await db.decision.create({ data: { companyId: company.id, value: "REMOVE" } });
  const sent = await seedRequest({ companyId: company.id, accountId: g.id, status: "SENT", sentAt: new Date() });
  const draft = await seedRequest({ companyId: company.id, accountId: m.id, status: "DRAFT", sendAfter: null });
  await db.inboundReply.create({ data: { requestId: sent.request.id, providerMsgId: "r1", receivedAt: new Date(), fromAddress: "dpo@shop.example", subject: "Re: delete", bodyCipher: encrypt("Subject: Re\r\n\r\nWe deleted your data REPLYSECRET.\r\n"), matchMethod: "THREAD" } });
  await db.evidenceHeader.create({ data: { requestId: sent.request.id, receivedAt: new Date(), rawHeadersCipher: encrypt("From: x") } });
  await db.requestEvent.create({ data: { requestId: sent.request.id, type: "SENT", actor: "SYSTEM", data: {} } });
  await db.auditLog.create({ data: { action: "request.sent", entity: "request", entityId: sent.request.id, data: {} } });
  await db.auditLog.create({ data: { action: "request.draft_created", entity: "request", entityId: draft.request.id, data: {} } });
  await db.auditLog.create({ data: { action: "settings.ai_mode", entity: "setting", entityId: "aiMode", data: {} } });
  await db.setting.create({ data: { key: "aiMode", value: "RULES" } });
  await db.llmCallLog.create({ data: { purpose: "p", model: "m", inTokens: 1, cacheHitTokens: 0, outTokens: 1, payloadHash: "h", fieldNames: [], ok: true } });
  await db.llmPayloadSample.create({ data: { callId: "c", payloadCipher: encrypt("{}") } });
  await db.datasetSnapshot.create({ data: { source: "jdm", version: "1", fetchedAt: new Date(), data: {} } });
  await db.appEvent.create({ data: { name: "x", props: {} } });
  await db.user.create({ data: { id: "u1", name: "Sara", email: "sara@gmail.com", sessions: { create: { id: "s1", token: "t1", expiresAt: new Date(FAR) } }, accounts: { create: { id: "a1", accountId: "g", providerId: "google", accessToken: "LOGIN-TOKEN" } } } });
  await db.verification.create({ data: { id: "v1", identifier: "x", value: "y", expiresAt: new Date(FAR) } });
  return { sentRequestId: sent.request.id };
}

async function tableCounts() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const out: Record<string, number> = {};
  for (const t of tables) {
    const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "public"."${t.tablename}"`);
    out[t.tablename] = Number(n);
  }
  return out;
}

describe("erase everything", () => {
  it("revokes Google tokens, returns the Microsoft consent link and empties every table", async () => {
    await seedEverything();
    const r = revokeEndpoint();
    const res = await eraseEverything({ keepSentAudit: false });

    expect(r.calls.map((u) => u.href)).toEqual(["https://oauth2.googleapis.com/revoke"]);
    expect(new URLSearchParams(r.bodies[0]).get("token")).toBe("1//REFRESH-SECRET-TOKEN");
    expect(res.revocations).toEqual([
      { address: "sara@gmail.com", provider: "GOOGLE", revoked: true },
      { address: "sara@outlook.com", provider: "MICROSOFT", revoked: false, consentUrl: MICROSOFT_CONSENT_URL },
    ]);
    expect(res.microsoftConsentUrl).toBe("https://account.live.com/consent/Manage");

    const counts = await tableCounts();
    expect(Object.keys(counts).length).toBeGreaterThan(20);
    expect(Object.entries(counts).filter(([, n]) => n > 0)).toEqual([]);
  });

  it("keeps only the audit rows of sent requests when the owner opts in", async () => {
    const { sentRequestId } = await seedEverything();
    revokeEndpoint();
    const res = await eraseEverything({ keepSentAudit: true });
    expect(res.keptAuditRows).toBe(1);
    const counts = await tableCounts();
    expect(Object.entries(counts).filter(([, n]) => n > 0)).toEqual([["AuditLog", 1]]);
    const rows = await db.auditLog.findMany();
    expect(rows[0]).toMatchObject({ action: "request.sent", entityId: sentRequestId });
  });

  it("still erases when Google's revoke endpoint fails", async () => {
    await seedEverything();
    revokeEndpoint(503);
    const res = await eraseEverything({ keepSentAudit: false });
    expect(res.revocations[0]).toMatchObject({ provider: "GOOGLE", revoked: false });
    expect(await db.mailAccount.count()).toBe(0);
  });
});

describe("disconnect a mailbox", () => {
  it("revokes, wipes tokens and deletes only that mailbox's headers", async () => {
    const g = await googleAccount();
    const other = await googleAccount("work@gmail.com", "1//OTHER");
    for (const [acc, id] of [[g, "a"], [g, "b"], [other, "c"]] as const) {
      await db.messageHeader.create({ data: { accountId: acc.id, providerMsgId: id, receivedAt: new Date(), fromAddress: "n@shop.example", fromDomain: "shop.example" } });
    }
    const r = revokeEndpoint();
    const res = await disconnectMailbox(g.id);
    expect(res).toMatchObject({ revoke: { revoked: true }, headersDeleted: 2 });
    expect(new URLSearchParams(r.bodies[0]).get("token")).toBe("1//REFRESH-SECRET-TOKEN");

    const after = await db.mailAccount.findUniqueOrThrow({ where: { id: g.id } });
    expect(after).toMatchObject({ status: "DISCONNECTED", grantedScopes: [], syncCursor: null });
    expect(after.tokenCipher.length).toBe(0);
    expect(await db.messageHeader.count({ where: { accountId: g.id } })).toBe(0);
    expect(await db.messageHeader.count({ where: { accountId: other.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "mailbox.disconnected" } })).toBe(1);
    // Sync and send stop: no token can be read any more.
    await expect(googleAccessToken(after)).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("export", () => {
  it("contains the owner's data but no tokens or ciphertexts", async () => {
    await seedEverything();
    const data = await exportData();
    const text = JSON.stringify(data);
    expect(data).toMatchObject({ format: "stopdisturbance-export/1", includesReplyBodies: false });
    expect((data.companies as unknown[]).length).toBe(1);
    expect((data.requests as unknown[]).length).toBe(2);
    expect((data.mailboxes as { address: string }[]).map((m) => m.address).sort()).toEqual(["sara@gmail.com", "sara@outlook.com"]);
    expect(text).toContain("Big sale");
    for (const secret of ["REFRESH-SECRET-TOKEN", "ya29.", "LOGIN-TOKEN", "SECRETURL", "REPLYSECRET"]) expect(text).not.toContain(secret);
    for (const field of ["tokenCipher", "listUnsubHttpsCipher", "bodyCipher", "rawHeadersCipher", "payloadCipher", "syncCursor", "accessToken", "refreshToken"]) {
      expect(text).not.toContain(`"${field}"`);
    }
  });

  it("decrypts reply bodies only when asked", async () => {
    await seedEverything();
    const data = await exportData({ includeReplyBodies: true });
    expect(data.includesReplyBodies).toBe(true);
    expect(JSON.stringify(data)).toContain("REPLYSECRET");
    expect(JSON.stringify(data)).not.toContain("bodyCipher");
  });
});
