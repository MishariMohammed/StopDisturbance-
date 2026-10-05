import type { MailAccount } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/crypto/tokens";
import { refreshAccessToken, type GoogleTokens } from "@/lib/mail/google-oauth";
import { audit } from "@/lib/audit";

export class ReconnectRequiredError extends Error {
  constructor(public readonly accountId: string) {
    super("reconnect_required");
  }
}

export function readTokens(account: MailAccount): GoogleTokens {
  return decryptJson<GoogleTokens>(account.tokenCipher, account.tokenKeyVersion);
}

export async function saveTokens(accountId: string, tokens: GoogleTokens) {
  const { cipher, keyVersion } = encryptJson(tokens);
  await db.mailAccount.update({
    where: { id: accountId },
    data: { tokenCipher: cipher, tokenKeyVersion: keyVersion },
  });
}

/** Returns a valid Google access token, refreshing (and persisting) when within 60 s of expiry. */
export async function googleAccessToken(account: MailAccount): Promise<string> {
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
      await db.mailAccount.update({ where: { id: account.id }, data: { status: "NEEDS_RECONNECT" } });
      await audit("mailbox.needs_reconnect", "MailAccount", account.id, { provider: "GOOGLE" });
      throw new ReconnectRequiredError(account.id);
    }
    throw err;
  }
}
