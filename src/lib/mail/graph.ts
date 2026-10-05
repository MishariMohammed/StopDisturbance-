import { backoffMs, UnitBucket } from "@/lib/mail/rate-limit";

const ROOT = "https://graph.microsoft.com/v1.0";
const BASE = `${ROOT}/me`;

// Outlook: 10,000 requests / 10 min per app per mailbox (02-capabilities §2.4); we run at 80%.
// Every inner request of a $batch counts, so batches take one unit per inner request.
const bucket = new UnitBucket(800);

export const BATCH_MAX = 20;
export const BATCH_CONCURRENCY = 3;

export class GraphNotFoundError extends Error {
  constructor() {
    super("graph_not_found");
  }
}

export class GraphAuthError extends Error {
  constructor() {
    super("graph_unauthorized");
  }
}

/** The delta token is too old (410 Gone / syncStateNotFound): the folder must be resynced from scratch. */
export class GraphDeltaExpiredError extends Error {
  constructor() {
    super("graph_delta_expired");
  }
}

export class GraphHttpError extends Error {
  constructor(public readonly status: number) {
    super(`graph_http_${status}`);
  }
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Message content the scan must never read (00-brief §8). Reply bodies get their own path in M5.
const FORBIDDEN_FIELDS = new Set(["body", "uniquebody", "bodypreview", "attachments", "mimecontent"]);
const CONTINUATION_PARAMS = ["$skiptoken", "$deltatoken"];

/**
 * Throws if a Graph URL could return message bodies or attachments.
 * Message reads must carry an explicit `$select` (Graph returns `body` by default), except opaque
 * nextLink/deltaLink continuations, whose `$select` was fixed (and checked) on the first request.
 */
export function assertScanSafe(url: URL) {
  const path = decodeURIComponent(url.pathname).toLowerCase();
  if (/\/attachments\b/.test(path) || /\/\$value\b/.test(path)) {
    throw new Error("graphFetch: body or attachment access is not allowed in the scan");
  }
  const params = new Map([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of ["$select", "$expand"]) {
    const fields = (params.get(key) ?? "").split(",").map((f) => f.trim().toLowerCase().split("(")[0]);
    const bad = fields.find((f) => FORBIDDEN_FIELDS.has(f));
    if (bad) throw new Error(`graphFetch: ${key}=${bad} is not allowed in the scan`);
  }
  const isMessageRead = /\/messages(\/[^/]+)?(\/delta)?\/?$/.test(path);
  const isContinuation = CONTINUATION_PARAMS.some((p) => params.has(p));
  if (isMessageRead && !isContinuation && !params.has("$select")) {
    throw new Error("graphFetch: message reads need an explicit $select (the default includes body)");
  }
}

type RequestOpts = { sleep?: Sleep; maxAttempts?: number; headers?: Record<string, string> };

async function send<T>(
  token: string,
  url: URL,
  init: { method: "GET" | "POST"; body?: string; units: number },
  opts: RequestOpts,
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const maxAttempts = opts.maxAttempts ?? 6;
  for (let attempt = 0; ; attempt++) {
    await bucket.take(init.units);
    const res = await fetch(url, {
      method: init.method,
      body: init.body,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
    });
    if (res.ok) return (await res.json()) as T;
    const text = await res.text();
    if (res.status === 410 || /syncState(NotFound|Invalid)|resyncRequired/i.test(text)) throw new GraphDeltaExpiredError();
    if (res.status === 404) throw new GraphNotFoundError();
    if (res.status === 401) throw new GraphAuthError();
    if ((res.status === 429 || res.status >= 500) && attempt + 1 < maxAttempts) {
      await sleep(backoffMs(attempt, res.headers.get("retry-after")));
      continue;
    }
    throw new GraphHttpError(res.status);
  }
}

export type GraphFetchOpts = RequestOpts & { query?: Record<string, string | undefined> };

/**
 * The single entry point to Microsoft Graph for the scan. `pathOrUrl` is either a path under
 * `/v1.0/me` or an absolute `@odata.nextLink` / `@odata.deltaLink` returned by Graph.
 */
export async function graphFetch<T>(token: string, pathOrUrl: string, opts: GraphFetchOpts = {}): Promise<T> {
  let url: URL;
  if (/^https:\/\//i.test(pathOrUrl)) {
    url = new URL(pathOrUrl);
    if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/")) {
      throw new Error("graphFetch: refusing a non-Graph URL");
    }
  } else {
    url = new URL(`${BASE}${pathOrUrl}`);
  }
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  assertScanSafe(url);
  return send<T>(token, url, { method: "GET", units: 1 }, opts);
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** One GET inside a JSON batch; `url` is relative to `/v1.0`, e.g. `/me/messages/{id}?$select=...`. */
export type BatchRequest = { id: string; url: string };
export type BatchResult<T> = { status: number; body?: T };

type BatchResponse = {
  responses: { id: string; status: number; headers?: Record<string, string>; body?: unknown }[];
};

function header(headers: Record<string, string> | undefined, name: string) {
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
  return key ? headers![key] : null;
}

/**
 * GETs via JSON `$batch`: ≤20 requests per batch, ≤3 batches in flight (02-capabilities §2.4).
 * Inner 429/503 responses are retried after their own `Retry-After`; other statuses are returned as is.
 */
export async function graphBatch<T>(
  token: string,
  requests: BatchRequest[],
  opts: RequestOpts & { concurrency?: number } = {},
): Promise<Map<string, BatchResult<T>>> {
  for (const r of requests) assertScanSafe(new URL(`${ROOT}${r.url}`));
  const sleep = opts.sleep ?? realSleep;
  const maxAttempts = opts.maxAttempts ?? 6;
  const chunks: BatchRequest[][] = [];
  for (let i = 0; i < requests.length; i += BATCH_MAX) chunks.push(requests.slice(i, i + BATCH_MAX));

  const results = new Map<string, BatchResult<T>>();
  await mapLimit(chunks, Math.min(opts.concurrency ?? BATCH_CONCURRENCY, BATCH_CONCURRENCY), async (chunk) => {
    let pending = chunk;
    for (let attempt = 0; pending.length; attempt++) {
      const res = await send<BatchResponse>(
        token,
        new URL(`${ROOT}/$batch`),
        {
          method: "POST",
          units: pending.length,
          body: JSON.stringify({ requests: pending.map((r) => ({ id: r.id, method: "GET", url: r.url })) }),
        },
        opts,
      );
      const retry: BatchRequest[] = [];
      let waitMs = 0;
      const byId = new Map(pending.map((r) => [r.id, r]));
      for (const item of res.responses) {
        const throttled = item.status === 429 || item.status === 503;
        if (throttled && attempt + 1 < maxAttempts && byId.has(item.id)) {
          retry.push(byId.get(item.id)!);
          waitMs = Math.max(waitMs, backoffMs(attempt, header(item.headers, "retry-after")));
        } else {
          results.set(item.id, { status: item.status, body: item.body as T | undefined });
        }
      }
      if (retry.length) await sleep(waitMs);
      pending = retry;
    }
  });
  return results;
}
