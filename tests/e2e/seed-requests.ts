// E2E requests for /review and /tracker: drafts in each channel plus sent requests in tracker statuses.
// Rows are written directly (no lib imports) so the seed stays a plain Prisma script.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, RequestStatus, RequestType } from "@prisma/client";

const DAY = 24 * 3600 * 1000;
export const E2E_OWNER = "Sara Test";

const hash = (to: string | null, subject: string | null, body: string | null) =>
  createHash("sha256").update(`${to ?? ""}\n${subject ?? ""}\n${body ?? ""}`).digest("hex");

/** Same layout as src/lib/crypto/tokens.ts: [1][iv:12][tag:16][ciphertext], key from TOKEN_ENC_KEYS. */
function encrypt(plain: string): { blob: Uint8Array<ArrayBuffer>; version: number } {
  const version = Number(process.env.TOKEN_ENC_KEY_CURRENT ?? "1");
  const keys = JSON.parse(process.env.TOKEN_ENC_KEYS ?? "{}") as Record<string, string>;
  const key = Buffer.from(keys[String(version)] ?? "", "base64");
  if (key.length !== 32) throw new Error("E2E seed needs TOKEN_ENC_KEYS in .env");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { blob: new Uint8Array(Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct])), version };
}

export function letter(company: string, ref: string, mailbox: string) {
  return {
    subject: `Request to delete my personal data — Ref ${ref}`,
    body:
      `To ${company},\n\nI am ${E2E_OWNER}, a resident of Saudi Arabia, and you send email to ${mailbox}.\n\n` +
      `Under the Saudi Personal Data Protection Law (Royal Decree M/19), Arts. 4, 5 and 18, I ask you to delete all personal data you hold about me ` +
      `and to stop using it for marketing.\n\nPlease answer within 30 days.\n\nRef ${ref}\n\n${E2E_OWNER}\n`,
  };
}

type Ids = Record<string, string>;
type Boxes = { gmail: string; outlook: string };

async function request(
  db: PrismaClient,
  opts: {
    companyId: string;
    mailAccountId: string;
    type: RequestType;
    status: RequestStatus;
    reference: string;
    extra?: Partial<Prisma.RequestUncheckedCreateInput>;
  },
) {
  return db.request.create({
    data: {
      companyId: opts.companyId,
      mailAccountId: opts.mailAccountId,
      type: opts.type,
      status: opts.status,
      reference: opts.reference,
      lawKeys: ["PDPL"],
      citationsText: "the Saudi Personal Data Protection Law",
      ...opts.extra,
    },
  });
}

async function outbound(
  db: PrismaClient,
  requestId: string,
  o: { kind: string; templateId: string; to: string | null; subject: string | null; body: string | null; approved?: boolean; sentAt?: Date; language?: string },
) {
  const draftHash = hash(o.to, o.subject, o.body);
  return db.outboundMessage.create({
    data: {
      requestId,
      kind: o.kind,
      templateId: o.templateId,
      templateVersion: "e2e",
      language: o.language ?? "en",
      toAddress: o.to,
      subject: o.subject,
      bodyText: o.body,
      draftHash,
      approvedHash: o.approved || o.sentAt ? draftHash : null,
      approvedAt: o.approved || o.sentAt ? new Date() : null,
      sentAt: o.sentAt ?? null,
      providerMessageId: o.sentAt ? `e2e-${requestId}` : null,
      threadId: o.sentAt ? `thread-${requestId}` : null,
    },
  });
}

async function created(db: PrismaClient, requestId: string, outboundId: string, contactId: string | null, extra: Record<string, unknown> = {}) {
  await db.requestEvent.create({
    data: { requestId, type: "DRAFT_CREATED", actor: "SYSTEM", data: { outboundId, contactId, contactSource: "policy", ...extra } as Prisma.InputJsonValue },
  });
}

