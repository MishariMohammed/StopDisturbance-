import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { logger } from "@/lib/logger";

// The single outbound HTTP path for third-party URLs (00-brief §8): policy scrape, privacy.txt,
// datasets, favicon, one-click POST. SSRF guard: every hop's host is resolved here, every address
// must be public unicast, and the TCP connection is pinned to the vetted address (no DNS rebinding).
// Deliberately ignores HTTP(S)_PROXY: a proxy would re-resolve the host and defeat the pin.

export const USER_AGENT = "StopDisturbance/1.0 (+privacy request helper)";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 3;

export type SafeFetchErrorCode =
  | "BAD_URL"
  | "BAD_SCHEME"
  | "BLOCKED_ADDRESS"
  | "DNS"
  | "TOO_MANY_REDIRECTS"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "NETWORK";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export type SafeFetchOptions = {
  method?: "GET" | "HEAD" | "POST";
  /** Extra request headers. Cookie, Referer, Authorization, Host and User-Agent are dropped. */
  headers?: Record<string, string>;
  body?: string;
  /** http: is refused unless explicitly allowed. */
  allowHttp?: boolean;
  maxRedirects?: number;
  /** Total budget for all hops including the body. */
  timeoutMs?: number;
  maxBytes?: number;
};

export type SafeResponse = {
  /** Final URL after redirects. */
  url: string;
  status: number;
  ok: boolean;
  headers: Headers;
  body: Buffer;
  redirects: number;
  text(): string;
  json<T = unknown>(): T;
};

const DROP_HEADERS = new Set(["cookie", "cookie2", "referer", "authorization", "proxy-authorization", "host", "user-agent"]);

/** True only for public unicast addresses (IPv4 or IPv6; IPv4-mapped IPv6 is checked as IPv4). */
export function isPublicAddress(address: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(address.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  } catch {
    return false;
  }
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  // Everything ipaddr.js does not class as plain unicast is refused: private, loopback, link-local
  // (incl. 169.254.169.254), CGNAT, multicast, unique-local, unspecified, reserved, 6to4/Teredo/NAT64.
  return addr.range() === "unicast";
}

type Vetted = { address: string; family: 4 | 6 };

async function vetHost(hostname: string): Promise<Vetted> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new SafeFetchError("BLOCKED_ADDRESS", "Address is not public");
    return { address: host, family: host.includes(":") ? 6 : 4 };
  }
  if (!/^[a-z0-9._-]+$/i.test(host) || host.endsWith(".localhost") || host === "localhost") {
    throw new SafeFetchError("BLOCKED_ADDRESS", "Host is not allowed");
  }
  let addrs: LookupAddress[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError("DNS", "DNS lookup failed");
  }
  if (!addrs.length) throw new SafeFetchError("DNS", "DNS lookup returned no address");
  // Any private answer poisons the name: an attacker could otherwise race us between records.
  if (addrs.some((a) => !isPublicAddress(a.address))) throw new SafeFetchError("BLOCKED_ADDRESS", "Host resolves to a non-public address");
  const first = addrs[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A dispatcher whose sockets can only reach the vetted address, whatever the hostname. */
function pinnedAgent(v: Vetted, timeoutMs: number): Agent {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: (_host: string, opts: { all?: boolean }, cb: LookupCb) => {
        if (opts?.all) cb(null, [{ address: v.address, family: v.family }]);
        else cb(null, v.address, v.family);
      },
    },
    maxRedirections: 0,
  } as ConstructorParameters<typeof Agent>[0]);
}

function checkUrl(raw: string | URL, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("BAD_URL", "Invalid URL");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new SafeFetchError("BAD_SCHEME", "Scheme not allowed");
  if (url.username || url.password) throw new SafeFetchError("BAD_URL", "Credentials in URL");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 443 && port !== 80) throw new SafeFetchError("BAD_URL", "Port not allowed");
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SafeFetchError("TOO_LARGE", "Response too large");
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SafeFetchError("TOO_LARGE", "Response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a third-party URL with the SSRF guard. https only (http with `allowHttp`), ≤3 redirects
 * each re-validated, 10 s total timeout, 2 MB body cap, no cookies, no Referer, fixed UA.
 * Logs host + status only (URLs can carry per-recipient tokens).
 */
export async function safeFetch(input: string | URL, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  headers["user-agent"] = USER_AGENT;

  let url = checkUrl(input, Boolean(opts.allowHttp));
  let method = opts.method ?? "GET";
  let body = opts.body;
  for (let hop = 0; ; hop++) {
    const vetted = await vetHost(url.hostname);
    const agent = pinnedAgent(vetted, timeoutMs);
    try {
      let res: Response;
      try {
        res = (await undiciFetch(url, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
          redirect: "manual",
          signal,
          dispatcher: agent,
        })) as unknown as Response;
      } catch (err) {
        if (signal.aborted) throw new SafeFetchError("TIMEOUT", "Request timed out");
        throw new SafeFetchError("NETWORK", (err as Error).name || "Network error");
      }
      logger.info({ host: url.hostname, status: res.status }, "safeFetch");

      const location = res.headers.get("location");
      if (REDIRECTS.has(res.status) && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw new SafeFetchError("TOO_MANY_REDIRECTS", "Too many redirects");
        url = checkUrl(new URL(location, url), Boolean(opts.allowHttp));
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      let buf: Buffer;
      try {
        buf = method === "HEAD" ? Buffer.alloc(0) : await readCapped(res, maxBytes);
      } catch (err) {
        if (err instanceof SafeFetchError) throw err;
        if (signal.aborted) throw new SafeFetchError("TIMEOUT", "Request timed out");
        throw new SafeFetchError("NETWORK", "Body read failed");
      }
      return {
        url: url.href,
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: res.headers,
        body: buf,
        redirects: hop,
        text: () => buf.toString("utf8"),
        json: <T>() => JSON.parse(buf.toString("utf8")) as T,
      };
    } finally {
      agent.close().catch(() => {});
    }
  }
}
