// Re-encrypts all stored ciphertexts with TOKEN_ENC_KEY_CURRENT (docs/RUNBOOK.md "TOKEN_ENC_KEYS rotation").
// Run with the production environment, e.g. `railway run --service worker npx tsx scripts/reencrypt-keys.ts`.
import { reencryptAll } from "@/lib/crypto/rotate";
import { db } from "@/lib/db";

const stats = await reencryptAll();
console.log(JSON.stringify(stats));
await db.$disconnect();
if (stats.unreadable > 0) {
  console.error(`${stats.unreadable} value(s) could not be decrypted with any key: keep the old keys until resolved.`);
  process.exit(1);
}