export async function seedRequests(db: PrismaClient, ids: Ids, boxes: Boxes) {
  const now = Date.now();
  const contact = (domain: string, kind: "PRIVACY_EMAIL" | "WEB_FORM" | "ONE_CLICK", value: string, confidence: "HIGH" | "LOW" = "HIGH") =>
    db.companyContact.create({
      data: { companyId: ids[domain], kind, value, source: kind === "ONE_CLICK" ? "headers" : "policy", confidence, lastVerifiedAt: new Date(now - 3 * DAY) },
    });

  // ---- /review drafts ----
  // Noon: privacy email draft from Gmail (no send permission yet).
  const noonC = await contact("noon.com", "PRIVACY_EMAIL", "privacy@noon.com");
  const noon = await request(db, { companyId: ids["noon.com"], mailAccountId: boxes.gmail, type: "ERASURE_OBJECTION", status: "DRAFT", reference: "SD-NOON" });
  const noonL = letter("Noon", "SD-NOON", "you@gmail.com");
  const noonO = await outbound(db, noon.id, { kind: "INITIAL", templateId: "6a", to: "privacy@noon.com", ...noonL });
  await created(db, noon.id, noonO.id, noonC.id);

  // Jarir: privacy email draft from Outlook (has Mail.Send).
  const jarirC = await contact("jarir.com", "PRIVACY_EMAIL", "dpo@jarir.com");
  const jarir = await request(db, { companyId: ids["jarir.com"], mailAccountId: boxes.outlook, type: "ERASURE_OBJECTION", status: "DRAFT", reference: "SD-JRR1" });
  const jarirL = letter("مكتبة جرير", "SD-JRR1", "you@outlook.com");
  const jarirO = await outbound(db, jarir.id, { kind: "INITIAL", templateId: "6a", to: "dpo@jarir.com", ...jarirL });
  await created(db, jarir.id, jarirO.id, jarirC.id);

  // Shein: web form the owner submits.
  const sheinC = await contact("shein.com", "WEB_FORM", "https://shein.example/privacy-request");
  const shein = await request(db, { companyId: ids["shein.com"], mailAccountId: boxes.gmail, type: "WEB_FORM", status: "DRAFT", reference: "SD-SHN1" });
  const sheinL = letter("Shein", "SD-SHN1", "you@gmail.com");
  const sheinO = await outbound(db, shein.id, { kind: "WEB_FORM_COPY", templateId: "webform", to: "https://shein.example/privacy-request", ...sheinL });
  await created(db, shein.id, sheinO.id, sheinC.id);

  // Careem: one-click unsubscribe.
  const careemC = await contact("careem.com", "ONE_CLICK", "msg:e2e-careem");
  const careem = await request(db, { companyId: ids["careem.com"], mailAccountId: boxes.outlook, type: "ONE_CLICK", status: "DRAFT", reference: "SD-CRM1" });
  const careemO = await outbound(db, careem.id, { kind: "ONE_CLICK_POST", templateId: "one-click", to: "msg:e2e-careem", subject: null, body: "List-Unsubscribe=One-Click" });
  await created(db, careem.id, careemO.id, careemC.id, { contactSource: "headers" });

  // Udemy: decided-company candidate for "Create drafts" (contact only; decision is made in the test).
  await contact("udemy.com", "PRIVACY_EMAIL", "privacy@udemy.com");

  await seedTracker(db, ids, boxes, now);
}

