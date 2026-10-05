import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { db } from "@/lib/db";
import { computeDraftHash, queueApproved, undoQueued, UNDO_WINDOW_MS } from "@/lib/legal/drafts";
import { buildMime, replySubject } from "@/lib/send/mime";
import { dispatchDue, SEND_SPACING_MS } from "@/lib/send/dispatcher";
import { cancelQueued } from "@/lib/track/actions";
import { approveOutbound, queueOutbound } from "@/lib/track/followups";
import { resetDb } from "./helpers";
import { gmailFake, graphFake, notificationsOff, seedAccount, seedCompany, seedOwner, seedRequest, T0 } from "./m5-helpers";

beforeEach(async () => {
  await resetDb();
  await seedOwner();
  await notificationsOff();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const at = (ms: number) => new Date(T0.getTime() + ms);

describe("MIME", () => {
  it("builds text/plain + HTML with our Message-ID", async () => {
    const mime = (await buildMime({
      from: { address: "sara@gmail.com", name: "Sara Al-Harbi" }, to: "privacy@acme.example", subject: "Delete — Ref SD-7F3K",
      text: "Hello\n\nمرحبا", messageId: "<abc@stopdisturbance.test>",
    })).toString();
    expect(mime).toMatch(/^Message-ID: <abc@stopdisturbance\.test>/m);
    expect(mime).toMatch(/Content-Type: multipart\/alternative/);
    expect(mime).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    expect(mime).toMatch(/Content-Type: text\/html; charset=utf-8/);
    expect(mime).not.toMatch(/^In-Reply-To:/m);
  });

  it("reminders carry In-Reply-To, References and the same subject", async () => {
    const mime = (await buildMime({
      from: { address: "sara@gmail.com" }, to: "privacy@acme.example", subject: replySubject("Re: Delete — Ref SD-7F3K"),
      text: "Reminder", messageId: "<r@x>", inReplyTo: "<orig@x>", references: ["<orig@x>"],
    })).toString();
    expect(mime).toMatch(/^In-Reply-To: <orig@x>/m);
    expect(mime).toMatch(/^References: <orig@x>/m);
    expect(mime).toMatch(/^Subject: Re: Delete — Ref SD-7F3K|^Subject: =\?UTF-8/m);
    expect(replySubject("RE: re: Delete — Ref SD-7F3K")).toBe("Re: Delete — Ref SD-7F3K");
  });
});

describe("Gmail send", () => {
  it("sends raw MIME and stores providerMessageId, threadId and Message-ID; Request SENT with deadlines", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    const { request, out } = await seedRequest({ companyId: co.id, accountId: acc.id });
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);

    const res = await dispatchDue(at(11_000));
    expect(res).toEqual([{ outboundId: out.id, result: "sent" }]);
    expect(g.sent).toHaveLength(1);
    const mime = g.sent[0].mime;
    expect(mime).toMatch(/^Message-ID: <[0-9a-f-]{36}@localhost>/m);
    expect(mime).toMatch(/^To: privacy@acme\.example/m);
    expect(mime).toMatch(/^From: "?Sara Al-Harbi"? <sara@gmail\.com>/m);

    const o = await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } });
    expect(o.providerMessageId).toBe("g1");
    expect(o.threadId).toBe("t-g1");
    expect(o.internetMessageId).toMatch(/@localhost>$/);
    expect(o.sentAt?.getTime()).toBe(at(11_000).getTime());
    const r = await db.request.findUniqueOrThrow({ where: { id: request.id } });
    expect(r.status).toBe("SENT");
    expect(r.clockStart?.getTime()).toBe(at(11_000).getTime());
    expect(r.dueAt?.toISOString()).toBe("2026-11-04T20:59:59.999Z"); // +30 days, end of day Riyadh
    expect(r.reminderOfferedAt?.toISOString()).toBe("2026-11-07T20:59:59.999Z");
    expect(r.complaintWindowEndsAt?.toISOString()).toBe("2027-02-02T20:59:59.999Z");
    expect(r.escalationOpenAt).toBeNull();
    expect(await db.requestEvent.count({ where: { requestId: request.id, type: "SENT" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "request.sent" } })).toBe(1);
  });

  it("a reminder threads in Gmail: threadId, In-Reply-To, References, same subject", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    const { request } = await seedRequest({
      companyId: co.id, accountId: acc.id, status: "OVERDUE", sendAfter: null, sentAt: at(-40 * 86400_000),
      threadId: "t-orig", internetMessageId: "<orig@localhost>", providerMessageId: "g0", extra: { clockStart: at(-40 * 86400_000) },
    });
    const first = await db.outboundMessage.findFirstOrThrow({ where: { requestId: request.id } });
    const body = "OVERDUE — reminder";
    const subject = replySubject(first.subject!);
    const rem = await db.outboundMessage.create({
      data: {
        requestId: request.id, kind: "REMINDER", templateId: "6b", templateVersion: "1", language: "en", toAddress: first.toAddress,
        subject, bodyText: body, draftHash: computeDraftHash(first.toAddress, subject, body),
      },
    });
    await approveOutbound(rem.id);
    await queueOutbound(rem.id);
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);
    const res = await dispatchDue(new Date(Date.now() + 11_000));
    expect(res.map((r) => r.result)).toEqual(["sent"]);
    const sendCall = g.calls.find((c) => c.url.pathname.endsWith("/messages/send"))!;
    expect(JSON.parse(sendCall.body!).threadId).toBe("t-orig");
    expect(g.sent[0].mime).toMatch(/^In-Reply-To: <orig@localhost>/m);
    expect(g.sent[0].mime).toMatch(/^References: <orig@localhost>/m);
    expect((await simpleParser(g.sent[0].mime)).subject).toBe(`Re: Request to delete my data — Ref ${request.reference}`);
    const r = await db.request.findUniqueOrThrow({ where: { id: request.id } });
    expect(r.status).toBe("OVERDUE");
    expect(r.reminderSentAt).not.toBeNull();
    expect(r.escalationOpenAt).not.toBeNull();
  });
});

