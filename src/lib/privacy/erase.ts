import { Prisma, type MailAccount } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { decryptJson } from "@/lib/crypto/tokens";
import { REVOKE_URL, type GoogleTokens } from "@/lib/mail/google-oauth";
import { purgeHeaders } from "@/lib/jobs/retention";

// Erase everything, disconnect a mailbox (00-brief §4 "Erase everything", §8 "Erase and disconnect").
// Google tokens are revoked at oauth2.googleapis.com/revoke. Microsoft has no revoke endpoint for a
// consumer app's refresh token, so the owner removes the grant at account.live.com/consent/Manage.

export const MICROSOFT_CONSENT_URL = "https://account.live.com/consent/Manage";

export type RevokeResult = { address: string; provider: "GOOGLE" | "MICROSOFT"; revoked: boolean; consentUrl?: string };

/** Revokes the Google grant (refresh token revokes the whole grant). Never throws. */
export async function revokeAccount(account: MailAccount): Promise<RevokeResult> {
  if (account.provider === "MICROSOFT") {
    return { address: account.address, provider: "MICROSOFT", revoked: false, consentUrl: MICROSOFT_CONSENT_URL };
  }
  let token: string | undefined;
  try {
    const t = decryptJson<GoogleTokens>(account.tokenCipher, account.tokenKeyVersion);
    token = t.refresh_token ?? t.access_token;
  } catch {
    token = undefined; // already wiped or unreadable: nothing to revoke
  }
  if (!token) return { address: account.address, provider: "GOOGLE", revoked: false };
  try {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    // 400 invalid_token: Google no longer knows the token (already revoked by the owner) — same outcome.
    const revoked = res.ok || res.status === 400;
    if (!revoked) logger.warn({ status: res.status }, "google revoke failed");
    return { address: account.address, provider: "GOOGLE", revoked };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "google revoke failed");
    return { address: account.address, provider: "GOOGLE", revoked: false };
  }
}

/**
 * Disconnect one mailbox: revoke its grant, wipe its tokens and sync state, delete its headers
 * (one-click references move to another mailbox's header where possible). The row stays as
 * DISCONNECTED so existing requests keep their mailbox label; reconnecting reactivates it.
 */
export async function disconnectMailbox(accountId: string) {
  const account = await db.mailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new Error("not_found");
  const revoke = await revokeAccount(account);
  const purge = await purgeHeaders({ accountId });
  await db.mailAccount.update({
    where: { id: accountId },
    data: {
      status: "DISCONNECTED",
      tokenCipher: new Uint8Array(0),
      grantedScopes: [],
      syncCursor: Prisma.DbNull,
      scanProgress: Prisma.DbNull,
      sentToHashes: [],
    },
  });
  await audit("mailbox.disconnected", "MailAccount", accountId, { provider: account.provider, revoked: revoke.revoked, headers: purge.headers });
  return { revoke, headersDeleted: purge.headers };
}

export type EraseResult = {
  revocations: RevokeResult[];
  microsoftConsentUrl: string | null;
  keptAuditRows: number;
};

/**
 * Erase everything: revoke every mailbox grant, then empty every table (domain data and Better Auth
 * users/sessions/accounts). AuditLog rows about requests that were actually sent survive only when
 * `keepSentAudit` is true (AuditLog blocks UPDATE by trigger; DELETE and TRUNCATE are allowed).
 */
export async function eraseEverything(opts: { keepSentAudit: boolean }): Promise<EraseResult> {
  const accounts = await db.mailAccount.findMany();
  const revocations: RevokeResult[] = [];
  for (const a of accounts) revocations.push(await revokeAccount(a));

  let keptAuditRows = 0;
  if (opts.keepSentAudit) {
    const sent = await db.outboundMessage.findMany({ where: { sentAt: { not: null } }, select: { requestId: true }, distinct: ["requestId"] });
    const sentIds = sent.map((s) => s.requestId);
    await db.auditLog.deleteMany({ where: { NOT: { entity: "request", entityId: { in: sentIds } } } });
    keptAuditRows = await db.auditLog.count();
  } else {
    await db.$executeRawUnsafe(`TRUNCATE "public"."AuditLog" RESTART IDENTITY`);
  }

  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'AuditLog')`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  if (list) await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);

  logger.info({ mailboxes: revocations.length, keptAuditRows }, "erase everything done");
  return {
    revocations,
    microsoftConsentUrl: revocations.some((r) => r.provider === "MICROSOFT") ? MICROSOFT_CONSENT_URL : null,
    keptAuditRows,
  };
}
