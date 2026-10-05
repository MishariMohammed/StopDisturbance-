import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encryptJson } from "@/lib/crypto/tokens";
import { graphBatch, graphFetch } from "@/lib/mail/graph";
import { hashAddress } from "@/lib/mail/headers";
import { outlookIncrementalSync, outlookInitialSync } from "@/lib/mail/outlook-sync";
import { json, mockFetch, resetDb } from "./helpers";
import { marketingMsg } from "./fixtures/gmail";

vi.mock("@/lib/jobs/queue", () => ({ enqueueInitialSync: vi.fn() }));

const noSleep = async () => {};
const G = "https://graph.microsoft.com/v1.0";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("graphFetch guard", () => {
  it.each(["body", "uniqueBody", "bodyPreview", "id,Body", "attachments"])("refuses $select=%s", async (sel) => {
    await expect(graphFetch("t", "/messages/1", { query: { $select: sel } })).rejects.toThrow(/not allowed/);
  });

  it.each(["/messages/1/attachments", "/messages/1/attachments/2", "/messages/1/$value"])("refuses %s", async (p) => {
    await expect(graphFetch("t", p, { query: { $select: "id" } })).rejects.toThrow(/not allowed/);
  });

  it("refuses $expand=attachments and message reads without $select (default includes body)", async () => {
    await expect(graphFetch("t", "/messages/1", { query: { $select: "id", $expand: "attachments" } })).rejects.toThrow(/not allowed/);
    await expect(graphFetch("t", "/messages/1")).rejects.toThrow(/\$select/);
    await expect(graphFetch("t", "/mailFolders/inbox/messages/delta")).rejects.toThrow(/\$select/);
  });

  it("refuses non-Graph absolute URLs and body fields inside a batch", async () => {
    await expect(graphFetch("t", "https://evil.example/v1.0/me")).rejects.toThrow(/non-Graph/);
    await expect(graphBatch("t", [{ id: "1", url: "/me/messages/1?$select=uniqueBody" }])).rejects.toThrow(/not allowed/);
  });

  it("allows delta continuation links (their $select is fixed by the first request)", async () => {
    const m = mockFetch([[/deltatoken/, () => json({ value: [] })]]);
    vi.stubGlobal("fetch", m.fn);
    await graphFetch("t", `${G}/me/mailFolders/inbox/messages/delta?$deltatoken=abc`);
    expect(m.calls).toHaveLength(1);
  });
});

