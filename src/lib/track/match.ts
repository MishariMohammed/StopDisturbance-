// Reply matching, in priority order (02-capabilities §5.2, 04-ux §7.3). Pure.
// 1 THREAD: Gmail threadId / Graph conversationId of a message we sent (same mailbox).
// 2 IN_REPLY_TO: In-Reply-To/References name one of our Message-IDs (ticket systems that start a new thread).
// 3 SUBJECT_TOKEN: the subject carries the request reference SD-XXXX.
// 4 DOMAIN: the sender's registrable domain belongs to the company, inside the open window → probable,
//   the owner confirms. List/bulk mail never matches by domain (that is marketing, see stillEmailing).
// DSNs (bounces) match only by 1 or 2: a bounce that does not reference our mail is not ours.

export type MatchMethod = "THREAD" | "IN_REPLY_TO" | "SUBJECT_TOKEN" | "DOMAIN";

export interface TrackedRequest {
  id: string;
  reference: string;
  type: string;
  mailAccountId: string;
  companyId: string;
  companyDomains: string[];
  clockStart: Date | null;
  /** End of the domain-match window: closedAt, else latest deadline + 90 days. */
  windowEnd: Date | null;
  /** Provider thread/conversation ids of our sent messages. */
  threadIds: string[];
  /** Our sent Message-IDs, `<id>` lowercased. */
  messageIds: string[];
}

export interface ReplyCandidate {
  accountId: string;
  threadId: string | null;
  subject: string | null;
  fromAddress: string;
  fromDomain: string;
  receivedAt: Date;
  /** Message-IDs from In-Reply-To and References. */
  referenceIds: string[];
  /** List-Id / List-Unsubscribe / Precedence bulk|list / classified marketing. */
  isList: boolean;
  isDsn: boolean;
}

export interface ReplyMatch {
  request: TrackedRequest;
  method: MatchMethod;
  probable: boolean;
}

export const REFERENCE_RE = /SD-[0-9A-HJKMNP-TV-Z]{4}/g;

export function messageIdsIn(value: string | null | undefined): string[] {
  return (value ?? "").match(/<[^<>\s]+>/g)?.map((x) => x.toLowerCase()) ?? [];
}

const DSN_FROM = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;
const DSN_SUBJECT =
  /(undeliver|delivery status notification|delivery has failed|mail delivery (failed|subsystem)|returned mail|failure notice|message not delivered|non remis|unzustellbar|تعذر تسليم|فشل التسليم)/i;
const DELAY_SUBJECT = /\b(delay|delayed|warning)\b/i;

/** A non-delivery report (not a delay warning). */
export function isDsn(h: { fromAddress: string; subject: string | null; contentType?: string | null }): boolean {
  const subject = h.subject ?? "";
  if (DELAY_SUBJECT.test(subject)) return false;
  if (h.contentType && /multipart\/report/i.test(h.contentType) && /delivery-status/i.test(h.contentType)) return true;
  return DSN_FROM.test(h.fromAddress) || DSN_SUBJECT.test(subject);
}

/** Letters are what companies answer; a one-click/mailto case is preferred last for ambiguous matches. */
const TYPE_RANK: Record<string, number> = { ERASURE_OBJECTION: 0, STOP_MARKETING: 1, WEB_FORM: 2, MAILTO_UNSUB: 3, ONE_CLICK: 4 };
const byType = (a: TrackedRequest, b: TrackedRequest) => (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9);

export function matchReply(c: ReplyCandidate, requests: TrackedRequest[]): ReplyMatch | null {
  if (c.threadId) {
    const r = requests.find((q) => q.mailAccountId === c.accountId && q.threadIds.includes(c.threadId!));
    if (r) return { request: r, method: "THREAD", probable: false };
  }
  const refs = new Set(c.referenceIds.map((x) => x.toLowerCase()));
  if (refs.size) {
    const r = requests.find((q) => q.messageIds.some((m) => refs.has(m)));
    if (r) return { request: r, method: "IN_REPLY_TO", probable: false };
  }
  if (c.isDsn) return null;
  const tokens = new Set(c.subject?.toUpperCase().match(REFERENCE_RE) ?? []);
  if (tokens.size) {
    const r = requests.find((q) => tokens.has(q.reference));
    if (r) return { request: r, method: "SUBJECT_TOKEN", probable: false };
  }
  if (c.isList) return null;
  const domain = c.fromDomain.toLowerCase();
  const open = requests
    .filter(
      (q) =>
        q.companyDomains.includes(domain) &&
        q.clockStart !== null &&
        c.receivedAt.getTime() >= q.clockStart.getTime() &&
        (q.windowEnd === null || c.receivedAt.getTime() <= q.windowEnd.getTime()),
    )
    .sort(byType);
  return open[0] ? { request: open[0], method: "DOMAIN", probable: true } : null;
}
