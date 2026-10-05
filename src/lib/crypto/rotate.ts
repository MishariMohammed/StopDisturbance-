import { db } from "@/lib/db";
import { currentKeyVersion, decrypt, encrypt } from "@/lib/crypto/tokens";

// TOKEN_ENC_KEYS rotation (docs/RUNBOOK.md): after TOKEN_ENC_KEY_CURRENT points at the new key, this
// re-encrypts every ciphertext still under an older key, so the old key can be removed afterwards.

export type ReencryptStats = Record<"mailAccounts" | "headers" | "replies" | "evidence" | "payloadSamples", number> & { unreadable: number };

function underCurrentKey(blob: Uint8Array): boolean {
  try {
    decrypt(blob, currentKeyVersion());
    return true;
  } catch {
    return false;
  }
}

function decryptOlder(blob: Uint8Array): string | null {
  for (let v = currentKeyVersion() - 1; v >= 1; v--) {
    try {
      return decrypt(blob, v);
    } catch {
      /* try the next older key */
    }
  }
  return null;
}

/** Walks a table in id order and re-encrypts blobs that the current key can't read. */
async function sweep(
  load: (after: string | undefined) => Promise<{ id: string; blob: Uint8Array | null }[]>,
  save: (id: string, blob: Uint8Array<ArrayBuffer>) => Promise<unknown>,
  stats: ReencryptStats,
): Promise<number> {
  let n = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await load(after);
    if (!rows.length) return n;
    for (const r of rows) {
      if (!r.blob?.length || underCurrentKey(r.blob)) continue;
      const plain = decryptOlder(r.blob);
      if (plain === null) {
        stats.unreadable++;
        continue;
      }
      await save(r.id, encrypt(plain));
      n++;
    }
    after = rows[rows.length - 1].id;
  }
}

const PAGE = 500;
const page = (after: string | undefined) => ({ take: PAGE, orderBy: { id: "asc" as const }, ...(after ? { where: { id: { gt: after } } } : {}) });

export async function reencryptAll(): Promise<ReencryptStats> {
  const current = currentKeyVersion();
  const stats: ReencryptStats = { mailAccounts: 0, headers: 0, replies: 0, evidence: 0, payloadSamples: 0, unreadable: 0 };

  // MailAccount rows record their key version.
  for (const a of await db.mailAccount.findMany({ where: { tokenKeyVersion: { not: current } } })) {
    if (!a.tokenCipher?.length) {
      await db.mailAccount.update({ where: { id: a.id }, data: { tokenKeyVersion: current } });
      continue;
    }
    try {
      const plain = decrypt(a.tokenCipher, a.tokenKeyVersion);
      await db.mailAccount.update({ where: { id: a.id }, data: { tokenCipher: encrypt(plain), tokenKeyVersion: current } });
      stats.mailAccounts++;
    } catch {
      stats.unreadable++;
    }
  }

  stats.headers = await sweep(
    async (after) =>
      (await db.messageHeader.findMany({ ...page(after), where: { listUnsubHttpsCipher: { not: null }, ...(after ? { id: { gt: after } } : {}) }, select: { id: true, listUnsubHttpsCipher: true } }))
        .map((r) => ({ id: r.id, blob: r.listUnsubHttpsCipher })),
    (id, blob) => db.messageHeader.update({ where: { id }, data: { listUnsubHttpsCipher: blob } }),
    stats,
  );
  stats.replies = await sweep(
    async (after) => (await db.inboundReply.findMany({ ...page(after), select: { id: true, bodyCipher: true } })).map((r) => ({ id: r.id, blob: r.bodyCipher })),
    (id, blob) => db.inboundReply.update({ where: { id }, data: { bodyCipher: blob } }),
    stats,
  );
  stats.evidence = await sweep(
    async (after) => (await db.evidenceHeader.findMany({ ...page(after), select: { id: true, rawHeadersCipher: true } })).map((r) => ({ id: r.id, blob: r.rawHeadersCipher })),
    (id, blob) => db.evidenceHeader.update({ where: { id }, data: { rawHeadersCipher: blob } }),
    stats,
  );
  stats.payloadSamples = await sweep(
    async (after) => (await db.llmPayloadSample.findMany({ ...page(after), select: { id: true, payloadCipher: true } })).map((r) => ({ id: r.id, blob: r.payloadCipher })),
    (id, blob) => db.llmPayloadSample.update({ where: { id }, data: { payloadCipher: blob } }),
    stats,
  );
  return stats;
}
