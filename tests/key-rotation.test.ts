import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { decrypt, encrypt } from "@/lib/crypto/tokens";
import { reencryptAll } from "@/lib/crypto/rotate";
import { resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  process.env.TOKEN_ENC_KEY_CURRENT = "1";
  resetEnvCache();
});

describe("TOKEN_ENC_KEYS rotation", () => {
  it("re-encrypts tokens, reply bodies and payload samples from key 1 to key 2", async () => {
    const account = await db.mailAccount.create({
      data: { provider: "GOOGLE", address: "a@gmail.com", providerUserId: "a", grantedScopes: [], tokenCipher: encrypt('{"refresh_token":"r"}', 1), tokenKeyVersion: 1, scanFrom: new Date("2024-01-01") },
    });
    const sample = await db.llmPayloadSample.create({ data: { callId: "c1", payloadCipher: encrypt("payload", 1) } });

    process.env.TOKEN_ENC_KEY_CURRENT = "2";
    resetEnvCache();
    const stats = await reencryptAll();
    expect(stats).toMatchObject({ mailAccounts: 1, payloadSamples: 1, unreadable: 0 });

    const a = await db.mailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(a.tokenKeyVersion).toBe(2);
    expect(decrypt(a.tokenCipher, 2)).toBe('{"refresh_token":"r"}');
    const s = await db.llmPayloadSample.findUniqueOrThrow({ where: { id: sample.id } });
    expect(decrypt(s.payloadCipher, 2)).toBe("payload");
    expect(() => decrypt(s.payloadCipher, 1)).toThrow();

    // Idempotent: a second run has nothing left to do.
    expect(await reencryptAll()).toMatchObject({ mailAccounts: 0, payloadSamples: 0, unreadable: 0 });
  });
});
