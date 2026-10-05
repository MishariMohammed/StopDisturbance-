import { gmailFetch, GmailAuthError, type GmailMessageMeta } from "@/lib/mail/gmail";
import { base64url } from "@/lib/send/mime";

// Gmail users.messages.send with a raw RFC 5322 message (02-capabilities §5.1). 100 quota units.
// Reminders pass the original threadId; the MIME carries In-Reply-To/References and the same subject.

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class SendHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(`send_http_${status}`);
  }
}

export interface ProviderSendResult {
  providerMessageId: string;
  threadId: string | null;
  internetMessageId: string | null;
  sentAt: Date;
}

export async function gmailSendRaw(
  token: string,
  raw: Buffer,
  opts: { threadId?: string | null; fallbackMessageId: string; now?: Date },
): Promise<ProviderSendResult> {
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: base64url(raw), ...(opts.threadId ? { threadId: opts.threadId } : {}) }),
  });
  if (res.status === 401) throw new GmailAuthError();
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new SendHttpError(res.status, res.status === 429 || res.status >= 500);
  }
  const sent = (await res.json()) as { id: string; threadId?: string };

  // Read back the Message-ID Gmail kept and the provider send time (metadata only, 5 units).
  let internetMessageId: string | null = opts.fallbackMessageId;
  let sentAt = opts.now ?? new Date();
  try {
    const meta = await gmailFetch<GmailMessageMeta>(token, `/messages/${encodeURIComponent(sent.id)}`, {
      method: "messages.get",
      query: { format: "metadata", metadataHeaders: ["Message-ID"] },
      maxAttempts: 2,
    });
    const h = meta.payload?.headers?.find((x) => x.name.toLowerCase() === "message-id");
    if (h?.value) internetMessageId = h.value.trim();
    if (meta.internalDate) sentAt = new Date(Number(meta.internalDate));
  } catch {
    /* the send succeeded; keep our own Message-ID */
  }
  return { providerMessageId: sent.id, threadId: sent.threadId ?? null, internetMessageId, sentAt };
}
