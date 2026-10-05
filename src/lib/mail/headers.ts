import { createHash } from "node:crypto";
import { getDomain } from "tldts";

// The only headers the scan ever asks for (00-brief §5 stage 1).
export const SCAN_HEADERS = [
  "From", "Sender", "Reply-To", "To", "Subject", "Date", "Message-ID", "In-Reply-To", "References",
  "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id", "Feedback-ID", "Precedence",
  "Auto-Submitted", "DKIM-Signature", "Authentication-Results", "Return-Path",
] as const;

export type RawHeader = { name: string; value: string };

export type ParsedHeaders = {
  fromAddress: string;
  fromName: string | null;
  fromDomain: string;
  replyToDomain: string | null;
  returnPathDomain: string | null;
  dkimDomains: string[];
  dkimPass: boolean;
  dkimCoversListUnsub: boolean;
  subject: string | null;
  internetMessageId: string | null;
  listUnsubHttps: string | null;
  listUnsubMailto: string | null;
  oneClick: boolean;
  listId: string | null;
  feedbackId: string | null;
  precedence: string | null;
  autoSubmitted: string | null;
  toHashes: string[];
};

function all(headers: RawHeader[], name: string): string[] {
  const n = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
}

function first(headers: RawHeader[], name: string): string | null {
  return all(headers, name)[0] ?? null;
}

export function registrableDomain(hostOrAddress: string): string {
  const host = hostOrAddress.includes("@") ? hostOrAddress.split("@").pop()! : hostOrAddress;
  const clean = host.trim().toLowerCase().replace(/[>\s]/g, "");
  return getDomain(clean) ?? clean;
}

/** Parses `"Name" <a@b.com>` or `a@b.com`. */
export function parseAddress(value: string): { address: string; name: string | null } | null {
  const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  const address = (angle?.[1] ?? value.match(/[^\s<>"',;]+@[^\s<>"',;]+/)?.[0])?.toLowerCase();
  if (!address) return null;
  let name: string | null = null;
  if (angle) {
    name = value.slice(0, value.indexOf("<")).trim().replace(/^"|"$/g, "").trim() || null;
  }
  return { address, name };
}

export function parseAddressList(value: string): string[] {
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => parseAddress(part)?.address)
    .filter((a): a is string => Boolean(a));
}

export function hashAddress(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex");
}

type DkimSig = { d: string; h: string[] };

function parseDkimSignature(value: string): DkimSig | null {
  const tags = new Map<string, string>();
  for (const part of value.replace(/\s+/g, "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) tags.set(part.slice(0, i).toLowerCase(), part.slice(i + 1));
  }
  const d = tags.get("d");
  if (!d) return null;
  return { d: d.toLowerCase(), h: (tags.get("h") ?? "").toLowerCase().split(":").filter(Boolean) };
}

/** Domains with dkim=pass in Authentication-Results (header.d= or header.i=). */
function dkimPassDomains(headers: RawHeader[]): Set<string> {
  const out = new Set<string>();
  for (const ar of all(headers, "Authentication-Results")) {
    for (const m of ar.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/gi)) {
      out.add(m[1].toLowerCase());
    }
  }
  return out;
}

function parseListUnsubscribe(value: string | null) {
  let https: string | null = null;
  let mailto: string | null = null;
  if (value) {
    for (const m of value.matchAll(/<([^>]+)>/g)) {
      const uri = m[1].trim();
      if (!https && /^https:\/\//i.test(uri)) https = uri;
      if (!mailto && /^mailto:/i.test(uri)) mailto = uri;
    }
  }
  return { https, mailto };
}

export function parseHeaders(headers: RawHeader[]): ParsedHeaders | null {
  const from = parseAddress(first(headers, "From") ?? first(headers, "Sender") ?? "");
  if (!from) return null;

  const sigs = all(headers, "DKIM-Signature").map(parseDkimSignature).filter((s): s is DkimSig => !!s);
  const passing = dkimPassDomains(headers);
  const passingSigs = sigs.filter((s) => passing.has(s.d));
  const lu = parseListUnsubscribe(first(headers, "List-Unsubscribe"));
  const luPost = first(headers, "List-Unsubscribe-Post");
  const dkimCoversListUnsub = passingSigs.some(
    (s) => s.h.includes("list-unsubscribe") && s.h.includes("list-unsubscribe-post"),
  );
  const replyTo = parseAddress(first(headers, "Reply-To") ?? "");
  const returnPath = parseAddress(first(headers, "Return-Path") ?? "");
  const to = all(headers, "To").flatMap(parseAddressList);

  return {
    fromAddress: from.address,
    fromName: from.name,
    fromDomain: registrableDomain(from.address),
    replyToDomain: replyTo ? registrableDomain(replyTo.address) : null,
    returnPathDomain: returnPath ? registrableDomain(returnPath.address) : null,
    dkimDomains: [...new Set(sigs.map((s) => s.d))],
    dkimPass: passingSigs.length > 0,
    dkimCoversListUnsub,
    subject: first(headers, "Subject"),
    internetMessageId: first(headers, "Message-ID"),
    listUnsubHttps: lu.https,
    listUnsubMailto: lu.mailto,
    // RFC 8058: HTTPS URI + the exact post body token.
    oneClick: Boolean(lu.https && luPost && /List-Unsubscribe=One-Click/i.test(luPost)),
    listId: first(headers, "List-Id"),
    feedbackId: first(headers, "Feedback-ID"),
    precedence: first(headers, "Precedence")?.toLowerCase() ?? null,
    autoSubmitted: first(headers, "Auto-Submitted")?.toLowerCase() ?? null,
    toHashes: to.map(hashAddress),
  };
}
