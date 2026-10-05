import type { MailAccount } from "@prisma/client";
import { googleAccessToken, microsoftAccessToken } from "@/lib/mail/accounts";
import { gmailFetch, type GmailMessageMeta } from "@/lib/mail/gmail";
import { graphFetch } from "@/lib/mail/graph";
import type { RawHeader } from "@/lib/mail/headers";
import { messageIdsIn } from "@/lib/track/match";
import { gmailFetchReplyBody, graphFetchReplyBody } from "@/lib/track/reply-body";

// Provider-neutral reads for the reply poller. Metadata reads go through the scan-safe wrappers
// (gmailFetch format=metadata / graphFetch $select=internetMessageHeaders); bodies only through the
// guarded reply-body path.

export interface MailReader {
  /** In-Reply-To/References ids and Content-Type of one message (metadata only). */
  refs(providerMsgId: string): Promise<{ referenceIds: string[]; contentType: string | null }>;
  /** Every header of one message as raw text (evidence for "still emailing"); no body. */
  rawHeaders(providerMsgId: string): Promise<string>;
  /** Raw RFC 5322 message, only if the guard allows it. */
  body(providerMsgId: string, allowedThreadIds: Iterable<string>, ourMessageIds: Iterable<string>): Promise<Buffer>;
}

const REF_HEADERS = ["In-Reply-To", "References", "Content-Type"];

function pick(headers: RawHeader[]) {
  const get = (n: string) => headers.filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
  return {
    referenceIds: [...new Set([...get("in-reply-to"), ...get("references")].flatMap(messageIdsIn))],
    contentType: get("content-type")[0] ?? null,
  };
}

const asText = (headers: RawHeader[]) => headers.map((h) => `${h.name}: ${h.value}`).join("\r\n") + "\r\n";

export async function readerFor(account: MailAccount): Promise<MailReader> {
  if (account.provider === "GOOGLE") {
    const token = await googleAccessToken(account);
    const get = (id: string, metadataHeaders?: string[]) =>
      gmailFetch<GmailMessageMeta>(token, `/messages/${encodeURIComponent(id)}`, {
        method: "messages.get",
        query: { format: "metadata", metadataHeaders },
      });
    return {
      refs: async (id) => pick((await get(id, REF_HEADERS)).payload?.headers ?? []),
      // format=metadata with no header filter returns every header (00-brief stage 9 evidence).
      rawHeaders: async (id) => asText((await get(id)).payload?.headers ?? []),
      body: (id, threads, ours) => gmailFetchReplyBody(token, id, threads, ours),
    };
  }
  const token = await microsoftAccessToken(account);
  const get = (id: string) =>
    graphFetch<{ internetMessageHeaders?: RawHeader[] }>(token, `/messages/${encodeURIComponent(id)}`, {
      query: { $select: "internetMessageHeaders" },
    });
  return {
    refs: async (id) => pick((await get(id)).internetMessageHeaders ?? []),
    rawHeaders: async (id) => asText((await get(id)).internetMessageHeaders ?? []),
    body: (id, threads, ours) => graphFetchReplyBody(token, id, threads, ours),
  };
}
