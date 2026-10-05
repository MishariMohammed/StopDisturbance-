import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addBusinessDays, addCalendarDays } from "@/lib/deadlines";
import { replyRaw } from "@/lib/evidence/crypto";
import { classifyReply } from "@/lib/track/classify";
import { deadlineTick } from "@/lib/track/deadline-tick";
import { createIdReplyDraft, createReminderDraft } from "@/lib/track/followups";
import { confirmReply, markWebFormSubmitted, recordExtension } from "@/lib/track/lifecycle";
import { matchReply, type ReplyCandidate, type TrackedRequest } from "@/lib/track/match";
import { POLL_CURSOR_KEY, pollReplies } from "@/lib/track/poll";
import { deadlineColumns, TrackError } from "@/lib/track/state";
import { trackerDetail, trackerRows } from "@/lib/track/tracker";
import { resetDb } from "./helpers";
import { gmailFake, notificationsOff, seedAccount, seedCompany, seedOwner, seedRequest, T0 } from "./m5-helpers";

const DAY = 86_400_000;

beforeEach(async () => {
  await resetDb();
  await seedOwner();
  await notificationsOff();
  await db.setting.create({ data: { key: POLL_CURSOR_KEY, value: "2020-01-01T00:00:00.000Z" } });
});
afterEach(() => vi.unstubAllGlobals());

