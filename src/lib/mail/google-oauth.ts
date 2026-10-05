import { env } from "@/lib/env";

export const GMAIL_SCOPES = {
  read: "https://www.googleapis.com/auth/gmail.readonly",
  send: "https://www.googleapis.com/auth/gmail.send",
} as const;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope: string;
};

export function redirectUri() {
  return `${env().APP_URL}/api/mail/google/callback`;
}

/**
 * Read is always requested; send is requested on first send (04-ux §4.1) unless `withSend`.
 * `include_granted_scopes` lets the later send grant add to the existing one.
 */
export function buildAuthUrl(state: string, opts: { withSend?: boolean; loginHint?: string } = {}) {
  const scopes = ["openid", "email", GMAIL_SCOPES.read];
  if (opts.withSend) scopes.push(GMAIL_SCOPES.send);
  const params = new URLSearchParams({
    client_id: env().GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env().GOOGLE_CLIENT_ID,
      client_secret: env().GOOGLE_CLIENT_SECRET,
      ...body,
    }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = new Error(`google_token_error:${json.error ?? res.status}`);
    (err as Error & { code?: unknown }).code = json.error;
    throw err;
  }
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    scope: String(json.scope ?? ""),
  };
}

export function exchangeCode(code: string) {
  return tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
}

export function refreshAccessToken(refreshToken: string) {
  return tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
}

export function grantedScopes(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}
