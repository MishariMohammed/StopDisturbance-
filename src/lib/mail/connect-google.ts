import { db } from "@/lib/db";
import { encryptJson } from "@/lib/crypto/tokens";
import { audit } from "@/lib/audit";
import { exchangeCode, GMAIL_SCOPES, grantedScopes } from "@/lib/mail/google-oauth";
import { getProfile } from "@/lib/mail/gmail";
import { enqueueInitialSync } from "@/lib/jobs/queue";

const DEFAULT_SCAN_YEARS = 3; // 04-ux §3.2

export type ConnectResult =
  | { ok: true; accountId: string; partial: boolean }
  | { ok: false; reason: "missing_read_scope" | "no_refresh_token" };

/** Handles the OAuth code: verifies scopes, stores encrypted tokens, starts the first scan. */
export async function connectGoogleMailbox(code: string): Promise<ConnectResult> {
  const tokens = await exchangeCode(code);
  const scopes = grantedScopes(tokens.scope);
  if (!scopes.includes(GMAIL_SCOPES.read)) return { ok: false, reason: "missing_read_scope" };

  const profile = await getProfile(tokens.access_token);
  const address = profile.emailAddress.toLowerCase();
  const existing = await db.mailAccount.findUnique({ where: { address } });
  const refresh = tokens.refresh_token;
  if (!refresh && !existing) return { ok: false, reason: "no_refresh_token" };

  let merged = { ...tokens };
  if (!refresh && existing) {
    const { readTokens } = await import("@/lib/mail/accounts");
    merged = { ...tokens, refresh_token: readTokens(existing).refresh_token };
  }
  const { cipher, keyVersion } = encryptJson(merged);
  const scanFrom = new Date(Date.now() - DEFAULT_SCAN_YEARS * 365.25 * 24 * 3600 * 1000);

  const account = await db.mailAccount.upsert({
    where: { address },
    create: {
      provider: "GOOGLE",
      address,
      providerUserId: address,
      grantedScopes: scopes,
      tokenCipher: cipher,
      tokenKeyVersion: keyVersion,
      scanFrom,
      lastRefreshAt: new Date(),
    },
    update: { grantedScopes: scopes, tokenCipher: cipher, tokenKeyVersion: keyVersion, status: "ACTIVE", lastRefreshAt: new Date() },
  });
  await audit("mailbox.connected", "MailAccount", account.id, { provider: "GOOGLE", scopes });
  if (!existing) await enqueueInitialSync(account.id);
  return { ok: true, accountId: account.id, partial: !scopes.includes(GMAIL_SCOPES.send) };
}
