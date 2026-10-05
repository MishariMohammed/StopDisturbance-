import type { MailAccount } from "@prisma/client";
import { googleAccessToken, microsoftAccessToken } from "@/lib/mail/accounts";
import { GMAIL_SCOPES } from "@/lib/mail/google-oauth";
import { hasMsScope, MS_SCOPES } from "@/lib/mail/ms-oauth";
import { gmailSendRaw, type ProviderSendResult } from "@/lib/send/gmail-send";
import { graphSend } from "@/lib/send/graph-send";
import { buildMime, newMessageId } from "@/lib/send/mime";

// One way to send an email from a connected mailbox, whatever the provider.

export function hasSendScope(account: Pick<MailAccount, "provider" | "grantedScopes">): boolean {
  if (account.provider === "GOOGLE") return account.grantedScopes.includes(GMAIL_SCOPES.send);
  return hasMsScope(account.grantedScopes, MS_SCOPES.send);
}

export class MissingSendScopeError extends Error {
  constructor(public readonly accountId: string) {
    super("send_permission_missing");
  }
}

export interface EmailToSend {
  to: string;
  subject: string;
  text: string;
  fromName?: string | null;
  /** Previous message in the thread (reminder / ID reply). */
  thread?: {
    /** Gmail threadId (Graph: unused). */
    threadId?: string | null;
    /** Provider id of the message answered (Graph createReply). */
    providerMessageId?: string | null;
    /** Message-ID answered, and the chain before it. */
    inReplyTo?: string | null;
    references?: string[];
  } | null;
  plainOnly?: boolean;
  lang?: string;
}

export async function sendEmail(account: MailAccount, email: EmailToSend, now = new Date()): Promise<ProviderSendResult> {
  if (!hasSendScope(account)) throw new MissingSendScopeError(account.id);
  if (account.provider === "GOOGLE") {
    const token = await googleAccessToken(account);
    const messageId = newMessageId();
    const raw = await buildMime({
      from: { address: account.address, name: email.fromName },
      to: email.to,
      subject: email.subject,
      text: email.text,
      messageId,
      inReplyTo: email.thread?.inReplyTo ?? null,
      references: email.thread?.references ?? (email.thread?.inReplyTo ? [email.thread.inReplyTo] : undefined),
      date: now,
      plainOnly: email.plainOnly,
      lang: email.lang,
      dir: email.lang === "ar" ? "rtl" : "auto",
    });
    return gmailSendRaw(token, raw, { threadId: email.thread?.threadId ?? null, fallbackMessageId: messageId, now });
  }
  const token = await microsoftAccessToken(account);
  return graphSend(
    token,
    { to: email.to, subject: email.subject, text: email.text, replyToProviderId: email.thread?.providerMessageId ?? null, lang: email.lang },
    now,
  );
}