describe("Graph throttling", () => {
  it("honours Retry-After on 429 and 503", async () => {
    let n = 0;
    const statuses = [429, 503];
    vi.stubGlobal("fetch", mockFetch([
      [/\/me\?/, () => (n < 2 ? new Response("busy", { status: statuses[n++], headers: { "retry-after": String(n * 2) } }) : json({ id: "me" }))],
    ]).fn);
    const sleeps: number[] = [];
    const res = await graphFetch<{ id: string }>("t", "", { query: { $select: "id" }, sleep: async (ms) => void sleeps.push(ms) });
    expect(res.id).toBe("me");
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("splits into batches of ≤20 with ≤3 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sizes: number[] = [];
    vi.stubGlobal("fetch", mockFetch([
      [/\/\$batch$/, async (_u, init) => {
        const { requests } = JSON.parse(String(init?.body)) as { requests: { id: string }[] };
        sizes.push(requests.length);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return json({ responses: requests.map((r) => ({ id: r.id, status: 200, body: { id: r.id } })) });
      }],
    ]).fn);
    const reqs = Array.from({ length: 85 }, (_, i) => ({ id: `m${i}`, url: `/me/messages/m${i}?$select=id` }));
    const out = await graphBatch<{ id: string }>("t", reqs, { sleep: noSleep });
    expect(out.size).toBe(85);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(85);
    expect(sizes).toHaveLength(5);
    expect(maxInFlight).toBe(3);
  });

  it("retries only the throttled requests inside a batch after their Retry-After", async () => {
    const seen: string[][] = [];
    vi.stubGlobal("fetch", mockFetch([
      [/\/\$batch$/, (_u, init) => {
        const { requests } = JSON.parse(String(init?.body)) as { requests: { id: string }[] };
        seen.push(requests.map((r) => r.id));
        return json({
          responses: requests.map((r) =>
            r.id === "b" && seen.length === 1
              ? { id: r.id, status: 429, headers: { "Retry-After": "7" }, body: { error: { code: "TooManyRequests" } } }
              : { id: r.id, status: 200, body: { id: r.id } },
          ),
        });
      }],
    ]).fn);
    const sleeps: number[] = [];
    const out = await graphBatch<{ id: string }>(
      "t",
      ["a", "b", "c"].map((id) => ({ id, url: `/me/messages/${id}?$select=id` })),
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(seen).toEqual([["a", "b", "c"], ["b"]]);
    expect(sleeps).toEqual([7000]);
    expect(out.get("b")).toEqual({ status: 200, body: { id: "b" } });
  });
});

// ---- delta sync ----

const marketingHeaders = marketingMsg.payload!.headers!;
const personalHeaders = [
  { name: "From", value: "Sara <sara@hotmail.com>" },
  { name: "Subject", value: "hi" },
  { name: "Message-ID", value: "<p1@hotmail.com>" },
];
const junkHeaders = [
  { name: "From", value: "Promo <news@spammy-shop.com>" },
  { name: "List-Unsubscribe", value: "<mailto:u@spammy-shop.com>" },
];

const headersById: Record<string, unknown[]> = { i1: marketingHeaders, i2: personalHeaders, j1: junkHeaders, a1: personalHeaders, n1: junkHeaders };

const item = (id: string, cls: "focused" | "other" = "other") => ({
  id,
  conversationId: `c-${id}`,
  receivedDateTime: "2026-09-01T10:00:00Z",
  from: { emailAddress: { address: "x@example.com" } },
  inferenceClassification: cls,
});

type Opts = { junkDeltaStatus?: number; archiveMissing?: boolean };

function graphRoutes(opts: Opts = {}) {
  const batchSizes: number[] = [];
  const deltaFirstQueries: URLSearchParams[] = [];
  const delta = (folder: string, token: string) => `${G}/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;
  const m = mockFetch([
    [/\/\$batch$/, (_u, init) => {
      const { requests } = JSON.parse(String(init?.body)) as { requests: { id: string; url: string }[] };
      batchSizes.push(requests.length);
      return json({
        responses: requests.map((r) => {
          expect(r.url).toMatch(/^\/me\/messages\/\w+\?\$select=internetMessageHeaders,/);
          const h = headersById[r.id];
          return h
            ? { id: r.id, status: 200, body: { internetMessageHeaders: h, conversationId: `c-${r.id}`, receivedDateTime: "2026-09-01T10:00:00Z", inferenceClassification: ["i2", "a1"].includes(r.id) ? "focused" : "other", parentFolderId: "opaque" } }
            : { id: r.id, status: 404, body: { error: { code: "ErrorItemNotFound" } } };
        }),
      });
    }],
    [/\/mailFolders\/(\w+)\/messages\/delta/, (u) => {
      const folder = u.pathname.split("/")[4];
      const dt = u.searchParams.get("$deltatoken");
      const skip = u.searchParams.get("$skiptoken");
      if (dt) {
        if (folder === "junkemail" && opts.junkDeltaStatus) {
          return json({ error: { code: "syncStateNotFound", message: "expired" } }, opts.junkDeltaStatus);
        }
        if (folder === "inbox") return json({ value: [item("n1"), { id: "i1", "@removed": { reason: "deleted" } }], "@odata.deltaLink": delta(folder, "inbox-2") });
        return json({ value: [], "@odata.deltaLink": delta(folder, `${folder}-2`) });
      }
      if (!skip) deltaFirstQueries.push(u.searchParams);
      switch (folder) {
        case "inbox":
          return skip
            ? json({ value: [item("i2", "focused"), item("gone")], "@odata.deltaLink": delta(folder, "inbox-1") })
            : json({ value: [item("i1")], "@odata.nextLink": `${G}/me/mailFolders/inbox/messages/delta?$skiptoken=p2` });
        case "junkemail":
          return json({ value: [item("j1")], "@odata.deltaLink": delta(folder, "junk-1") });
        case "archive":
          return opts.archiveMissing
            ? json({ error: { code: "ErrorFolderNotFound" } }, 404)
            : json({ value: [item("a1", "focused")], "@odata.deltaLink": delta(folder, "archive-1") });
        case "sentitems":
          return json({
            value: [{ id: "s1", receivedDateTime: "2026-09-02T00:00:00Z", toRecipients: [{ emailAddress: { address: "Friend@Gmail.com", name: "F" } }] }],
            "@odata.deltaLink": delta(folder, "sent-1"),
          });
      }
      return new Response("?", { status: 400 });
    }],
  ]);
  return { ...m, batchSizes, deltaFirstQueries };
}

async function makeAccount() {
  const { cipher, keyVersion } = encryptJson({ access_token: "AT", refresh_token: "RT", expires_at: Date.now() + 3_600_000, scope: "Mail.Read" });
  return db.mailAccount.create({
    data: {
      provider: "MICROSOFT", address: "owner@outlook.com", providerUserId: "oid", grantedScopes: ["Mail.Read"],
      tokenCipher: cipher, tokenKeyVersion: keyVersion, scanFrom: new Date("2023-10-05T00:00:00Z"),
    },
  });
}

describe("Outlook initial sync", () => {
  it("runs delta over 4 folders, batches header GETs, stores rows and sent-to hashes", async () => {
    const account = await makeAccount();
    const m = graphRoutes();
    vi.stubGlobal("fetch", m.fn);

    const progress = await outlookInitialSync(account.id, { sleep: noSleep });
    expect(progress).toMatchObject({ phase: "done", listed: 6, fetched: 5 });

    // Initial delta requests carry $select (no body) and the scanFrom date filter.
    expect(m.deltaFirstQueries).toHaveLength(4);
    for (const q of m.deltaFirstQueries) {
      expect(q.get("$select")).not.toMatch(/body|attachments/i);
      expect(q.get("$filter")).toBe("receivedDateTime ge 2023-10-05T00:00:00Z");
    }
    expect(m.batchSizes.every((n) => n <= 20)).toBe(true);
    expect(m.calls.every((u) => !/attachments|\$value/.test(u.pathname))).toBe(true);

    const rows = await db.messageHeader.findMany({ orderBy: { providerMsgId: "asc" } });
    expect(rows.map((r) => r.providerMsgId)).toEqual(["a1", "i1", "i2", "j1"]);
    const byId = Object.fromEntries(rows.map((r) => [r.providerMsgId, r]));
    expect(byId.i1).toMatchObject({ fromDomain: "noon.com", oneClick: true, dkimCoversListUnsub: true, threadId: "c-i1", internetMessageId: "<abc@em.noon.com>" });
    expect(byId.i1.labels).toEqual(["FOLDER_INBOX", "OTHER"]);
    expect(byId.i2.labels).toEqual(["FOLDER_INBOX", "FOCUSED"]);
    expect(byId.j1.labels).toEqual(["FOLDER_JUNK", "OTHER"]);
    expect(byId.a1.labels).toEqual(["FOLDER_ARCHIVE", "FOCUSED"]);
    expect(Buffer.from(byId.i1.listUnsubHttpsCipher!).toString("latin1")).not.toContain("SECRET123");

    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.sentToHashes).toEqual([hashAddress("friend@gmail.com")]);
    expect(JSON.stringify(rows)).not.toMatch(/friend@gmail\.com/i);
    expect(acc.syncCursor).toEqual({
      folders: {
        inbox: `${G}/me/mailFolders/inbox/messages/delta?$deltatoken=inbox-1`,
        junkemail: `${G}/me/mailFolders/junkemail/messages/delta?$deltatoken=junk-1`,
        archive: `${G}/me/mailFolders/archive/messages/delta?$deltatoken=archive-1`,
        sentitems: `${G}/me/mailFolders/sentitems/messages/delta?$deltatoken=sent-1`,
      },
    });
    expect(acc.scanProgress).toMatchObject({ phase: "done", listed: 6 });
  });

  it("skips a folder the mailbox does not have", async () => {
    const account = await makeAccount();
    vi.stubGlobal("fetch", graphRoutes({ archiveMissing: true }).fn);
    await outlookInitialSync(account.id, { sleep: noSleep });
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(Object.keys((acc.syncCursor as { folders: object }).folders)).toEqual(["inbox", "junkemail", "sentitems"]);
  });
});

describe("Outlook incremental sync", () => {
  it("replays deltaLinks and stores new messages only", async () => {
    const account = await makeAccount();
    vi.stubGlobal("fetch", graphRoutes().fn);
    await outlookInitialSync(account.id, { sleep: noSleep });
    const r = await outlookIncrementalSync(account.id, { sleep: noSleep });
    expect(r).toEqual({ mode: "incremental", added: 1, resynced: [] });
    expect(await db.messageHeader.count()).toBe(5);
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect((acc.syncCursor as { folders: Record<string, string> }).folders.inbox).toMatch(/inbox-2$/);
  });

  it.each([410, 400])("resyncs only the folder whose delta token expired (%i)", async (status) => {
    const account = await makeAccount();
    const m = graphRoutes({ junkDeltaStatus: status });
    vi.stubGlobal("fetch", m.fn);
    await outlookInitialSync(account.id, { sleep: noSleep });
    const r = await outlookIncrementalSync(account.id, { sleep: noSleep });
    expect(r.mode).toBe("incremental");
    expect(r.resynced).toEqual(["junkemail"]);
    expect(m.deltaFirstQueries).toHaveLength(5); // 4 initial + junk again
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect((acc.syncCursor as { folders: Record<string, string> }).folders.junkemail).toMatch(/junk-1$/);
    expect(await db.messageHeader.count()).toBe(5);
  });

  it("does a full sync when there is no cursor yet", async () => {
    const account = await makeAccount();
    vi.stubGlobal("fetch", graphRoutes().fn);
    const r = await outlookIncrementalSync(account.id, { sleep: noSleep });
    expect(r.mode).toBe("full");
  });
});