describe("Graph send", () => {
  it("creates a draft, reads internetMessageId/conversationId, then sends", async () => {
    const acc = await seedAccount({ provider: "MICROSOFT" });
    const co = await seedCompany();
    const { request, out } = await seedRequest({ companyId: co.id, accountId: acc.id });
    const g = graphFake();
    vi.stubGlobal("fetch", g.fn);
    const res = await dispatchDue(at(11_000));
    expect(res[0].result).toBe("sent");
    const seq = g.calls.map((c) => `${c.method} ${c.url.pathname.replace("/v1.0/me", "")}`);
    expect(seq[0]).toBe("POST /messages");
    expect(seq[1]).toBe("POST /messages/AAMk1/send");
    expect(g.calls[0].headers.prefer).toContain("ImmutableId");
    expect(g.drafts.get("AAMk1")!.to).toBe("privacy@acme.example");
    expect(g.drafts.get("AAMk1")!.sent).toBe(true);
    const o = await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } });
    expect(o).toMatchObject({ providerMessageId: "AAMk1", internetMessageId: "<AAMk1@outlook.example>", threadId: "conv-AAMk1" });
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("SENT");
  });

  it("a reminder threads in Outlook via createReply on the sent message", async () => {
    const acc = await seedAccount({ provider: "MICROSOFT" });
    const co = await seedCompany();
    const g = graphFake();
    vi.stubGlobal("fetch", g.fn);
    const { request, out } = await seedRequest({ companyId: co.id, accountId: acc.id });
    await dispatchDue(at(11_000));
    await db.request.update({ where: { id: request.id }, data: { status: "OVERDUE" } });
    const first = await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } });
    const subject = replySubject(first.subject!);
    const rem = await db.outboundMessage.create({
      data: {
        requestId: request.id, kind: "REMINDER", templateId: "6b", templateVersion: "1", language: "en", toAddress: first.toAddress,
        subject, bodyText: "Reminder", draftHash: computeDraftHash(first.toAddress, subject, "Reminder"),
      },
    });
    await approveOutbound(rem.id, at(100_000));
    await queueOutbound(rem.id, at(100_000));
    const res = await dispatchDue(at(200_000));
    expect(res.map((r) => r.result)).toEqual(["sent"]);
    const seq = g.calls.map((c) => `${c.method} ${c.url.pathname.replace("/v1.0/me", "")}`);
    expect(seq).toContain("POST /messages/AAMk1/createReply");
    expect(seq).toContain("PATCH /messages/AAMk2");
    expect(seq).toContain("POST /messages/AAMk2/send");
    expect(g.drafts.get("AAMk2")).toMatchObject({ to: "privacy@acme.example", subject, conversationId: "conv-AAMk1", sent: true });
    const r = await db.outboundMessage.findUniqueOrThrow({ where: { id: rem.id } });
    expect(r.threadId).toBe("conv-AAMk1");
  });
});

