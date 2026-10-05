import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encryptJson } from "@/lib/crypto/tokens";
import { gmailScanQuery, initialSync, incrementalSync } from "@/lib/mail/gmail-sync";
import { enqueueInitialSync } from "@/lib/jobs/queue";
import { isEverything, rangeOf, SCAN_EVERYTHING_FROM, scanFromFor } from "@/lib/mail/scan-range";
import { restartScan } from "@/lib/mail/restart-scan";
import { hashAddress } from "@/lib/mail/headers";
import { json, mockFetch, resetDb } from "./helpers";
import { marketingMsg, newMsg, sentMsg, trashMsg } from "./fixtures/gmail";

vi.mock("@/lib/jobs/queue", () => ({ enqueueInitialSync: vi.fn() }));

const byId = Object.fromEntries([marketingMsg, sentMsg, trashMsg, newMsg].map((m) => [m.id, m]));

async function makeAccount() {
  const { cipher, keyVersion } = encryptJson({ access_token: "AT", refresh_token: "RT", expires_at: Date.now() + 3_600_000, scope: "" });
  return db.mailAccount.create({
    data: {
      provider: "GOOGLE",
      address: "owner@gmail.com",
      providerUserId: "owner@gmail.com",
      grantedScopes: [],
      tokenCipher: cipher,
      tokenKeyVersion: keyVersion,
      scanFrom: new Date(Date.now() - 3 * 365 * 86400_000),
    },
  });
}

function gmailRoutes(opts: { historyStatus?: number } = {}) {
  return mockFetch([
    [/\/profile$/, () => json({ emailAddress: "owner@gmail.com", historyId: "100" })],
    [/\/messages\?/, (u) => {
      expect(u.searchParams.get("q")).toBe("newer_than:3y");
      return json({ messages: [{ id: "m1" }, { id: "s1" }, { id: "x1" }] });
    }],
    [/\/messages\/\w+\?/, (u) => json(byId[u.pathname.split("/").pop()!])],
    [/\/history\?/, () =>
      opts.historyStatus
        ? new Response("gone", { status: opts.historyStatus })
        : json({ historyId: "150", history: [{ messagesAdded: [{ message: { id: "n1", threadId: "t4" } }] }] })],
  ]);
}

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("Gmail initial sync", () => {
  it("stores allow-listed headers, hashes sent-to, skips trash", async () => {
    const account = await makeAccount();
    const m = gmailRoutes();
    vi.stubGlobal("fetch", m.fn);

    const progress = await initialSync(account.id);
    expect(progress).toMatchObject({ phase: "done", listed: 3 });

    const rows = await db.messageHeader.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ providerMsgId: "m1", fromDomain: "noon.com", oneClick: true, dkimCoversListUnsub: true });
    // The one-click URL carries a per-recipient token: stored encrypted only.
    expect(Buffer.from(row.listUnsubHttpsCipher!).toString("latin1")).not.toContain("SECRET123");

    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.sentToHashes).toContain(hashAddress("friend@gmail.com"));
    expect(acc.syncCursor).toEqual({ historyId: "100" });

    // No message body or Cc data anywhere in the stored row.
    expect(JSON.stringify(row)).not.toMatch(/friend@gmail\.com|owner@gmail\.com/);
    expect(m.calls.every((u) => !["full", "raw"].includes(u.searchParams.get("format") ?? ""))).toBe(true);
  });

  it("stores the token encrypted (no plaintext in the DB)", async () => {
    await makeAccount();
    const raw = await db.$queryRaw<{ t: Buffer }[]>`SELECT "tokenCipher" AS t FROM "MailAccount"`;
    expect(Buffer.from(raw[0].t).toString("latin1")).not.toMatch(/AT|RT/);
  });
});

describe("Gmail incremental sync", () => {
  it("picks up new messages from history", async () => {
    const account = await makeAccount();
    vi.stubGlobal("fetch", gmailRoutes().fn);
    await initialSync(account.id);
    const r = await incrementalSync(account.id);
    expect(r).toEqual({ mode: "incremental", added: 1 });
    expect(await db.messageHeader.count()).toBe(2);
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.syncCursor).toEqual({ historyId: "150" });
  });

  it("falls back to a full resync when history returns 404", async () => {
    const account = await makeAccount();
    vi.stubGlobal("fetch", gmailRoutes({ historyStatus: 404 }).fn);
    await initialSync(account.id);
    const r = await incrementalSync(account.id);
    expect(r.mode).toBe("full");
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.syncCursor).toEqual({ historyId: "100" });
  });
});

