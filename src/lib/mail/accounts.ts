import type { MailAccount } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/crypto/tokens";
import { refreshAccessToken, type GoogleTokens } from "@/lib/mail/google-oauth";
import { refreshMsToken, type MicrosoftTokens } from "@/lib/mail/ms-oauth";
import { audit } from "@/lib/audit";

export class ReconnectRequiredError extends Error {
  constructor(public readonly accountId: string) {
    super("reconnect_required");
  }
}

/** A disconnected mailbox has had its tokens revoked and wiped (src/lib/privacy/erase.ts). */
function assertConnected(account: MailAccount) {
  if (account.status === "DISCONNECTED" || !account.tokenCipher?.length) throw new ReconnectRequiredError(account.id);
}

export function readTokens(account: MailAccount): GoogleTokens {
  return decryptJson<GoogleTokens>(account.tokenCipher, account.tokenKeyVersion);
}

export async function saveTokens(accountId: string, tokens: GoogleTokens | MicrosoftTokens) {
  const { cipher, keyVersion } = encryptJson(tokens);
  await db.mailAccount.update({
    where: { id: accountId },
    data: { tokenCipher: cipher, tokenKeyVersion: keyVersion },
  });
}

/** Returns a valid Google access token, refreshing (and persisting) when within 60 s of expiry. */
export async function googleAccessToken(account: MailAccount): Promise<string> {
  assertConnected(account);
  const tokens = readTokens(account);
  if (tokens.expires_at - Date.now() > 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new ReconnectRequiredError(account.id);
  try {
    const fresh = await refreshAccessToken(tokens.refresh_token);
    // Google returns a new refresh token only sometimes; keep the latest one.
    const merged: GoogleTokens = { ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token };
    await saveTokens(account.id, merged);
    await db.mailAccount.update({ where: { id: account.id }, data: { lastRefreshAt: new Date() } });
    return merged.access_token;
  } catch (err) {
    if ((err as { code?: string }).code === "invalid_grant") {
      await markNeedsReconnect(account, "GOOGLE");
      throw new ReconnectRequiredError(account.id);
    }
    throw err;
  }
}

async function markNeedsReconnect(account: MailAccount, provider: "GOOGLE" | "MICROSOFT") {
  await db.mailAccount.update({ where: { id: account.id }, data: { status: "NEEDS_RECONNECT" } });
  await audit("mailbox.needs_reconnect", "MailAccount", account.id, { provider });
}

/**
 * Returns a valid Graph access token, refreshing when within 60 s of expiry.
 * Microsoft rotates refresh tokens (90-day sliding window), so the new one is persisted on every refresh.
 */
export async function microsoftAccessToken(account: MailAccount): Promise<string> {
  assertConnected(account);
  const tokens = decryptJson<MicrosoftTokens>(account.tokenCipher, account.tokenKeyVersion);
  if (tokens.expires_at - Date.now() > 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new ReconnectRequiredError(account.id);
  try {
    const fresh = await refreshMsToken(tokens.refresh_token, tokens.scope);
    const merged: MicrosoftTokens = {
      access_token: fresh.access_token,
      expires_at: fresh.expires_at,
      scope: fresh.scope || tokens.scope,
      refresh_token: fresh.refresh_token ?? tokens.refresh_token,
    };
    await saveTokens(account.id, merged);
    await db.mailAccount.update({ where: { id: account.id }, data: { lastRefreshAt: new Date() } });
    return merged.access_token;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "invalid_grant" || code === "interaction_required") {
      await markNeedsReconnect(account, "MICROSOFT");
      throw new ReconnectRequiredError(account.id);
    }
    throw err;
  }
}

/** Reads the account fresh from the DB first, so a token rotated earlier in the same job is used. */
export async function microsoftAccessTokenById(accountId: string): Promise<string> {
  return microsoftAccessToken(await db.mailAccount.findUniqueOrThrow({ where: { id: accountId } }));
}
