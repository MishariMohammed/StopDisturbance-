import { db } from "@/lib/db";
import { encryptJson } from "@/lib/crypto/tokens";
import { hashAddress, parseHeaders } from "@/lib/mail/headers";
import { toHeaderRow } from "@/lib/mail/gmail-sync";
import type { PersonalContext } from "@/lib/scan/resolve";
import type { HeaderSignals } from "@/lib/scan/signals";
import { OWNER, RESOLVE_FIXTURES, SENT_TO, type ResolveFixture } from "./fixtures/resolve-headers";

export function toSignals(f: ResolveFixture): HeaderSignals {
  const p = parseHeaders(f.headers)!;
  return {
    fromAddress: p.fromAddress,
    fromName: p.fromName,
    fromDomain: p.fromDomain,
    replyToDomain: p.replyToDomain,
    returnPathDomain: p.returnPathDomain,
    dkimDomains: p.dkimDomains,
    dkimPass: p.dkimPass,
    hasListUnsub: Boolean(p.listUnsubHttps || p.listUnsubMailto),
    listUnsubHttpsHost: p.listUnsubHttps ? new URL(p.listUnsubHttps).hostname : null,
    listUnsubMailto: p.listUnsubMailto,
    oneClick: p.oneClick,
    listId: p.listId,
    feedbackId: p.feedbackId,
    precedence: p.precedence,
    autoSubmitted: p.autoSubmitted,
    labels: f.labels,
    subject: p.subject,
  };
}

export const CTX: PersonalContext = {
  sentToHashes: new Set(SENT_TO.map(hashAddress)),
  ownerAddresses: new Set(OWNER.loginEmails),
  ownerDomains: new Set(OWNER.employerDomains),
};

async function account(address: string, sentTo: string[] = []) {
  const { cipher, keyVersion } = encryptJson({ access_token: "AT" });
  return db.mailAccount.create({
    data: {
      provider: "GOOGLE", address, providerUserId: address, grantedScopes: [], tokenCipher: cipher, tokenKeyVersion: keyVersion,
      scanFrom: new Date("2023-01-01"), sentToHashes: sentTo.map(hashAddress),
    },
  });
}

export async function seedFixtureHeaders(accountId: string, fixtures = RESOLVE_FIXTURES) {
  const rows = fixtures.map((f, i) => {
    const r = toHeaderRow(accountId, {
      id: `f${i}`,
      threadId: `t${i}`,
      labelIds: f.labels,
      internalDate: String(Date.UTC(2026, 0, 1 + i)),
      payload: { headers: f.headers },
    });
    if (r.kind !== "header") throw new Error(`fixture ${f.name} not a header row`);
    return r.row;
  });
  await db.messageHeader.createMany({ data: rows });
}

export async function seedOwnerAndAccount() {
  await db.owner.create({ data: { id: "owner", fullName: OWNER.fullName, loginEmails: OWNER.loginEmails, employerDomains: OWNER.employerDomains } });
  return account(OWNER.loginEmails[0], SENT_TO);
}

