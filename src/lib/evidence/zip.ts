import { ZipArchive } from "archiver";
import { db } from "@/lib/db";
import { decryptAny, replyRaw } from "@/lib/evidence/crypto";
import { buildMime } from "@/lib/send/mime";
import { TrackError } from "@/lib/track/state";

// Evidence bundle (03-legal §8, M8; 00-brief M5): EML of every sent email and every stored reply,
// raw headers of marketing received after the request, and timeline.json (events, deadlines, hashes).
// One-click POSTs have no email; they appear in the timeline with their HTTP status only (no URL token).

const stamp = (d: Date) => d.toISOString().replace(/[:]/g, "-").replace(/\.\d+Z$/, "Z");

export async function buildEvidenceZip(requestId: string): Promise<Buffer> {
  const request = await db.request.findUnique({ where: { id: requestId } });
  if (!request) throw new TrackError("not_found");
  const [company, account, owner, outbound, replies, evidence, events] = await Promise.all([
    db.company.findUnique({ where: { id: request.companyId } }),
    db.mailAccount.findUnique({ where: { id: request.mailAccountId }, select: { address: true, provider: true } }),
    db.owner.findFirst({ select: { fullName: true } }),
    db.outboundMessage.findMany({ where: { requestId }, orderBy: { createdAt: "asc" } }),
    db.inboundReply.findMany({ where: { requestId }, orderBy: { receivedAt: "asc" } }),
    db.evidenceHeader.findMany({ where: { requestId }, orderBy: { receivedAt: "asc" } }),
    db.requestEvent.findMany({ where: { requestId }, orderBy: { at: "asc" } }),
  ]);

  const files: { name: string; data: Buffer; date: Date }[] = [];
  let n = 0;
  for (const o of outbound) {
    if (!o.sentAt || o.kind === "ONE_CLICK_POST" || o.kind === "WEB_FORM_COPY" || !o.toAddress) continue;
    const prior = outbound.filter((p) => p.sentAt && p.sentAt < o.sentAt! && p.internetMessageId).map((p) => p.internetMessageId!);
    const eml = await buildMime({
      from: { address: account?.address ?? "unknown@invalid", name: owner?.fullName || null },
      to: o.toAddress,
      subject: o.subject ?? "",
      text: o.bodyText ?? "",
      messageId: o.internetMessageId ?? `<${o.id}@evidence.invalid>`,
      inReplyTo: o.kind === "INITIAL" || o.kind === "UNSUB_MAILTO" ? null : (prior[prior.length - 1] ?? null),
      references: o.kind === "INITIAL" || o.kind === "UNSUB_MAILTO" ? undefined : prior,
      date: o.sentAt,
      plainOnly: true,
    });
    files.push({ name: `sent/${String(++n).padStart(2, "0")}-${o.kind.toLowerCase()}-${stamp(o.sentAt)}.eml`, data: eml, date: o.sentAt });
  }
  n = 0;
  for (const r of replies) {
    const raw = replyRaw(r.bodyCipher);
    if (!raw?.length) continue;
    files.push({ name: `replies/${String(++n).padStart(2, "0")}-${stamp(r.receivedAt)}.eml`, data: raw, date: r.receivedAt });
  }
  n = 0;
  for (const e of evidence) {
    const raw = decryptAny(e.rawHeadersCipher);
    if (!raw) continue;
    files.push({ name: `marketing-after-request/${String(++n).padStart(2, "0")}-${stamp(e.receivedAt)}.txt`, data: Buffer.from(raw, "utf8"), date: e.receivedAt });
  }

  const timeline = {
    generatedAt: new Date().toISOString(),
    request: {
      id: request.id,
      reference: request.reference,
      type: request.type,
      status: request.status,
      company: company ? { name: company.name, domain: company.primaryDomain } : null,
      mailbox: account?.address ?? null,
      lawKeys: request.lawKeys,
      citations: request.citationsText,
      lowConfidenceWording: request.lowConfidenceWording,
      extensionClaimed: request.extensionClaimed,
      stillEmailing: request.stillEmailing,
      bounced: request.bounced,
      complaintRef: request.complaintRef,
    },
    deadlines: {
      clockStart: request.clockStart,
      dueAt: request.dueAt,
      latestDueAt: request.latestDueAt,
      extendedDueAt: request.extendedDueAt,
      reminderOfferedAt: request.reminderOfferedAt,
      reminderSentAt: request.reminderSentAt,
      escalationOpenAt: request.escalationOpenAt,
      complaintWindowEndsAt: request.complaintWindowEndsAt,
      closedAt: request.closedAt,
    },
    outbound: outbound.map((o) => ({
      id: o.id,
      kind: o.kind,
      templateId: o.templateId,
      templateVersion: o.templateVersion,
      language: o.language,
      to: o.kind === "ONE_CLICK_POST" ? null : o.toAddress,
      subject: o.subject,
      draftHash: o.draftHash,
      approvedHash: o.approvedHash,
      approvedAt: o.approvedAt,
      sentAt: o.sentAt,
      providerMessageId: o.providerMessageId,
      threadId: o.sentAt ? o.threadId : null,
      internetMessageId: o.internetMessageId,
      httpStatus: o.httpStatus,
      error: o.error,
    })),
    replies: replies.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt,
      from: r.fromAddress,
      subject: r.subject,
      matchMethod: r.matchMethod,
      probable: r.probable,
      suggestedClass: r.suggestedClass,
      ownerConfirmed: r.ownerConfirmed,
      bodyStored: Boolean(replyRaw(r.bodyCipher)?.length),
    })),
    marketingAfterRequest: evidence.map((e) => ({ receivedAt: e.receivedAt })),
    events: events.map((e) => ({ at: e.at, type: e.type, actor: e.actor, data: e.data })),
    files: files.map((f) => f.name),
  };
  files.push({ name: "timeline.json", data: Buffer.from(JSON.stringify(timeline, null, 2), "utf8"), date: new Date() });

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    archive.on("data", (c: Buffer) => chunks.push(c));
    archive.on("end", () => resolve());
    archive.on("error", reject);
  });
  for (const f of files) archive.append(f.data, { name: `${request.reference}/${f.name}`, date: f.date });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}
