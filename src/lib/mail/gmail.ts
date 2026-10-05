import { backoffMs, UnitBucket } from "@/lib/mail/rate-limit";
import { SCAN_HEADERS, type RawHeader } from "@/lib/mail/headers";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Quota units per method (02-capabilities §1).
const UNITS: Record<string, number> = {
  "messages.list": 5,
  "messages.get": 5,
  "history.list": 2,
  "getProfile": 1,
  "messages.send": 100,
};

// 6,000 units/min is the conservative per-user figure for new projects; we run at 80%.
const bucket = new UnitBucket(4_800);

export class GmailNotFoundError extends Error {
  constructor() {
    super("gmail_not_found");
  }
}

export class GmailAuthError extends Error {
  constructor() {
    super("gmail_unauthorized");
  }
}

type FetchOpts = {
  method: keyof typeof UNITS;
  query?: Record<string, string | string[] | undefined>;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
};

/**
 * The single entry point to the Gmail REST API for the scan.
 * Bodies are unreachable from here: any `format` other than metadata/minimal throws
 * (00-brief §8, M1 acceptance). Reply-body fetches get their own guarded path in M5.
 */
export async function gmailFetch<T>(accessToken: string, path: string, opts: FetchOpts): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  const format = url.searchParams.get("format");
  if (format && format !== "metadata" && format !== "minimal") {
    throw new Error(`gmailFetch: format=${format} is not allowed in the scan`);
  }
  if (/\/attachments\b/.test(path) || /[?&]format=(full|raw)\b/i.test(url.search)) {
    throw new Error("gmailFetch: body or attachment access is not allowed in the scan");
  }

  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 6;
  for (let attempt = 0; ; attempt++) {
    await bucket.take(UNITS[opts.method]);
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 404) throw new GmailNotFoundError();
    if (res.status === 401) throw new GmailAuthError();
    const body = await res.text();
    const rateLimited =
      res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body));
    if ((rateLimited || res.status >= 500) && attempt + 1 < maxAttempts) {
      await sleep(backoffMs(attempt, res.headers.get("retry-after")));
      continue;
    }
    throw new Error(`gmail_http_${res.status}`);
  }
}

export type GmailMessageMeta = {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate: string;
  historyId?: string;
  payload?: { headers?: RawHeader[] };
};

export function getProfile(token: string) {
  return gmailFetch<{ emailAddress: string; historyId: string }>(token, "/profile", { method: "getProfile" });
}

export function listMessages(token: string, q: string, pageToken?: string) {
  return gmailFetch<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(token, "/messages", {
    method: "messages.list",
    query: { q, includeSpamTrash: "true", maxResults: "500", pageToken },
  });
}

export function getMessageMetadata(token: string, id: string, opts: { sleep?: FetchOpts["sleep"] } = {}) {
  return gmailFetch<GmailMessageMeta>(token, `/messages/${encodeURIComponent(id)}`, {
    method: "messages.get",
    query: { format: "metadata", metadataHeaders: [...SCAN_HEADERS] },
    sleep: opts.sleep,
  });
}

export type HistoryPage = {
  history?: { messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[] }[];
  nextPageToken?: string;
  historyId: string;
};

export function listHistory(token: string, startHistoryId: string, pageToken?: string) {
  return gmailFetch<HistoryPage>(token, "/history", {
    method: "history.list",
    query: { startHistoryId, historyTypes: "messageAdded", maxResults: "500", pageToken },
  });
}