const mime = (from: string, subject: string, text: string, extra = "") =>
  `From: ${from}\r\nTo: sara@gmail.com\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random()}@x>\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;

/** A request already SENT from the Gmail mailbox, with deadlines. */
async function sentRequest(opts: { clockStart?: Date; status?: "SENT" | "ACKNOWLEDGED" | "OVERDUE"; type?: "ERASURE_OBJECTION" | "ONE_CLICK"; threadId?: string; mid?: string } = {}) {
  const acc = (await db.mailAccount.findFirst()) ?? (await seedAccount());
  const co = (await db.company.findFirst()) ?? (await seedCompany());
  const clockStart = opts.clockStart ?? T0;
  const cols = deadlineColumns({ lawKeys: ["PDPL"] }, clockStart);
  const { request, out } = await seedRequest({
    companyId: co.id, accountId: acc.id, status: opts.status ?? "SENT", type: opts.type, sendAfter: null, sentAt: clockStart,
    threadId: opts.threadId ?? "t-sent", internetMessageId: opts.mid ?? "<orig@localhost>", providerMessageId: "g-sent",
    extra: { ...cols },
  });
  return { acc, co, request, out };
}

async function header(accountId: string, providerMsgId: string, data: Partial<Parameters<typeof db.messageHeader.create>[0]["data"]> = {}) {
  return db.messageHeader.create({
    data: {
      accountId, providerMsgId, threadId: `t-${providerMsgId}`, receivedAt: new Date(T0.getTime() + DAY), fromAddress: "privacy@acme.example",
      fromDomain: "acme.example", subject: "Your request", ...data,
    } as Parameters<typeof db.messageHeader.create>[0]["data"],
  });
}

describe("reply matching (pure)", () => {
  const req: TrackedRequest = {
    id: "r1", reference: "SD-7F3K", type: "ERASURE_OBJECTION", mailAccountId: "a1", companyId: "c1", companyDomains: ["acme.example"],
    clockStart: T0, windowEnd: new Date(T0.getTime() + 120 * DAY), threadIds: ["t-sent"], messageIds: ["<orig@localhost>"],
  };
  const base: ReplyCandidate = {
    accountId: "a1", threadId: "t-other", subject: "Hello", fromAddress: "x@ticket.example", fromDomain: "ticket.example",
    receivedAt: new Date(T0.getTime() + DAY), referenceIds: [], isList: false, isDsn: false,
  };
  it("matches in priority order: thread → In-Reply-To/References → subject token → domain (probable)", () => {
    expect(matchReply({ ...base, threadId: "t-sent" }, [req])).toMatchObject({ method: "THREAD", probable: false });
    expect(matchReply({ ...base, referenceIds: ["<ORIG@localhost>"] }, [req])).toMatchObject({ method: "IN_REPLY_TO", probable: false });
    expect(matchReply({ ...base, subject: "Re: [sd-7f3k] update" }, [req])).toMatchObject({ method: "SUBJECT_TOKEN" });
    expect(matchReply({ ...base, fromDomain: "acme.example" }, [req])).toMatchObject({ method: "DOMAIN", probable: true });
    // Thread wins even when everything else also matches.
    expect(matchReply({ ...base, threadId: "t-sent", subject: "SD-7F3K", fromDomain: "acme.example", referenceIds: ["<orig@localhost>"] }, [req])?.method).toBe("THREAD");
  });
  it("never domain-matches list mail, mail outside the window, or other mailboxes' threads", () => {
    expect(matchReply({ ...base, fromDomain: "acme.example", isList: true }, [req])).toBeNull();
    expect(matchReply({ ...base, fromDomain: "acme.example", receivedAt: new Date(T0.getTime() - DAY) }, [req])).toBeNull();
    expect(matchReply({ ...base, fromDomain: "acme.example", receivedAt: new Date(T0.getTime() + 200 * DAY) }, [req])).toBeNull();
    expect(matchReply({ ...base, accountId: "a2", threadId: "t-sent" }, [req])).toBeNull();
    expect(matchReply({ ...base, subject: "SD-7F3K", isDsn: true }, [req])).toBeNull();
  });
});

describe("replies.poll on fixtures", () => {
  it("matches all four methods, stores bodies encrypted (not for probable matches), and suggests a class", async () => {
    const { acc, request } = await sentRequest();
    await header(acc.id, "m-thread", { threadId: "t-sent" });
    await header(acc.id, "m-irt", { fromAddress: "help@desk.example", fromDomain: "desk.example", threadId: "t-new" });
    await header(acc.id, "m-subj", { fromAddress: "dpo@acme-privacy.example", fromDomain: "acme-privacy.example", subject: `[${request.reference}] update` });
    await header(acc.id, "m-dom", { fromAddress: "legal@acme.example", subject: "About your data" });
    await header(acc.id, "m-unrelated", { fromAddress: "friend@other.example", fromDomain: "other.example", subject: "Lunch?" });
    const g = gmailFake({
      messages: {
        "m-thread": { threadId: "t-sent", headers: [], raw: mime("privacy@acme.example", "Re: x", "We have received your request. Your ticket number is 1234.") },
        "m-irt": { threadId: "t-new", headers: [{ name: "In-Reply-To", value: "<orig@localhost>" }], raw: mime("help@desk.example", "Case 55", "We need to verify your identity. Please send a copy of your passport.") },
        "m-subj": { threadId: "t-m-subj", headers: [], raw: mime("dpo@acme-privacy.example", `[${request.reference}] update`, "Your data has been deleted and you have been unsubscribed.") },
        "m-dom": { threadId: "t-m-dom", headers: [], raw: mime("legal@acme.example", "About your data", "secret body") },
        "m-unrelated": { threadId: "t-m-unrelated", headers: [], raw: "nope" },
      },
    });
    vi.stubGlobal("fetch", g.fn);

    const res = await pollReplies(new Date(T0.getTime() + 2 * DAY));
    expect(res).toMatchObject({ scanned: 5, matched: 4, bounced: 0 });
    const replies = await db.inboundReply.findMany({ where: { requestId: request.id } });
    const by = Object.fromEntries(replies.map((r) => [r.providerMsgId, r]));
    expect(by["m-thread"]).toMatchObject({ matchMethod: "THREAD", probable: false, suggestedClass: "ACKNOWLEDGED" });
    expect(by["m-irt"]).toMatchObject({ matchMethod: "IN_REPLY_TO", probable: false, suggestedClass: "NEEDS_ID" });
    expect(by["m-subj"]).toMatchObject({ matchMethod: "SUBJECT_TOKEN", probable: false, suggestedClass: "COMPLETED" });
    expect(by["m-dom"]).toMatchObject({ matchMethod: "DOMAIN", probable: true });
    expect(by["m-unrelated"]).toBeUndefined();

    // Bodies: encrypted at rest; fetched only for certain matches.
    expect(Buffer.from(by["m-thread"].bodyCipher).toString("latin1")).not.toContain("ticket number");
    expect(replyRaw(by["m-thread"].bodyCipher)!.toString()).toContain("ticket number");
    expect(replyRaw(by["m-dom"].bodyCipher)).toBeNull();
    const rawFetches = g.calls.filter((c) => c.url.searchParams.get("format") === "raw").map((c) => c.url.pathname.split("/").pop());
    expect(rawFetches.sort()).toEqual(["m-irt", "m-subj", "m-thread"]);
    // The unrelated personal message body was never fetched (only its In-Reply-To/References metadata).
    expect(g.calls.some((c) => c.url.pathname.endsWith("/m-unrelated") && c.url.searchParams.get("format") === "raw")).toBe(false);

    // Cursor advanced: a second poll sees nothing new.
    expect((await pollReplies(new Date(T0.getTime() + 2 * DAY))).scanned).toBe(0);
  });

  it("a high-confidence auto-acknowledgement updates SENT → ACKNOWLEDGED and is undoable", async () => {
    const { acc, request } = await sentRequest();
    await header(acc.id, "m-auto", { threadId: "t-sent", autoSubmitted: "auto-replied", subject: "Automatic reply: request received" });
    vi.stubGlobal("fetch", gmailFake({ messages: { "m-auto": { threadId: "t-sent", headers: [], raw: mime("privacy@acme.example", "Automatic reply", "Thank you for contacting us. We have received your request.") } } }).fn);
    await pollReplies(new Date(T0.getTime() + 2 * DAY));
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("ACKNOWLEDGED");
    const reply = await db.inboundReply.findFirstOrThrow({ where: { requestId: request.id } });
    await confirmReply(reply.id, "NOT_RELATED");
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("SENT");
    expect((await db.inboundReply.findUniqueOrThrow({ where: { id: reply.id } })).ownerConfirmed).toBe(false);
  });

  it("a bounce (DSN) referencing our message → FAILED + bounced", async () => {
    const { acc, request, out } = await sentRequest();
    await header(acc.id, "m-dsn", {
      threadId: "t-dsn", fromAddress: "mailer-daemon@googlemail.com", fromDomain: "googlemail.com", subject: "Delivery Status Notification (Failure)",
    });
    vi.stubGlobal("fetch", gmailFake({
      messages: {
        "m-dsn": {
          threadId: "t-dsn",
          headers: [{ name: "References", value: "<orig@localhost>" }, { name: "Content-Type", value: 'multipart/report; report-type=delivery-status; boundary="b"' }],
          raw: mime("mailer-daemon@googlemail.com", "Delivery Status Notification (Failure)", "Address not found"),
        },
      },
    }).fn);
    const res = await pollReplies(new Date(T0.getTime() + 2 * DAY));
    expect(res.bounced).toBe(1);
    const r = await db.request.findUniqueOrThrow({ where: { id: request.id } });
    expect(r).toMatchObject({ status: "FAILED", bounced: true });
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } })).error).toBe("bounced");
    expect(await db.requestEvent.count({ where: { requestId: request.id, type: "BOUNCED" } })).toBe(1);
  });

  it("marketing > 10 business days after clockStart → stillEmailing + EvidenceHeader with full raw headers", async () => {
    const { acc, request } = await sentRequest();
    const early = new Date(T0.getTime() + 3 * DAY);
    const late = new Date(addBusinessDays(T0, 10).getTime() + DAY);
    await header(acc.id, "m-early", { fromAddress: "news@acme.example", listId: "<news.acme.example>", receivedAt: early });
    await header(acc.id, "m-late", { fromAddress: "news@acme.example", listId: "<news.acme.example>", receivedAt: late });
    const fullHeaders = [
      { name: "From", value: "Acme <news@acme.example>" }, { name: "List-Id", value: "<news.acme.example>" },
      { name: "DKIM-Signature", value: "v=1; d=acme.example; h=from:list-id" }, { name: "Received", value: "from mta.acme.example" },
    ];
    const g = gmailFake({ messages: { "m-early": { threadId: "x1", headers: fullHeaders }, "m-late": { threadId: "x2", headers: fullHeaders } } });
    vi.stubGlobal("fetch", g.fn);
    const res = await pollReplies(new Date(late.getTime() + DAY));
    expect(res.evidence).toBe(1);
    expect(res.matched).toBe(0);
    const r = await db.request.findUniqueOrThrow({ where: { id: request.id } });
    expect(r.stillEmailing).toBe(true);
    const ev = await db.evidenceHeader.findMany({ where: { requestId: request.id } });
    expect(ev).toHaveLength(1);
    // Fetched with format=metadata and no header filter (every header).
    const call = g.calls.find((c) => c.url.pathname.endsWith("/m-late"))!;
    expect(call.url.searchParams.get("format")).toBe("metadata");
    expect(call.url.searchParams.getAll("metadataHeaders")).toEqual([]);
  });
});

describe("deadline tick", () => {
  it("SENT/ACKNOWLEDGED past dueAt → OVERDUE; reminder offered at dueAt+3d; escalation opens after the reminder window", async () => {
    const { request } = await sentRequest();
    const ack = (await sentRequest({ status: "ACKNOWLEDGED", threadId: "t2", mid: "<o2@x>" })).request;
    const due = request.dueAt!;

    let r = await deadlineTick(new Date(due.getTime() - 1000));
    expect(r.overdue).toEqual([]);
    r = await deadlineTick(new Date(due.getTime() + 1000));
    expect(r.overdue.sort()).toEqual([request.id, ack.id].sort());
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("OVERDUE");
    expect(r.reminderOffered).toEqual([]);

    r = await deadlineTick(addCalendarDays(due, 3));
    expect(r.reminderOffered.sort()).toEqual([request.id, ack.id].sort());
    r = await deadlineTick(addCalendarDays(due, 4));
    expect(r.reminderOffered).toEqual([]); // once

    const sentAt = addCalendarDays(due, 4);
    await db.request.update({ where: { id: request.id }, data: deadlineColumns(request, request.clockStart!, { reminderSentAt: sentAt }) });
    await db.request.update({ where: { id: request.id }, data: { reminderSentAt: sentAt } });
    r = await deadlineTick(addCalendarDays(sentAt, 6));
    expect(r.escalationOpen).toEqual([]);
    r = await deadlineTick(new Date(addCalendarDays(sentAt, 7).getTime() + 1));
    expect(r.escalationOpen).toEqual([request.id]);
  });

  it("unsubscribe-only requests auto-complete after 10 business days without marketing", async () => {
    const quiet = (await sentRequest({ type: "ONE_CLICK", threadId: "q", mid: "<q@x>" })).request;
    const acc = await db.mailAccount.findFirstOrThrow();
    const co = await db.company.create({ data: { name: "Noisy", primaryDomain: "noisy.example", sendsAds: true } });
    const noisy = (
      await seedRequest({
        companyId: co.id, accountId: acc.id, status: "SENT", type: "ONE_CLICK", kind: "ONE_CLICK_POST", sendAfter: null, sentAt: T0,
        extra: deadlineColumns({ lawKeys: ["PDPL"] }, T0),
      })
    ).request;
    const tenBd = addBusinessDays(T0, 10);
    await header(acc.id, "n1", { fromAddress: "news@noisy.example", fromDomain: "noisy.example", listId: "<x>", receivedAt: new Date(tenBd.getTime() - DAY) });

    let r = await deadlineTick(new Date(tenBd.getTime() - DAY));
    expect(r.autoCompleted).toEqual([]);
    r = await deadlineTick(new Date(tenBd.getTime() + 1000));
    expect(r.autoCompleted).toEqual([quiet.id]);
    expect(await db.request.findUniqueOrThrow({ where: { id: quiet.id } })).toMatchObject({ status: "COMPLETED" });
    expect((await db.request.findUniqueOrThrow({ where: { id: noisy.id } })).status).toBe("SENT");
  });
});

describe("owner actions", () => {
  it("confirmReply: NEEDS_ID → NEEDS_ACTION, then a 6e ID-reply draft threaded to that reply", async () => {
    const { acc, request } = await sentRequest();
    const h = await header(acc.id, "m-id", { threadId: "t-sent", internetMessageId: "<ask@acme.example>" });
    const reply = await db.inboundReply.create({
      data: {
        requestId: request.id, providerMsgId: h.providerMsgId, receivedAt: h.receivedAt, fromAddress: "privacy@acme.example",
        subject: `Re: Request to delete my data — Ref ${request.reference}`, bodyCipher: Buffer.alloc(0), matchMethod: "THREAD", suggestedClass: "NEEDS_ID",
      },
    });
    await confirmReply(reply.id, "NEEDS_ID");
    expect(await db.request.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "NEEDS_ACTION", needsActionReason: "ID_VERIFICATION" });
    expect((await trackerRows()).find((x) => x.requestId === request.id)?.nextAction.kind).toBe("REPLY_WITH_DETAILS");

    const { outboundId } = await createIdReplyDraft(request.id);
    const d = await db.outboundMessage.findUniqueOrThrow({ where: { id: outboundId } });
    expect(d).toMatchObject({ kind: "ID_REPLY", templateId: "6e", toAddress: "privacy@acme.example", approvedHash: null, threadId: `reply:${h.id}` });
    expect(d.subject).toBe(`Re: Request to delete my data — Ref ${request.reference}`);
    expect(d.bodyText).toContain(request.reference);
    expect(d.bodyText).not.toContain("{{");
    expect((await createIdReplyDraft(request.id)).outboundId).toBe(outboundId); // idempotent
  });

  it("confirmReply COMPLETED closes; EXTENSION inside the period extends PDPL to 60 days", async () => {
    const a = await sentRequest();
    const r1 = await db.inboundReply.create({
      data: { requestId: a.request.id, providerMsgId: "x", receivedAt: T0, fromAddress: "p@acme.example", subject: "s", bodyCipher: Buffer.alloc(0), matchMethod: "THREAD" },
    });
    await confirmReply(r1.id, "EXTENSION", new Date(T0.getTime() + 10 * DAY));
    let r = await db.request.findUniqueOrThrow({ where: { id: a.request.id } });
    expect(r.extensionClaimed).toBe(true);
    expect(r.dueAt?.toISOString()).toBe(addCalendarDays(T0, 60).toISOString());
    expect(r.extendedDueAt?.toISOString()).toBe(addCalendarDays(T0, 60).toISOString());

    // A notice dated after the original period does not extend it.
    const b = await sentRequest({ threadId: "tb", mid: "<b@x>" });
    await recordExtension(b.request.id, new Date(T0.getTime() + 40 * DAY));
    r = await db.request.findUniqueOrThrow({ where: { id: b.request.id } });
    expect(r.extendedDueAt).toBeNull();
    expect(r.dueAt?.toISOString()).toBe(addCalendarDays(T0, 30).toISOString());

    await confirmReply(r1.id, "COMPLETED");
    r = await db.request.findUniqueOrThrow({ where: { id: a.request.id } });
    expect(r.status).toBe("COMPLETED");
    expect(r.closedAt).not.toBeNull();
  });

  it("createReminderDraft: only when OVERDUE from dueAt+3d, one reminder, ≤3 messages per case", async () => {
    const { request } = await sentRequest({ status: "OVERDUE" });
    await expect(createReminderDraft(request.id, new Date(request.dueAt!.getTime() + DAY))).rejects.toMatchObject({ code: "too_early" });
    const now = addCalendarDays(request.dueAt!, 3);
    const { outboundId } = await createReminderDraft(request.id, now);
    const d = await db.outboundMessage.findUniqueOrThrow({ where: { id: outboundId } });
    expect(d).toMatchObject({ kind: "REMINDER", templateId: "6b", approvedHash: null, toAddress: "privacy@acme.example" });
    expect(d.subject).toBe(`Re: Request to delete my data — Ref ${request.reference}`);
    expect(d.bodyText).toMatch(/^OVERDUE — request to delete personal data/);
    expect(d.bodyText).toContain("I have received no response");
    expect(d.bodyText).toContain("Original request (sent");
    expect(d.bodyText).not.toContain("{{");
    expect((await createReminderDraft(request.id, now)).outboundId).toBe(outboundId);
    await db.outboundMessage.update({ where: { id: outboundId }, data: { sentAt: now } });
    await expect(createReminderDraft(request.id, now)).rejects.toBeInstanceOf(TrackError);
    await expect(createReminderDraft(request.id, now)).rejects.toMatchObject({ code: "limit_reached" });
  });

  it("markWebFormSubmitted sets clockStart + deadlines and SENT", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    const { request } = await seedRequest({ companyId: co.id, accountId: acc.id, status: "DRAFT", type: "WEB_FORM", kind: "WEB_FORM_COPY", to: "https://acme.example/form", sendAfter: null });
    expect((await trackerDetail(request.id)).nextAction).toMatchObject({ kind: "SUBMIT_WEB_FORM", url: "https://acme.example/form" });
    await markWebFormSubmitted(request.id, T0, new Date(T0.getTime() + 1000));
    const r = await db.request.findUniqueOrThrow({ where: { id: request.id } });
    expect(r.status).toBe("SENT");
    expect(r.clockStart?.getTime()).toBe(T0.getTime());
    expect(r.dueAt?.toISOString()).toBe(addCalendarDays(T0, 30).toISOString());
    await expect(markWebFormSubmitted(request.id, new Date(Date.now() + 86_400_000))).rejects.toMatchObject({ code: "bad_date" });
  });
});

describe("tracker next actions (04-ux §7)", () => {
  it("one primary action per status", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    const mk = async (status: Parameters<typeof seedRequest>[0]["status"], extra: Record<string, unknown> = {}) =>
      (await seedRequest({ companyId: co.id, accountId: acc.id, status, sendAfter: status === "QUEUED" ? T0 : null, sentAt: ["SENT", "ACKNOWLEDGED", "OVERDUE", "REFUSED", "ESCALATED", "COMPLETED"].includes(status!) ? T0 : null, extra })).request;
    const ids = {
      queued: await mk("QUEUED"),
      sent: await mk("SENT"),
      ack: await mk("ACKNOWLEDGED"),
      overdue: await mk("OVERDUE", { reminderOfferedAt: T0 }),
      refused: await mk("REFUSED"),
      escalated: await mk("ESCALATED"),
      failed: await mk("FAILED"),
      perm: await mk("NEEDS_ACTION", { needsActionReason: "SEND_PERMISSION" }),
    };
    const rows = await trackerRows();
    const kind = (id: string) => rows.find((r) => r.requestId === id)!.nextAction.kind;
    expect(kind(ids.queued.id)).toBe("CANCEL");
    expect(kind(ids.sent.id)).toBe("NONE");
    expect(kind(ids.ack.id)).toBe("NONE");
    expect(kind(ids.overdue.id)).toBe("SEND_REMINDER");
    expect(kind(ids.refused.id)).toBe("ESCALATE");
    expect(kind(ids.escalated.id)).toBe("ADD_COMPLAINT_REF");
    expect(kind(ids.failed.id)).toBe("FIX_ADDRESS");
    expect(kind(ids.perm.id)).toBe("GRANT_SEND_PERMISSION");
    expect(rows.find((r) => r.requestId === ids.sent.id)!.group).toBe("WAITING");
    expect(rows[0].group).toBe("NEEDS_YOU");
  });
});

describe("keyword classifier (EN + AR)", () => {
  it.each([
    ["We have received your request and will respond within 30 days.", "ACKNOWLEDGED"],
    ["Your personal data has been deleted.", "COMPLETED"],
    ["We are unable to comply as we are required to retain this data.", "REFUSED"],
    ["Please verify your identity by sending a copy of your passport.", "NEEDS_ID"],
    ["We need to extend the deadline by a further two months.", "EXTENSION"],
    ["تم استلام طلبك وسيتم الرد خلال ٣٠ يوماً", "ACKNOWLEDGED"],
    ["تم حذف بياناتك الشخصية وإلغاء اشتراكك", "COMPLETED"],
    ["يرجى إثبات الهوية وإرفاق صورة من الهوية الوطنية", "NEEDS_ID"],
    ["لا يمكننا حذف بياناتك لأننا ملزمون بالاحتفاظ بها", "REFUSED"],
    ["نحتاج إلى تمديد المهلة ثلاثين يوماً إضافية", "EXTENSION"],
  ])("%s → %s", (text, cls) => {
    expect(classifyReply({ text }).cls).toBe(cls);
  });
  it("ignores quoted history and flags auto-acknowledgements", () => {
    expect(classifyReply({ text: "Thanks.\n\nOn Mon, 5 Oct 2026 Sara wrote:\n> please delete my data, it has been deleted elsewhere" }).cls).toBeNull();
    const auto = classifyReply({ text: "We have received your request.", subject: "Automatic reply", autoSubmitted: "auto-replied" });
    expect(auto).toMatchObject({ cls: "ACKNOWLEDGED", confidence: "HIGH", autoAck: true });
    expect(classifyReply({ text: "We have received your request. We need to verify your identity." }).autoAck).toBe(false);
  });
});
