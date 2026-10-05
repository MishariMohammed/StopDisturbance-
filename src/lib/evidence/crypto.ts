import { currentKeyVersion, decrypt } from "@/lib/crypto/tokens";

// Evidence blobs (InboundReply.bodyCipher, EvidenceHeader.rawHeadersCipher) are encrypted with the current
// key; the rows carry no key version, so decryption tries the current key first, then older ones.

export function decryptAny(blob: Uint8Array): string | null {
  if (!blob?.length) return null;
  for (let v = currentKeyVersion(); v >= 1; v--) {
    try {
      return decrypt(blob, v);
    } catch {
      /* older key */
    }
  }
  return null;
}

/** Reply bodies are stored as the raw RFC 5322 bytes (latin1-mapped before encryption). */
export function replyRaw(blob: Uint8Array): Buffer | null {
  const s = decryptAny(blob);
  return s ? Buffer.from(s, "latin1") : null;
}
