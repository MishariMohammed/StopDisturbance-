import { gmailFetch, GmailAuthError, GmailNotFoundError, type GmailMessageMeta } from "@/lib/mail/gmail";
import { graphFetch, GraphAuthError, GraphNotFoundError, GraphHttpError } from "@/lib/mail/graph";
import type { RawHeader } from "@/lib/mail/headers";

// The ONLY path that reads message bodies (00-brief §8: "gmailFetch()/graphFetch() wrappers allow body
// fetch only for message IDs in matched reply threads or DSNs"). The scan wrappers in src/lib/mail stay
// metadata-only (and their static test still covers that whole directory); this file lives outside it.
//
// Guard: the message's own thread/conversation (read here via metadata, not trusted from the caller) must
// be one of `allowedThreadIds` (threads of our sent requests, or threads the poller matched by the SD-XXXX
// subject token), OR its In-Reply-To/References must name one of `ourMessageIds` (replies split into a new
// ticket thread and DSNs/bounces of our mail). Anything else throws ReplyBodyGuardError before any body
// request is made. Returns the raw RFC 5322 message (stored encrypted as evidence).

export class ReplyBodyGuardError extends Error {
  constructor() {
    super("reply_body_not_allowed");
    this.name = "ReplyBodyGuardError";
  }
}

export const MAX_REPLY_BYTES = 5 * 1024 * 1024;
const GUARD_HEADERS = ["In-Reply-To", "References", "Message-ID"];

const ids = (v: string | undefined | null) => (v ?? "").match(/<[^<>\s]+>/g)?.map((x) => x.toLowerCase()) ?? [];

function guardPasses(threadId: string | null | undefined, headers: RawHeader[], allowedThreadIds: Iterable<string>, ourMessageIds: Iterable<string>) {
  const allowed = new Set(allowedThreadIds);
  if (threadId && allowed.has(threadId)) return true;
  const ours = new Set([...ourMessageIds].map((m) => (m.trim().startsWith("<") ? m.trim() : `<${m.trim()}>`).toLowerCase()));
  if (!ours.size) return false;
  const refs = headers
    .filter((h) => /^(in-reply-to|references)$/i.test(h.name))
    .flatMap((h) => ids(h.value));
  return refs.some((r) => ours.has(r));
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function gmailFetchReplyBody(
  token: string,
  messageId: string,
  allowedThreadIds: Iterable<string>,
  ourMessageIds: Iterable<string> = [],
): Promise<Buffer> {
  const meta = await gmailFetch<GmailMessageMeta>(token, `/messages/${encodeURIComponent(messageId)}`, {
    method: "messages.get",
    query: { format: "metadata", metadataHeaders: GUARD_HEADERS },
  });
  if (!guardPasses(meta.threadId, meta.payload?.headers ?? [], allowedThreadIds, ourMessageIds)) throw new ReplyBodyGuardError();

  const url = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "raw");
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) throw new GmailNotFoundError();
  if (res.status === 401) throw new GmailAuthError();
  if (!res.ok) throw new Error(`gmail_http_${res.status}`);
  const body = (await res.json()) as { raw?: string; sizeEstimate?: number };
  if (!body.raw) throw new Error("gmail_raw_missing");
  const buf = Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length > MAX_REPLY_BYTES ? buf.subarray(0, MAX_REPLY_BYTES) : buf;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0/me";

export async function graphFetchReplyBody(
  token: string,
  messageId: string,
  allowedConversationIds: Iterable<string>,
  ourMessageIds: Iterable<string> = [],
): Promise<Buffer> {
  const meta = await graphFetch<{ conversationId?: string; internetMessageHeaders?: RawHeader[] }>(
    token,
    `/messages/${encodeURIComponent(messageId)}`,
    { query: { $select: "conversationId,internetMessageHeaders" } },
  );
  if (!guardPasses(meta.conversationId, meta.internetMessageHeaders ?? [], allowedConversationIds, ourMessageIds)) {
    throw new ReplyBodyGuardError();
  }
  const res = await fetch(`${GRAPH_BASE}/messages/${encodeURIComponent(messageId)}/$value`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) throw new GraphNotFoundError();
  if (res.status === 401) throw new GraphAuthError();
  if (!res.ok) throw new GraphHttpError(res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > MAX_REPLY_BYTES ? buf.subarray(0, MAX_REPLY_BYTES) : buf;
}
