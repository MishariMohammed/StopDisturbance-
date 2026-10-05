import { graphFetch, GraphAuthError } from "@/lib/mail/graph";
import { SendHttpError, type ProviderSendResult } from "@/lib/send/gmail-send";
import { textToHtml } from "@/lib/send/mime";

// Microsoft Graph send (02-capabilities §5.1): POST /me/messages (draft) → read internetMessageId and
// conversationId → POST /me/messages/{id}/send. /me/sendMail returns 202 with no IDs, so it is not used.
// Reminders: POST /me/messages/{original}/createReply → PATCH body/recipients → send.
// Immutable IDs keep the message id stable when the draft moves to Sent Items.

const BASE = "https://graph.microsoft.com/v1.0/me";
const PREFER = 'IdType="ImmutableId"';

type GraphMessage = { id: string; internetMessageId?: string; conversationId?: string; sentDateTime?: string };

async function call<T>(token: string, method: "POST" | "PATCH", path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      prefer: PREFER,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new GraphAuthError();
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new SendHttpError(res.status, res.status === 429 || res.status >= 500);
  }
  if (res.status === 202 || res.status === 204) return null;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

export interface GraphSendInput {
  to: string;
  subject: string;
  text: string;
  /** Graph message id of the message being answered (reminder / ID reply). */
  replyToProviderId?: string | null;
  lang?: string;
}

export async function graphSend(token: string, input: GraphSendInput, now = new Date()): Promise<ProviderSendResult> {
  const body = { contentType: "HTML", content: textToHtml(input.text, { lang: input.lang }) };
  const toRecipients = [{ emailAddress: { address: input.to } }];

  let draft: GraphMessage | null;
  if (input.replyToProviderId) {
    draft = await call<GraphMessage>(token, "POST", `/messages/${encodeURIComponent(input.replyToProviderId)}/createReply`, {});
    if (!draft?.id) throw new SendHttpError(502, true);
    // Replace the quoted body with our letter and address the company, not ourselves.
    draft = (await call<GraphMessage>(token, "PATCH", `/messages/${encodeURIComponent(draft.id)}`, {
      subject: input.subject,
      body,
      toRecipients,
    })) ?? draft;
  } else {
    draft = await call<GraphMessage>(token, "POST", "/messages", { subject: input.subject, body, toRecipients });
  }
  if (!draft?.id) throw new SendHttpError(502, true);

  await call(token, "POST", `/messages/${encodeURIComponent(draft.id)}/send`);

  let internetMessageId = draft.internetMessageId ?? null;
  let conversationId = draft.conversationId ?? null;
  let sentAt = now;
  try {
    const after = await graphFetch<GraphMessage>(token, `/messages/${encodeURIComponent(draft.id)}`, {
      query: { $select: "id,internetMessageId,conversationId,sentDateTime" },
      maxAttempts: 2,
    });
    internetMessageId = after.internetMessageId ?? internetMessageId;
    conversationId = after.conversationId ?? conversationId;
    if (after.sentDateTime) sentAt = new Date(after.sentDateTime);
  } catch {
    /* the send succeeded; keep what the draft told us */
  }
  return { providerMessageId: draft.id, threadId: conversationId, internetMessageId, sentAt };
}
