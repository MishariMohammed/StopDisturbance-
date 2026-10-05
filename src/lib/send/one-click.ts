import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ONE_CLICK_PREFIX, resolveOneClickUrl } from "@/lib/enrich/contacts";
import { safeFetch, SafeFetchError } from "@/lib/net/safe-fetch";

// RFC 8058 one-click unsubscribe (02-capabilities §5.3). POST `List-Unsubscribe=One-Click`,
// form-encoded, through safeFetch (SSRF guard, ≤3 redirects, 10 s, no cookies/auth/Referer, generic UA).
// Only when the header's DKIM signature passed and covered both List-Unsubscribe headers at enrichment.
// Logs host + status only: the URL carries a per-recipient token.

export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

export type OneClickResult =
  | { ok: true; status: number; host: string }
  | { ok: false; reason: "not_eligible" | "http_error" | "network"; status?: number; host?: string; retryable: boolean };

export async function oneClickEligible(contactValue: string): Promise<boolean> {
  if (!contactValue.startsWith(ONE_CLICK_PREFIX)) return false;
  const h = await db.messageHeader.findUnique({
    where: { id: contactValue.slice(ONE_CLICK_PREFIX.length) },
    select: { oneClick: true, dkimPass: true, dkimCoversListUnsub: true, listUnsubHttpsCipher: true },
  });
  return Boolean(h && h.oneClick && h.dkimPass && h.dkimCoversListUnsub && h.listUnsubHttpsCipher);
}

export async function oneClickPost(contactValue: string): Promise<OneClickResult> {
  if (!(await oneClickEligible(contactValue))) return { ok: false, reason: "not_eligible", retryable: false };
  const url = await resolveOneClickUrl(contactValue);
  if (!url) return { ok: false, reason: "not_eligible", retryable: false };
  const host = new URL(url).hostname;
  try {
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: ONE_CLICK_BODY,
      maxBytes: 256 * 1024,
    });
    logger.info({ host, status: res.status }, "one-click unsubscribe");
    if (res.ok) return { ok: true, status: res.status, host };
    return { ok: false, reason: "http_error", status: res.status, host, retryable: res.status === 429 || res.status >= 500 };
  } catch (err) {
    const code = err instanceof SafeFetchError ? err.code : "NETWORK";
    logger.warn({ host, code }, "one-click unsubscribe failed");
    const retryable = code === "TIMEOUT" || code === "NETWORK" || code === "DNS";
    return { ok: false, reason: code === "BLOCKED_ADDRESS" || code === "BAD_SCHEME" || code === "BAD_URL" ? "not_eligible" : "network", host, retryable };
  }
}
