import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encryptJson } from "@/lib/crypto/tokens";
import { initialSync, incrementalSync } from "@/lib/mail/gmail-sync";
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
