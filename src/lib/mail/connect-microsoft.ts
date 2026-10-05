import { db } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/crypto/tokens";
import { audit } from "@/lib/audit";
import { graphFetch } from "@/lib/mail/graph";
import {
  decodeIdToken,
  exchangeMsCode,
  grantedMsScopes,
  hasMsScope,
  isTenantAllowed,
  MS_SCOPES,
  type MicrosoftTokens,
} from "@/lib/mail/ms-oauth";
import { enqueueInitialSync } from "@/lib/jobs/queue";

const DEFAULT_SCAN_YEARS = 3; // 04-ux §3.2

export type MsConnectResult =
  | { ok: true; accountId: string; partial: boolean }
  | { ok: false; reason: "tenant_not_allowed" | "missing_read_scope" | "no_refresh_token" | "no_id_token" | "no_address" };

type GraphMe = { id: string; mail?: string | null; userPrincipalName?: string | null };

/** Handles the OAuth code: checks tenant and scopes, stores encrypted tokens, starts the first scan. */
export async function connectMicrosoftMailbox(code: string): Promise<MsConnectResult> {
  const { id_token: idToken, ...tokens } = await exchangeMsCode(code);
  if (!idToken) return { ok: false, reason: "no_id_token" };
  const claims = decodeIdToken(idToken);
  // Only outlook.com/hotmail plus tenants the owner administers (00-review D9). Employer tenants are refused.
  if (!isTenantAllowed(claims.tid)) {
    await audit("mailbox.rejected", "MailAccount", undefined, { provider: "MICROSOFT", reason: "tenant_not_allowed" });
    return { ok: false, reason: "tenant_not_allowed" };
  }
  const scopes = grantedMsScopes(tokens.scope);
  if (!hasMsScope(scopes, MS_SCOPES.read)) return { ok: false, reason: "missing_read_scope" };

  const me = await graphFetch<GraphMe>(tokens.access_token, "", { query: { $select: "id,mail,userPrincipalName" } });
  const address = (me.mail || me.userPrincipalName || claims.email || claims.preferred_username || "").toLowerCase();
  if (!address.includes("@")) return { ok: false, reason: "no_address" };

  const existing = await db.mailAccount.findUnique({ where: { address } });
  let refresh = tokens.refresh_token;
  if (!refresh && existing) {
    refresh = decryptJson<MicrosoftTokens>(existing.tokenCipher, existing.tokenKeyVersion).refresh_token;
  }
  if (!refresh) return { ok: false, reason: "no_refresh_token" };

  const { cipher, keyVersion } = encryptJson({ ...tokens, refresh_token: refresh } satisfies MicrosoftTokens);
  const scanFrom = new Date(Date.now() - DEFAULT_SCAN_YEARS * 365.25 * 24 * 3600 * 1000);
  const providerUserId = claims.oid ?? me.id;

  const account = await db.mailAccount.upsert({
    where: { address },
    create: {
      provider: "MICROSOFT",
      address,
      providerUserId,
      tenantId: claims.tid,
      grantedScopes: scopes,
      tokenCipher: cipher,
      tokenKeyVersion: keyVersion,
      scanFrom,
      lastRefreshAt: new Date(),
    },
    update: {
      grantedScopes: scopes,
      tokenCipher: cipher,
      tokenKeyVersion: keyVersion,
      tenantId: claims.tid,
      status: "ACTIVE",
      lastRefreshAt: new Date(),
    },
  });
  await audit("mailbox.connected", "MailAccount", account.id, { provider: "MICROSOFT", scopes });
  if (!existing) await enqueueInitialSync(account.id);
  return { ok: true, accountId: account.id, partial: !hasMsScope(scopes, MS_SCOPES.send) };
}
