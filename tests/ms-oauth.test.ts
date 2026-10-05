import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { decryptJson, encryptJson } from "@/lib/crypto/tokens";
import { microsoftAccessToken } from "@/lib/mail/accounts";
import { connectMicrosoftMailbox } from "@/lib/mail/connect-microsoft";
import { buildMsAuthUrl, CONSUMER_TENANT, decodeIdToken, isTenantAllowed, type MicrosoftTokens } from "@/lib/mail/ms-oauth";
import { enqueueInitialSync } from "@/lib/jobs/queue";
import { json, mockFetch, resetDb } from "./helpers";

vi.mock("@/lib/jobs/queue", () => ({ enqueueInitialSync: vi.fn() }));

const OWN_TENANT = "11111111-2222-3333-4444-555555555555";
const EMPLOYER_TENANT = "99999999-8888-7777-6666-555555555555";

const idToken = (claims: Record<string, string>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

function tokenRoute(claims: Record<string, string>, scope = "openid email offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read") {
  return mockFetch([
    [/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/, () =>
      json({ access_token: "AT", refresh_token: "RT1", expires_in: 3600, scope, id_token: idToken(claims) })],
    [/graph\.microsoft\.com\/v1\.0\/me\?/, () => json({ id: "me1", mail: null, userPrincipalName: "Owner@Outlook.com" })],
  ]);
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(enqueueInitialSync).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MS_ALLOWED_TENANTS;
  resetEnvCache();
});

describe("authorize URL", () => {
  it("asks for read scopes against /common, send only when asked", () => {
    const u = new URL(buildMsAuthUrl("st"));
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("scope")).toBe("openid email offline_access User.Read Mail.Read");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/mail/microsoft/callback");
    expect(new URL(buildMsAuthUrl("st", { withSend: true })).searchParams.get("scope")).toContain("Mail.Send");
  });

  it("decodes id_token claims without a network call", () => {
    expect(decodeIdToken(idToken({ tid: "t", oid: "o" }))).toMatchObject({ tid: "t", oid: "o" });
  });
});

describe("tenant allow-list", () => {
  it("always allows the consumer tenant and adds MS_ALLOWED_TENANTS", () => {
    expect(isTenantAllowed(CONSUMER_TENANT)).toBe(true);
    expect(isTenantAllowed(OWN_TENANT)).toBe(false);
    expect(isTenantAllowed(undefined)).toBe(false);
    process.env.MS_ALLOWED_TENANTS = ` ${OWN_TENANT.toUpperCase()} , other`;
    resetEnvCache();
    expect(isTenantAllowed(OWN_TENANT)).toBe(true);
    expect(isTenantAllowed(EMPLOYER_TENANT)).toBe(false);
  });

  it("connects an outlook.com mailbox (consumer tenant) and starts the scan", async () => {
    vi.stubGlobal("fetch", tokenRoute({ tid: CONSUMER_TENANT, oid: "oid-1" }).fn);
    const r = await connectMicrosoftMailbox("code");
    expect(r).toMatchObject({ ok: true, partial: true });
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { address: "owner@outlook.com" } });
    expect(acc).toMatchObject({ provider: "MICROSOFT", tenantId: CONSUMER_TENANT, providerUserId: "oid-1" });
    expect(acc.grantedScopes).toContain("Mail.Read");
    expect(enqueueInitialSync).toHaveBeenCalledWith(acc.id);
  });

  it("is not partial once Mail.Send is granted", async () => {
    vi.stubGlobal("fetch", tokenRoute({ tid: CONSUMER_TENANT, oid: "o" }, "offline_access Mail.Read Mail.Send User.Read").fn);
    expect(await connectMicrosoftMailbox("code")).toMatchObject({ ok: true, partial: false });
  });

  it("rejects a token from a tenant that is not allowed", async () => {
    const m = tokenRoute({ tid: EMPLOYER_TENANT, oid: "o" });
    vi.stubGlobal("fetch", m.fn);
    expect(await connectMicrosoftMailbox("code")).toEqual({ ok: false, reason: "tenant_not_allowed" });
    expect(await db.mailAccount.count()).toBe(0);
    expect(m.calls.some((u) => u.hostname === "graph.microsoft.com")).toBe(false);
    expect(enqueueInitialSync).not.toHaveBeenCalled();
  });
});

async function msAccount(tokens: MicrosoftTokens) {
  const { cipher, keyVersion } = encryptJson(tokens);
  return db.mailAccount.create({
    data: {
      provider: "MICROSOFT", address: "owner@outlook.com", providerUserId: "o", tenantId: CONSUMER_TENANT,
      grantedScopes: ["Mail.Read"], tokenCipher: cipher, tokenKeyVersion: keyVersion, scanFrom: new Date(),
    },
  });
}

describe("Microsoft token refresh", () => {
  it("persists the rotated refresh token on every refresh", async () => {
    let account = await msAccount({ access_token: "old", refresh_token: "RT1", expires_at: 0, scope: "offline_access Mail.Read" });
    const sent: string[] = [];
    let n = 0;
    vi.stubGlobal("fetch", mockFetch([
      [/oauth2\/v2\.0\/token/, (_u, init) => {
        sent.push(new URLSearchParams(String(init?.body)).get("refresh_token")!);
        n++;
        return json({ access_token: `AT${n}`, refresh_token: `RT${n + 1}`, expires_in: 0, scope: "Mail.Read offline_access" });
      }],
    ]).fn);

    expect(await microsoftAccessToken(account)).toBe("AT1");
    account = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(decryptJson<MicrosoftTokens>(account.tokenCipher, account.tokenKeyVersion).refresh_token).toBe("RT2");
    expect(account.lastRefreshAt).not.toBeNull();

    // expires_in 0 forces the next call to refresh again, which must use the rotated token.
    expect(await microsoftAccessToken(account)).toBe("AT2");
    account = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(sent).toEqual(["RT1", "RT2"]);
    expect(decryptJson<MicrosoftTokens>(account.tokenCipher, account.tokenKeyVersion).refresh_token).toBe("RT3");
  });

  it("marks the mailbox NEEDS_RECONNECT on invalid_grant", async () => {
    const account = await msAccount({ access_token: "old", refresh_token: "RT1", expires_at: 0, scope: "" });
    vi.stubGlobal("fetch", mockFetch([[/oauth2\/v2\.0\/token/, () => json({ error: "invalid_grant" }, 400)]]).fn);
    await expect(microsoftAccessToken(account)).rejects.toThrow("reconnect_required");
    const acc = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.status).toBe("NEEDS_RECONNECT");
  });
});
