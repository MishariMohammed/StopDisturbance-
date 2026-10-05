import { describe, expect, it } from "vitest";
import { decrypt, decryptJson, encrypt, encryptJson } from "@/lib/crypto/tokens";

describe("token encryption", () => {
  it("round-trips and never contains the plaintext", () => {
    const blob = encrypt("refresh-token-abc");
    expect(Buffer.from(blob).toString("latin1")).not.toContain("refresh-token-abc");
    expect(decrypt(blob, 1)).toBe("refresh-token-abc");
  });

  it("uses a fresh IV each time", () => {
    expect(Buffer.from(encrypt("x")).equals(Buffer.from(encrypt("x")))).toBe(false);
  });

  it("rejects tampered ciphertext", () => {
    const blob = encrypt("secret");
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(blob, 1)).toThrow();
  });

  it("decrypts with the recorded key version only", () => {
    const blob = encrypt("v2 data", 2);
    expect(decrypt(blob, 2)).toBe("v2 data");
    expect(() => decrypt(blob, 1)).toThrow();
  });

  it("handles JSON payloads", () => {
    const { cipher, keyVersion } = encryptJson({ a: 1 });
    expect(decryptJson(cipher, keyVersion)).toEqual({ a: 1 });
  });
});