describe("scan range (04-ux §3.2)", () => {
  const NOW = new Date("2026-10-05T10:00:00Z");

  it("maps 1 year / 3 years / Everything to scanFrom and back", () => {
    for (const r of ["1y", "3y", "all"] as const) expect(rangeOf(scanFromFor(r, NOW), NOW)).toBe(r);
    expect(scanFromFor("all", NOW)).toEqual(SCAN_EVERYTHING_FROM);
    expect(isEverything(scanFromFor("3y", NOW))).toBe(false);
  });

  it("Gmail omits newer_than for Everything instead of sending a huge value", () => {
    expect(gmailScanQuery(scanFromFor("1y", NOW), NOW)).toBe("newer_than:1y");
    expect(gmailScanQuery(scanFromFor("3y", NOW), NOW)).toBe("newer_than:3y");
    expect(gmailScanQuery(SCAN_EVERYTHING_FROM, NOW)).toBeUndefined();
  });

  it("an Everything initial sync lists messages with no q parameter", async () => {
    const account = await makeAccount();
    await db.mailAccount.update({ where: { id: account.id }, data: { scanFrom: SCAN_EVERYTHING_FROM } });
    const m = mockFetch([
      [/\/profile$/, () => json({ emailAddress: "owner@gmail.com", historyId: "100" })],
      [/\/messages\?/, () => json({ messages: [{ id: "m1" }] })],
      [/\/messages\/\w+\?/, (u) => json(byId[u.pathname.split("/").pop()!])],
    ]);
    vi.stubGlobal("fetch", m.fn);
    await initialSync(account.id);
    const list = m.calls.find((u) => /\/messages$/.test(u.pathname))!;
    expect(list.searchParams.has("q")).toBe(false);
  });

  it("restartScan sets scanFrom, clears cursor and progress, keeps headers and queues an initial sync", async () => {
    const account = await makeAccount();
    vi.stubGlobal("fetch", gmailRoutes().fn);
    await initialSync(account.id);
    const before = await db.messageHeader.count();
    expect(before).toBe(1);
    vi.mocked(enqueueInitialSync).mockClear();

    await restartScan(account.id, "all", NOW);
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.scanFrom).toEqual(SCAN_EVERYTHING_FROM);
    expect(acc.syncCursor).toBeNull();
    expect(acc.scanProgress).toBeNull();
    expect(enqueueInitialSync).toHaveBeenCalledWith(account.id);
    expect(await db.messageHeader.count()).toBe(before);

    // The re-scan meets the same message again: deduped by providerMsgId, not stored twice.
    vi.stubGlobal("fetch", mockFetch([
      [/\/profile$/, () => json({ emailAddress: "owner@gmail.com", historyId: "200" })],
      [/\/messages\?/, () => json({ messages: [{ id: "m1" }, { id: "n1" }] })],
      [/\/messages\/\w+\?/, (u) => json(byId[u.pathname.split("/").pop()!])],
    ]).fn);
    await initialSync(account.id);
    expect(await db.messageHeader.count()).toBe(2);
    expect(await db.messageHeader.count({ where: { providerMsgId: "m1" } })).toBe(1);
  });

  it("a range change while the initial sync runs restarts it with the new range instead of finishing the old one", async () => {
    const account = await makeAccount();
    let lists = 0;
    const m = mockFetch([
      [/\/profile$/, () => json({ emailAddress: "owner@gmail.com", historyId: "100" })],
      [/\/messages\?/, async () => {
        // The owner picks "Everything" mid-scan; the queued job collapses into this running one.
        if (lists++ === 0) await restartScan(account.id, "all", NOW);
        return json({ messages: [{ id: "m1" }] });
      }],
      [/\/messages\/\w+\?/, (u) => json(byId[u.pathname.split("/").pop()!])],
    ]);
    vi.stubGlobal("fetch", m.fn);
    await initialSync(account.id);
    const listCalls = m.calls.filter((u) => /\/messages$/.test(u.pathname));
    expect(listCalls.map((u) => u.searchParams.get("q"))).toEqual(["newer_than:3y", null]);
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.scanProgress).toMatchObject({ phase: "done" });
    expect(await db.messageHeader.count({ where: { providerMsgId: "m1" } })).toBe(1);
  });

  it("restartScan refuses a mailbox that needs reconnecting", async () => {
    const account = await makeAccount();
    await db.mailAccount.update({ where: { id: account.id }, data: { status: "NEEDS_RECONNECT" } });
    await expect(restartScan(account.id, "1y", NOW)).rejects.toThrow("not_active");
  });
});

describe("token refresh", () => {
  it("marks the mailbox NEEDS_RECONNECT on invalid_grant", async () => {
    const { cipher, keyVersion } = encryptJson({ access_token: "old", refresh_token: "RT", expires_at: 0, scope: "" });
    const account = await db.mailAccount.create({
      data: { provider: "GOOGLE", address: "x@gmail.com", providerUserId: "x", grantedScopes: [], tokenCipher: cipher, tokenKeyVersion: keyVersion, scanFrom: new Date() },
    });
    vi.stubGlobal("fetch", mockFetch([[/oauth2\.googleapis\.com\/token/, () => json({ error: "invalid_grant" }, 400)]]).fn);
    await expect(initialSync(account.id)).rejects.toThrow("reconnect_required");
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.status).toBe("NEEDS_RECONNECT");
  });

  it("refreshes an expired access token and keeps the refresh token", async () => {
    const { cipher, keyVersion } = encryptJson({ access_token: "old", refresh_token: "RT", expires_at: 0, scope: "" });
    const account = await db.mailAccount.create({
      data: { provider: "GOOGLE", address: "y@gmail.com", providerUserId: "y", grantedScopes: [], tokenCipher: cipher, tokenKeyVersion: keyVersion, scanFrom: new Date() },
    });
    const { googleAccessToken, readTokens } = await import("@/lib/mail/accounts");
    vi.stubGlobal("fetch", mockFetch([[/oauth2\.googleapis\.com\/token/, () => json({ access_token: "new", expires_in: 3600 })]]).fn);
    expect(await googleAccessToken(account)).toBe("new");
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(readTokens(acc).refresh_token).toBe("RT");
  });
});
