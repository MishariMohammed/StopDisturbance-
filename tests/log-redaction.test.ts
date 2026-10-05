import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encrypt, encryptJson } from "@/lib/crypto/tokens";
import { initialSync } from "@/lib/mail/gmail-sync";
import { resolvePending } from "@/lib/scan/resolve";
import { classifySenders } from "@/lib/scan/classify";
import { enrichCompany } from "@/lib/enrich/contacts";
import { dispatchDue } from "@/lib/send/dispatcher";
import { logger, scrubForLog } from "@/lib/logger";
import { json, mockFetch, resetDb } from "./helpers";
import { host, html, resetNet, setRoutes } from "./net-mocks";
import { gmailFake, notificationsOff, seedAccount, seedCompany, seedOwner, seedRequest, T0 } from "./m5-helpers";

// 00-brief §8 / M6: seeded subjects, addresses, tokens and URL query strings never reach the logs.

const captured = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("@/lib/logger", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/logger")>();
  const dest = { write: (s: string) => void captured.lines.push(s) };
  return { ...mod, logger: mod.createLogger(dest, "trace") };
});
vi.mock("@/lib/jobs/queue", () => ({ enqueueInitialSync: vi.fn(), enqueueScanProcess: vi.fn(), enqueueEnrich: vi.fn() }));
vi.mock("node:dns/promises", async () => (await import("./net-mocks")).dnsModule);
vi.mock("undici", async () => (await import("./net-mocks")).undiciModule);

const SECRETS = {
  subject: "Zebra-Subject-7731 exclusive offer",
  from: "marketing-zebra@zebrashop.example",
  recipient: "sara.private@gmail.com",
  access: "ya29.AccessTokenZEBRA123456",
  refresh: "1//RefreshTokenZEBRA987654",
  unsubToken: "UNSUBZEBRA42",
  replyBody: "BODYZEBRA-SECRET",
};
const SEEDED = Object.values(SECRETS);

