import { env } from "@/lib/env";

export const MS_SCOPES = { read: "Mail.Read", send: "Mail.Send" } as const;

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const AUTH_URL = `${AUTHORITY}/authorize`;
const TOKEN_URL = `${AUTHORITY}/token`;
const BASE_SCOPES = ["openid", "email", "offline_access", "User.Read", MS_SCOPES.read];

/** Personal Microsoft accounts (outlook.com / hotmail) all live in this tenant (00-review D9). */
export const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export type MicrosoftTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope: string;
};

export type MicrosoftTokenResponse = MicrosoftTokens & { id_token?: string };

export function msRedirectUri() {
  return `${env().APP_URL}/api/mail/microsoft/callback`;
}

/** Read is always requested; Mail.Send is added on first send (04-ux §4.1) unless `withSend`. */
export function buildMsAuthUrl(state: string, opts: { withSend?: boolean; loginHint?: string } = {}) {
  const scopes = [...BASE_SCOPES];
  if (opts.withSend) scopes.push(MS_SCOPES.send);
  const params = new URLSearchParams({
    client_id: env().MS_CLIENT_ID,
    redirect_uri: msRedirectUri(),
    response_type: "code",
    response_mode: "query",
    scope: scopes.join(" "),
    prompt: "select_account",
    state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<MicrosoftTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env().MS_CLIENT_ID, client_secret: env().MS_CLIENT_SECRET, ...body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = new Error(`microsoft_token_error:${json.error ?? res.status}`);
    (err as Error & { code?: unknown }).code = json.error;
    throw err;
  }
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    scope: String(json.scope ?? ""),
    id_token: json.id_token ? String(json.id_token) : undefined,
  };
}

export function exchangeMsCode(code: string) {
  return tokenRequest({ code, grant_type: "authorization_code", redirect_uri: msRedirectUri(), scope: BASE_SCOPES.join(" ") });
}

/** Microsoft rotates refresh tokens: callers must persist the returned `refresh_token` every time. */
export function refreshMsToken(refreshToken: string, scope?: string) {
  const scopes = grantedMsScopes(scope ?? "").filter((s) => s !== "openid" && s !== "email" && s !== "profile");
  return tokenRequest({
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: (scopes.length ? [...new Set([...scopes, "offline_access"])] : BASE_SCOPES).join(" "),
  });
}

/** Normalises `https://graph.microsoft.com/Mail.Read` and `Mail.Read` to the short form. */
export function grantedMsScopes(scope: string): string[] {
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, ""));
}

export function hasMsScope(scopes: string[], wanted: string) {
  return scopes.some((s) => s.toLowerCase() === wanted.toLowerCase());
}

export type IdTokenClaims = { tid?: string; oid?: string; email?: string; preferred_username?: string };

/**
 * Reads the id_token payload without verifying the signature. Safe here: the token came straight
 * from Microsoft's token endpoint over TLS in exchange for our confidential-client secret.
 */
export function decodeIdToken(idToken: string): IdTokenClaims {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("invalid_id_token");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IdTokenClaims;
}

export function allowedTenants(): Set<string> {
  const extra = env()
    .MS_ALLOWED_TENANTS.split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return new Set([CONSUMER_TENANT, ...extra]);
}

export function isTenantAllowed(tid: string | undefined): boolean {
  return Boolean(tid) && allowedTenants().has(tid!.toLowerCase());
}
