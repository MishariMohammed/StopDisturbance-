import { db } from "@/lib/db";
import { replyText } from "@/lib/track/lifecycle";

// "Download my data (JSON)" (04-ux §3.6). Everything the owner can see in the app, without OAuth
// tokens or any ciphertext: token blobs, encrypted one-click URLs, raw evidence headers and LLM payload
// samples are left out. Reply bodies are decrypted to text only when the owner asks for them.

export const EXPORT_FORMAT = "stopdisturbance-export/1";

/** BigInt ids (AuditLog, AppEvent) and byte arrays can't go through JSON.stringify as-is. */
function plain<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)) return undefined;
      return v;
    }),
  );
}

export async function exportData(opts: { includeReplyBodies?: boolean } = {}) {
  const [
    owner, mailboxes, headers, senders, companies, companyDomains, contacts, classifications, decisions,
    requests, outbound, replies, evidence, events, settings, llmCalls, auditLog, appEvents,
  ] = await Promise.all([
    db.owner.findUnique({
      where: { id: "owner" },
      select: { fullName: true, country: true, usState: true, locale: true, numerals: true, timezone: true, loginEmails: true, employerDomains: true, setupDoneAt: true, createdAt: true },
    }),
    db.mailAccount.findMany({
      select: { id: true, provider: true, address: true, status: true, grantedScopes: true, scanFrom: true, lastSyncAt: true, lastRefreshAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    db.messageHeader.findMany({
      select: {
        id: true, accountId: true, receivedAt: true, fromAddress: true, fromName: true, fromDomain: true, subject: true, listId: true,
        oneClick: true, isMarketing: true, isTransactional: true, isPersonal: true, labels: true, esp: true, senderId: true, createdAt: true,
      },
      orderBy: { receivedAt: "desc" },
    }),
    db.sender.findMany({ omit: { accountIds: true } }),
    db.company.findMany(),
    db.companyDomain.findMany(),
    db.companyContact.findMany(),
    db.classification.findMany(),
    db.decision.findMany({ orderBy: { createdAt: "asc" } }),
    db.request.findMany({ orderBy: { createdAt: "asc" } }),
    db.outboundMessage.findMany({ orderBy: { createdAt: "asc" } }),
    db.inboundReply.findMany({ omit: { bodyCipher: true }, orderBy: { receivedAt: "asc" } }),
    db.evidenceHeader.findMany({ select: { id: true, requestId: true, receivedAt: true } }),
    db.requestEvent.findMany({ orderBy: { at: "asc" } }),
    db.setting.findMany(),
    db.llmCallLog.findMany({ orderBy: { at: "desc" } }),
    db.auditLog.findMany({ orderBy: { id: "asc" } }),
    db.appEvent.findMany({ orderBy: { id: "asc" } }),
  ]);

  const replyRows: Record<string, unknown>[] = [];
  for (const r of replies) {
    replyRows.push(opts.includeReplyBodies ? { ...r, bodyText: await replyText(r.id).catch(() => "") } : r);
  }

  return plain({
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    includesReplyBodies: Boolean(opts.includeReplyBodies),
    owner,
    mailboxes,
    messageHeaders: headers,
    senders,
    companies,
    companyDomains,
    companyContacts: contacts,
    classifications,
    decisions,
    requests,
    outboundMessages: outbound,
    inboundReplies: replyRows,
    evidenceHeaders: evidence,
    requestEvents: events,
    settings,
    llmCallLog: llmCalls,
    auditLog,
    appEvents,
  }) as Record<string, unknown>;
}