describe("dispatcher safety", () => {
  it("undo within 10 s prevents the send (fake clock)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const acc = await seedAccount();
    const co = await seedCompany();
    const { request, out } = await seedRequest({ companyId: co.id, accountId: acc.id, status: "APPROVED", sendAfter: null });
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);

    const { sendAfter } = await queueApproved(out.id, T0);
    expect(sendAfter.getTime() - T0.getTime()).toBe(UNDO_WINDOW_MS);
    vi.setSystemTime(at(5_000));
    expect(await dispatchDue(at(5_000))).toEqual([]); // still inside the undo window
    await undoQueued(out.id, at(6_000));
    vi.setSystemTime(at(20_000));
    expect(await dispatchDue(at(20_000))).toEqual([]);
    expect(g.calls).toHaveLength(0);
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("APPROVED");

    // cancelQueued (tracker "Cancel") works the same way while queued.
    await queueApproved(out.id, at(30_000));
    await cancelQueued(out.id);
    expect(await dispatchDue(at(60_000))).toEqual([]);
    expect(g.calls).toHaveLength(0);

    // Without undo it goes out once the window has passed.
    await queueApproved(out.id, at(70_000));
    expect(await dispatchDue(at(79_000))).toEqual([]);
    expect((await dispatchDue(at(80_000)))[0].result).toBe("sent");
  });

  it("enforces ≥30 s spacing per mailbox and serial sends (fake clock)", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    await seedRequest({ companyId: co.id, accountId: acc.id });
    const b = await seedRequest({ companyId: co.id, accountId: acc.id });
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);

    const t1 = at(11_000);
    const r1 = await dispatchDue(t1);
    expect(r1.map((x) => x.result)).toEqual(["sent", "skipped_spacing"]);
    expect((await dispatchDue(new Date(t1.getTime() + SEND_SPACING_MS - 1)))[0].result).toBe("skipped_spacing");
    const r3 = await dispatchDue(new Date(t1.getTime() + SEND_SPACING_MS));
    expect(r3).toEqual([{ outboundId: b.out.id, result: "sent" }]);
    expect(g.sent).toHaveLength(2);
  });

  it("enforces the 50/day/mailbox cap (Riyadh day; Setting sendCapPerDay)", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    for (let i = 0; i < 50; i++) {
      await seedRequest({ companyId: co.id, accountId: acc.id, status: "SENT", sendAfter: null, sentAt: at(-3_600_000 + i * 31_000) });
    }
    const q = await seedRequest({ companyId: co.id, accountId: acc.id, sendAfter: at(3_600_000) });
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);
    expect((await dispatchDue(at(3_700_000)))[0]).toEqual({ outboundId: q.out.id, result: "skipped_cap" });
    expect(g.calls).toHaveLength(0);
    // Next day in Riyadh (00:00 +03:00) the cap resets.
    expect((await dispatchDue(new Date("2026-10-06T00:00:30+03:00")))[0].result).toBe("sent");

    // A lower configured cap applies.
    await db.setting.create({ data: { key: "sendCapPerDay", value: 1 } });
    await seedRequest({ companyId: co.id, accountId: acc.id, sendAfter: new Date("2026-10-06T00:01:00+03:00") });
    expect((await dispatchDue(new Date("2026-10-06T00:05:00+03:00")))[0].result).toBe("skipped_cap");
  });

  it("refuses when the approved hash no longer matches the fields (approval revoked)", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    const { request, out } = await seedRequest({ companyId: co.id, accountId: acc.id });
    await db.outboundMessage.update({ where: { id: out.id }, data: { bodyText: "tampered" } });
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);
    expect((await dispatchDue(at(11_000)))[0].result).toBe("revoked");
    expect(g.calls).toHaveLength(0);
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("DRAFT");
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } })).approvedHash).toBeNull();
  });

  it("never sends WEB_FORM_COPY", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    await seedRequest({ companyId: co.id, accountId: acc.id, type: "WEB_FORM", kind: "WEB_FORM_COPY", to: "https://acme.example/privacy-form" });
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);
    expect(await dispatchDue(at(60_000))).toEqual([]);
    expect(g.calls).toHaveLength(0);
  });

  it("without the send scope → NEEDS_ACTION SEND_PERMISSION, resumes after the grant", async () => {
    const acc = await seedAccount({ send: false });
    const co = await seedCompany();
    const { request } = await seedRequest({ companyId: co.id, accountId: acc.id });
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);
    expect((await dispatchDue(at(11_000)))[0].result).toBe("needs_permission");
    expect(await db.request.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "NEEDS_ACTION", needsActionReason: "SEND_PERMISSION" });
    expect(g.calls).toHaveLength(0);
    await db.mailAccount.update({ where: { id: acc.id }, data: { grantedScopes: { push: "https://www.googleapis.com/auth/gmail.send" } } });
    expect((await dispatchDue(at(60_000)))[0].result).toBe("sent");
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("SENT");
  });

  it("one retry, then FAILED with the reason", async () => {
    const acc = await seedAccount();
    const co = await seedCompany();
    const { request, out } = await seedRequest({ companyId: co.id, accountId: acc.id });
    const g = gmailFake({ sendStatus: 503 });
    vi.stubGlobal("fetch", g.fn);
    expect((await dispatchDue(at(11_000)))[0].result).toBe("retry");
    expect((await dispatchDue(at(30_000)))).toEqual([]); // retry waits 60 s
    expect((await dispatchDue(at(75_000)))[0]).toMatchObject({ result: "failed", reason: "provider_http_503" });
    expect((await db.request.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("FAILED");
    const o = await db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } });
    expect(o).toMatchObject({ error: "provider_http_503", attempts: 2, sendAfter: null, sentAt: null });
    expect(await dispatchDue(at(500_000))).toEqual([]);
  });
});
