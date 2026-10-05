import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/tokens";
import { dispatchDue } from "@/lib/send/dispatcher";
import { oneClickPost } from "@/lib/send/one-click";
import { resetDb } from "./helpers";
import { host, netState, resetNet } from "./net-mocks";
import { notificationsOff, seedAccount, seedCompany, seedOwner, seedRequest, T0 } from "./m5-helpers";

vi.mock("node:dns/promises", async () => (await import("./net-mocks")).dnsModule);
vi.mock("undici", async () => (await import("./net-mocks")).undiciModule);

const URL_WITH_TOKEN = "https://unsub.acme.example/u?token=SECRET-RECIPIENT-TOKEN";

async function header(accountId: string, dkim: { pass: boolean; covers: boolean }) {
  return db.messageHeader.create({
    data: {
      accountId, providerMsgId: `m-${Math.random()}`, receivedAt: T0, fromAddress: "news@acme.example", fromDomain: "acme.example",
      listUnsubHttpsCipher: encrypt(URL_WITH_TOKEN), oneClick: true, dkimPass: dkim.pass, dkimCoversListUnsub: dkim.covers,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  await seedOwner();
  await notificationsOff();
  resetNet([[/unsub\.acme\.example/, () => new Response("ok", { status: 200 })]]);
  host("unsub.acme.example");
});
afterEach(() => vi.unstubAllGlobals());

describe("RFC 8058 one-click", () => {
  it("POSTs List-Unsubscribe=One-Click with no cookies, auth or Referer when DKIM covered the headers", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    const h = await header(acc.id, { pass: true, covers: true });
    const { request, out } = await seedRequest({
      companyId: co.id, accountId: acc.id, type: "ONE_CLICK", kind: "ONE_CLICK_POST", to: `msg:${h.id}`, body: "List-Unsubscribe=One-Click",
    });
    const res = await dispatchDue(new Date(T0.getTime() + 11_000));
    expect(res).toEqual([{ outboundId: out.id, result: "sent" }]);

    expect(netState.calls).toHaveLength(1);
    const call = netState.calls[0];
    expect(call.url.href).toBe(URL_WITH_TOKEN);
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe("List-Unsubscribe=One-Click");
    const headers = Object.fromEntries(Object.entries(call.init?.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["user-agent"]).toMatch(/^StopDisturbance\//);
    for (const banned of ["cookie", "referer", "authorization", "origin"]) expect(headers[banned]).toBeUndefined();

    const r = await db.request.findUniqueOrThrow({ where: { id: request.id } });
    expect(r.status).toBe("SENT");
    expect(r.clockStart).not.toBeNull();
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } })).httpStatus).toBe(200);
    // The tokenised URL never lands in events or the audit log.
    const logged = JSON.stringify([await db.requestEvent.findMany(), await db.auditLog.findMany({ select: { data: true } })], (_k, v) => (typeof v === "bigint" ? String(v) : v));
    expect(logged).not.toContain("SECRET-RECIPIENT-TOKEN");
  });

  it.each([
    ["dkim fail", { pass: false, covers: false }],
    ["dkim pass but h= does not cover List-Unsubscribe(-Post)", { pass: true, covers: false }],
  ])("never POSTs when %s → FAILED, no request made", async (_n, dkim) => {
    const acc = await seedAccount();
    const co = await seedCompany();
    const h = await header(acc.id, dkim);
    expect(await oneClickPost(`msg:${h.id}`)).toMatchObject({ ok: false, reason: "not_eligible" });
    const { request } = await seedRequest({
      companyId: co.id, accountId: acc.id, type: "ONE_CLICK", kind: "ONE_CLICK_POST", to: `msg:${h.id}`, body: "List-Unsubscribe=One-Click",
    });
    const res = await dispatchDue(new Date(T0.getTime() + 11_000));
    expect(res[0]).toMatchObject({ result: "failed", reason: "one_click_not_eligible" });
    expect(netState.calls).toHaveLength(0);
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("FAILED");
  });

  it("a non-2xx answer is not SENT", async () => {
    resetNet([[/unsub\.acme\.example/, () => new Response("nope", { status: 404 })]]);
    host("unsub.acme.example");
    const acc = await seedAccount();
    const h = await header(acc.id, { pass: true, covers: true });
    expect(await oneClickPost(`msg:${h.id}`)).toMatchObject({ ok: false, reason: "http_error", status: 404, retryable: false });
  });

  it("refuses a target that resolves to a private address (SSRF guard)", async () => {
    resetNet([[/unsub\.acme\.example/, () => new Response("ok", { status: 200 })]]);
    host("unsub.acme.example", "10.0.0.5");
    const acc = await seedAccount();
    const h = await header(acc.id, { pass: true, covers: true });
    expect(await oneClickPost(`msg:${h.id}`)).toMatchObject({ ok: false, reason: "not_eligible" });
    expect(netState.calls).toHaveLength(0);
  });
});