function assertClean() {
  const out = captured.lines.join("");
  expect(captured.lines.length).toBeGreaterThan(0);
  for (const s of SEEDED) expect(out).not.toContain(s);
  // No URL with a query string at all.
  expect(out).not.toMatch(/https?:\/\/[^\s"?]+\?(?!\[redacted\])/);
  return out;
}

const h = (name: string, value: string) => ({ name, value });

beforeEach(async () => {
  captured.lines.length = 0;
  await resetDb();
  await seedOwner();
  await notificationsOff();
  resetNet();
});
afterEach(() => vi.unstubAllGlobals());

describe("log redaction", () => {
  it("scrubs addresses, tokens and URL queries from free text and errors", () => {
    logger.info(
      { url: `https://x.example/u?t=${SECRETS.unsubToken}`, subject: SECRETS.subject, fromAddress: SECRETS.from, nested: { to: SECRETS.recipient, note: `Bearer ${SECRETS.access}` } },
      `fetch https://api.example/v1?code=${SECRETS.refresh} for ${SECRETS.recipient}`,
    );
    logger.warn({ err: new Error(`failed https://em.example/u?token=${SECRETS.unsubToken} <${SECRETS.from}> refresh=${SECRETS.refresh}`) }, "failed");
    logger.error({ err: (new Error(`token ${SECRETS.access}`) as Error).message, reason: `${SECRETS.refresh}` }, "x");
    const out = assertClean();
    expect(out).toContain("https://api.example/v1?[redacted]");
    expect(scrubForLog({ a: [`mail ${SECRETS.recipient}`] })).toEqual({ a: ["mail [email]"] });
  });

  it("sync → resolve → classify paths log no subjects, addresses or tokens", async () => {
    const { cipher, keyVersion } = encryptJson({ access_token: SECRETS.access, refresh_token: SECRETS.refresh, expires_at: Date.now() + 3_600_000, scope: "" });
    const acct = await db.mailAccount.create({
      data: { provider: "GOOGLE", address: SECRETS.recipient, providerUserId: SECRETS.recipient, grantedScopes: [], tokenCipher: cipher, tokenKeyVersion: keyVersion, scanFrom: new Date(Date.now() - 365 * 86400_000) },
    });
    const msg = {
      id: "z1", threadId: "t1", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], internalDate: String(Date.now()),
      payload: {
        headers: [
          h("From", `Zebra Shop <${SECRETS.from}>`), h("To", SECRETS.recipient), h("Subject", SECRETS.subject),
          h("Date", new Date().toUTCString()), h("Message-ID", "<z1@zebrashop.example>"),
          h("List-Unsubscribe", `<https://zebrashop.example/u?t=${SECRETS.unsubToken}>`), h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
          h("Authentication-Results", "mx.google.com; dkim=pass header.d=zebrashop.example"),
          h("DKIM-Signature", "v=1; d=zebrashop.example; h=from:subject:list-unsubscribe:list-unsubscribe-post; b=x"),
        ],
      },
    };
    const m = mockFetch([
      [/\/profile$/, () => json({ emailAddress: SECRETS.recipient, historyId: "100" })],
      [/\/messages\?/, () => json({ messages: [{ id: "z1" }] })],
      [/\/messages\/z1\?/, () => json(msg)],
    ]);
    vi.stubGlobal("fetch", m.fn);
    await initialSync(acct.id);
    const stats = await resolvePending();
    await classifySenders(stats.senderIds);
    expect(await db.messageHeader.count()).toBe(1);
    expect(captured.lines.some((l) => l.includes("resolve done"))).toBe(true);
    assertClean();
  });

  it("send paths (Gmail send, failure retry, one-click) log no addresses, subjects or URLs", async () => {
    const acc = await seedAccount({ address: SECRETS.recipient });
    const co = await seedCompany();
    await seedRequest({ companyId: co.id, accountId: acc.id, to: SECRETS.from, subject: SECRETS.subject, body: SECRETS.replyBody });
    vi.stubGlobal("fetch", gmailFake().fn);
    expect(await dispatchDue(new Date(T0.getTime() + 11_000))).toMatchObject([{ result: "sent" }]);

    // A failing send: the provider error text echoes the request URL with a query and the address.
    const co2 = await seedCompany("Other", "other.example");
    await seedRequest({ companyId: co2.id, accountId: acc.id, to: SECRETS.from, subject: SECRETS.subject, body: SECRETS.replyBody, sendAfter: new Date(T0.getTime() + 100_000) });
    vi.stubGlobal("fetch", async () => {
      throw new Error(`connect ECONNRESET https://gmail.googleapis.com/send?access_token=${SECRETS.access} for ${SECRETS.recipient}`);
    });
    await dispatchDue(new Date(T0.getTime() + 200_000));

    // One-click: the URL carries a per-recipient token.
    const hdr = await db.messageHeader.create({
      data: {
        accountId: acc.id, providerMsgId: "oc", receivedAt: T0, fromAddress: SECRETS.from, fromDomain: "zebrashop.example", subject: SECRETS.subject,
        listUnsubHttpsCipher: encrypt(`https://unsub.zebrashop.example/u?t=${SECRETS.unsubToken}`), oneClick: true, dkimPass: true, dkimCoversListUnsub: true,
      },
    });
    const co3 = await seedCompany("Zebra", "zebrashop.example");
    host("unsub.zebrashop.example");
    setRoutes([[/unsub\.zebrashop\.example/, () => new Response("ok", { status: 200 })]]);
    await seedRequest({ companyId: co3.id, accountId: acc.id, type: "ONE_CLICK", kind: "ONE_CLICK_POST", to: `msg:${hdr.id}`, body: "List-Unsubscribe=One-Click", sendAfter: new Date(T0.getTime() + 300_000) });
    await dispatchDue(new Date(T0.getTime() + 400_000));
    expect(captured.lines.some((l) => l.includes("one-click unsubscribe"))).toBe(true);
    assertClean();
  });

  it("enrich path logs no URLs with queries or addresses", async () => {
    const co = await db.company.create({ data: { name: "Zebra", primaryDomain: "zebrashop.example", decision: "REMOVE" } });
    host("zebrashop.example");
    host("www.zebrashop.example");
    setRoutes([
      [/privacy\.txt/, () => new Response("nf", { status: 404 })],
      [/\/privacy/, () => html(`<html><body><p>Contact <a href="mailto:privacy@zebrashop.example">privacy@zebrashop.example</a></p></body></html>`)],
      [/zebrashop\.example\/?(\?.*)?$/, () => html(`<html><body><footer><a href="/privacy?ref=${SECRETS.unsubToken}">Privacy policy</a></footer></body></html>`)],
      [/.*/, () => new Response("nf", { status: 404 })],
    ]);
    await enrichCompany(co.id);
    expect(captured.lines.some((l) => l.includes("company enriched"))).toBe(true);
    assertClean();
  });
});
