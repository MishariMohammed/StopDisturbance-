import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

// AES-256-GCM with a random 96-bit IV. Stored layout: [version:1][iv:12][tag:16][ciphertext].
const VERSION_BYTE = 1;

function keys(): Map<number, Buffer> {
  const raw = JSON.parse(env().TOKEN_ENC_KEYS) as Record<string, string>;
  const map = new Map<number, Buffer>();
  for (const [v, b64] of Object.entries(raw)) {
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) throw new Error(`TOKEN_ENC_KEYS[${v}] must be 32 bytes`);
    map.set(Number(v), key);
  }
  return map;
}

export function currentKeyVersion(): number {
  return env().TOKEN_ENC_KEY_CURRENT;
}

export function encrypt(plain: string, keyVersion = currentKeyVersion()): Uint8Array<ArrayBuffer> {
  const key = keys().get(keyVersion);
  if (!key) throw new Error(`No encryption key for version ${keyVersion}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  // Copy into a plain ArrayBuffer-backed array (what Prisma Bytes expects).
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION_BYTE]), iv, cipher.getAuthTag(), ct]));
}

export function decrypt(blob: Uint8Array, keyVersion: number): string {
  const buf = Buffer.from(blob);
  if (buf[0] !== VERSION_BYTE) throw new Error("Unknown ciphertext format");
  const key = keys().get(keyVersion);
  if (!key) throw new Error(`No encryption key for version ${keyVersion}`);
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ct = buf.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function encryptJson(value: unknown) {
  const v = currentKeyVersion();
  return { cipher: encrypt(JSON.stringify(value), v), keyVersion: v };
}

export function decryptJson<T>(blob: Uint8Array, keyVersion: number): T {
  return JSON.parse(decrypt(blob, keyVersion)) as T;
}