/** Sent requests in tracker statuses (04-ux §7.1). */
async function seedTracker(db: PrismaClient, ids: Ids, boxes: Boxes, now: number) {
  const sent = async (
    domain: string,
    ref: string,
    status: RequestStatus,
    sentDaysAgo: number,
    extra: Partial<Prisma.RequestUncheckedCreateInput> = {},
    mailbox: "gmail" | "outlook" = "outlook",
  ) => {
    const clockStart = new Date(now - sentDaysAgo * DAY);
    const dueAt = new Date(clockStart.getTime() + 30 * DAY);
    const r = await request(db, {
      companyId: ids[domain],
      mailAccountId: boxes[mailbox],
      type: "ERASURE_OBJECTION",
      status,
      reference: ref,
      extra: {
        clockStart,
        dueAt,
        latestDueAt: dueAt,
        reminderOfferedAt: new Date(dueAt.getTime() + 3 * DAY),
        complaintWindowEndsAt: new Date(dueAt.getTime() + 90 * DAY),
        ...extra,
      },
    });
    const l = letter(domain, ref, mailbox === "gmail" ? "you@gmail.com" : "you@outlook.com");
    const o = await outbound(db, r.id, { kind: "INITIAL", templateId: "6a", to: `privacy@${domain}`, sentAt: clockStart, ...l });
    await db.requestEvent.create({ data: { requestId: r.id, type: "SENT", actor: "SYSTEM", at: clockStart, data: { outboundId: o.id } } });
    return { r, o, clockStart };
  };
  const reply = async (requestId: string, domain: string, subject: string, text: string, suggestedClass: string | null, daysAgo: number, ownerConfirmed: boolean | null = null) => {
    const raw = `From: privacy@${domain}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
    const { blob } = encrypt(raw);
    return db.inboundReply.create({
      data: {
        requestId, providerMsgId: `reply-${requestId}`, receivedAt: new Date(now - daysAgo * DAY), fromAddress: `privacy@${domain}`, subject,
        bodyCipher: blob, matchMethod: "thread", suggestedClass, ownerConfirmed,
      },
    });
  };

  // SENT, waiting.
  await sent("amazon.sa", "SD-AMZ1", "SENT", 3);
  // SENT with an unconfirmed reply that looks like a completion.
  const nm = await sent("namshi.com", "SD-NMS1", "SENT", 10);
  await reply(nm.r.id, "namshi.com", "Re: Request to delete my personal data — Ref SD-NMS1", "We have deleted your personal data as requested.", "COMPLETED", 1);
  // NEEDS_ACTION: they asked for identity verification.
  const ex = await sent("extra.com", "SD-EXT1", "NEEDS_ACTION", 12, { needsActionReason: "ID_VERIFICATION" });
  await reply(ex.r.id, "extra.com", "Re: Request — Ref SD-EXT1", "Please verify your identity by sending a copy of your national ID.", "NEEDS_ID", 2, true);
  // NEEDS_ACTION: mailbox lacks send permission (the dispatcher couldn't send).
  await request(db, {
    companyId: ids["uber.com"], mailAccountId: boxes.gmail, type: "ERASURE_OBJECTION", status: "NEEDS_ACTION", reference: "SD-UBR1",
    extra: { needsActionReason: "SEND_PERMISSION" },
  }).then(async (r) => {
    const l = letter("Uber", "SD-UBR1", "you@gmail.com");
    await outbound(db, r.id, { kind: "INITIAL", templateId: "6a", to: "privacy@uber.com", approved: true, ...l });
  });
  // OVERDUE: sent 40 days ago, no reply, reminder offered.
  await sent("ikea.com", "SD-IKE1", "OVERDUE", 40);
  // REFUSED: escalation is offered.
  const zr = await sent("zara.com", "SD-ZAR1", "REFUSED", 20);
  await reply(zr.r.id, "zara.com", "Re: Ref SD-ZAR1", "We are unable to delete your data because we must keep it.", "REFUSED", 3, true);
  // COMPLETED.
  const hm = await sent("hm.com", "SD-HM01", "COMPLETED", 25, { closedAt: new Date(now - 5 * DAY) });
  await reply(hm.r.id, "hm.com", "Re: Ref SD-HM01", "Your data has been deleted.", "COMPLETED", 5, true);
  // QUEUED (in the send queue, cancellable): long sendAfter so the worker never sends it in tests.
  const nk = await request(db, { companyId: ids["nike.com"], mailAccountId: boxes.outlook, type: "ERASURE_OBJECTION", status: "QUEUED", reference: "SD-NKE1" });
  const nkL = letter("Nike", "SD-NKE1", "you@outlook.com");
  const nkO = await outbound(db, nk.id, { kind: "INITIAL", templateId: "6a", to: "privacy@nike.com", approved: true, ...nkL });
  await db.outboundMessage.update({ where: { id: nkO.id }, data: { sendAfter: new Date(now + 3600_000) } });
  // ESCALATED with a complaint reference.
  await sent("adidas.com", "SD-ADI1", "ESCALATED", 60, { complaintRef: "SDAIA-12345" });
}
