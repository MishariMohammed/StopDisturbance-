import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/tokens";
import { addCalendarDays } from "@/lib/deadlines";
import { formatLetterDate } from "@/lib/legal/drafts";
import { findBannedPhrases } from "@/lib/legal/render";
import { alertMessage, sendAlert } from "@/lib/notify/alerts";
import { buildDigest, sendWeeklyDigest } from "@/lib/notify/digest";
import { NOTIFICATIONS_KEY, setNotificationSettings } from "@/lib/notify/settings";
import { buildEvidenceZip, escalationPacket, markEscalated } from "@/lib/track/actions";
import { deadlineColumns } from "@/lib/track/state";
import { resetDb } from "./helpers";
import { gmailFake, readZip, seedAccount, seedCompany, seedOwner, seedRequest, T0 } from "./m5-helpers";

const DAY = 86_400_000;

beforeEach(async () => {
  await resetDb();
});
afterEach(() => vi.unstubAllGlobals());

async function overdueCase() {
  await seedOwner();
  const acc = await seedAccount();
  const co = await seedCompany("Noon Shopping", "noon.example");
  await db.sender.create({ data: { registrableDomain: "noon.example", companyId: co.id, firstSeen: new Date("2025-03-01"), lastSeen: T0, accountIds: [acc.id] } });
  const reminderSentAt = addCalendarDays(T0, 34);
  const { request, out } = await seedRequest({
    companyId: co.id, accountId: acc.id, status: "OVERDUE", sendAfter: null, sentAt: T0, threadId: "t-1", internetMessageId: "<orig@localhost>",
    providerMessageId: "g1", extra: { ...deadlineColumns({ lawKeys: ["PDPL"] }, T0, { reminderSentAt }), reminderSentAt },
  });
  await db.inboundReply.create({
    data: {
      requestId: request.id, providerMsgId: "r1", receivedAt: new Date(T0.getTime() + 2 * DAY), fromAddress: "privacy@noon.example",
      subject: "Re: your request", bodyCipher: encrypt("From: privacy@noon.example\r\nSubject: Re: your request\r\n\r\nWe received your request.\r\n"),
      matchMethod: "THREAD", suggestedClass: "ACKNOWLEDGED", ownerConfirmed: true,
    },
  });
  await db.evidenceHeader.create({ data: { requestId: request.id, receivedAt: addCalendarDays(T0, 20), rawHeadersCipher: encrypt("From: news@noon.example\r\nList-Id: <n>\r\n") } });
  await db.requestEvent.create({ data: { requestId: request.id, type: "SENT", actor: "SYSTEM", at: T0, data: { outboundId: out.id } } });
  return { acc, co, request, out };
}

describe("escalation packet (6c)", () => {
  it.each(["en", "ar"] as const)("%s: fully filled, no banned phrases, SDAIA portal, deadline info", async (lang) => {
    const { request } = await overdueCase();
    const p = await escalationPacket(request.id, lang);
    expect(p.complaintText).not.toContain("{{");
    expect(p.complaintText).not.toContain("}}");
    expect(findBannedPhrases(p.complaintText)).toEqual([]);
    expect(p.complaintText).toContain("Noon Shopping");
    expect(p.complaintText).toContain("Sara Al-Harbi");
    expect(p.regulator.url).toBe("https://dgp.sdaia.gov.sa");
    expect(p.regulator.name).toContain(lang === "en" ? "SDAIA" : "سدايا");
    expect(p.deadlineInfo.length).toBeGreaterThan(10);
    expect(p.evidenceSummary.length).toBeGreaterThanOrEqual(3);
    // The regulator can match the complaint to the request: reference SD-XXXX and the original send date.
    expect(request.reference).toMatch(/^SD-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(p.complaintText).toContain(request.reference);
    expect(p.complaintText).toContain(formatLetterDate(T0, lang));
    if (lang === "en") {
      expect(p.complaintText).toContain(`Request reference: ${request.reference}, sent ${formatLetterDate(T0, "en")}`);
      expect(p.complaintText).toContain("Marketing emails received after my request: 1");
      expect(p.complaintText).toContain("IR Art. 4");
      expect(p.evidenceSummary[0]).toContain("<orig@localhost>");
    } else {
      expect(p.complaintText).toContain("شكوى ضد: Noon Shopping");
      expect(p.complaintText).toContain(`رقم الطلب: ${request.reference}، أُرسل بتاريخ ${formatLetterDate(T0, "ar")}`);
    }
  });

  it("markEscalated records the complaint reference; nothing is filed", async () => {
    const { request } = await overdueCase();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(String(u));
      throw new Error("no network");
    });
    await escalationPacket(request.id, "en");
    await markEscalated(request.id, "SDAIA-2026-123");
    expect(await db.request.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "ESCALATED", complaintRef: "SDAIA-2026-123" });
    expect(calls).toEqual([]);
  });
});

describe("evidence ZIP", () => {
  it("contains EML of the sent mail and replies, post-request marketing headers and timeline.json", async () => {
    const { request } = await overdueCase();
    const zip = await buildEvidenceZip(request.id);
    const files = readZip(zip);
    const names = [...files.keys()];
    const ref = request.reference;
    expect(names.some((n) => n.startsWith(`${ref}/sent/`) && n.endsWith(".eml"))).toBe(true);
    expect(names.some((n) => n.startsWith(`${ref}/replies/`) && n.endsWith(".eml"))).toBe(true);
    expect(names.some((n) => n.startsWith(`${ref}/marketing-after-request/`))).toBe(true);
    expect(names).toContain(`${ref}/timeline.json`);

    const sent = await simpleParser(files.get(names.find((n) => n.includes("/sent/"))!)!);
    expect(sent.messageId).toBe("<orig@localhost>");
    expect(sent.subject).toContain(ref);
    expect(sent.date?.getTime()).toBe(T0.getTime());
    expect(sent.text).toContain("Please delete my data");
    const reply = files.get(names.find((n) => n.includes("/replies/"))!)!.toString();
    expect(reply).toContain("We received your request.");

    const timeline = JSON.parse(files.get(`${ref}/timeline.json`)!.toString());
    expect(timeline.request.reference).toBe(ref);
    expect(timeline.deadlines.dueAt).toBe(request.dueAt!.toISOString());
    expect(timeline.outbound[0]).toMatchObject({ approvedHash: expect.any(String), internetMessageId: "<orig@localhost>" });
    expect(timeline.replies[0]).toMatchObject({ matchMethod: "THREAD", bodyStored: true });
    expect(timeline.events.map((e: { type: string }) => e.type)).toContain("SENT");
  });
});

describe("notifications", () => {
  it("weekly digest: counts, company names only, sent from the first mailbox to itself", async () => {
    const { acc, co, request } = await overdueCase();
    const done = await seedRequest({ companyId: co.id, accountId: acc.id, status: "COMPLETED", sendAfter: null, sentAt: T0, extra: { closedAt: new Date(T0.getTime() + 3 * DAY) } });
    const jarir = await db.company.create({ data: { name: "Jarir", primaryDomain: "jarir.example" } });
    await seedRequest({ companyId: jarir.id, accountId: acc.id, status: "SENT", sendAfter: null, sentAt: T0, extra: deadlineColumns({ lawKeys: ["PDPL"] }, T0) });
    void done;
    const now = new Date(T0.getTime() + 5 * DAY);

    const d = (await buildDigest(now, "en"))!;
    expect(d.subject).toBe("1 company replied · 1 deadline passed");
    expect(d.text).toContain("Needs you (1)");
    expect(d.text).toContain("Noon Shopping");
    expect(d.text).toContain("Good news (1)");
    expect(d.text).toContain("Waiting (1) — next deadline: Jarir");
    expect(d.text).toContain("http://localhost:3000/en/tracker");
    expect(d.text).not.toContain("Re: your request"); // no subject lines of the owner's mail
    const ar = (await buildDigest(now, "ar"))!;
    expect(ar.subject).toContain("ردّت");
    expect(ar.text).toContain("بانتظارك");

    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);
    expect(await sendWeeklyDigest(now)).toBe(true);
    expect(g.sent).toHaveLength(1);
    const parsed = await simpleParser(g.sent[0].mime);
    expect(parsed.to && "text" in parsed.to ? parsed.to.text : "").toBe(acc.address);
    expect(parsed.from?.text).toContain(acc.address);
    expect(parsed.text).toContain("Noon Shopping");
    void request;

    await setNotificationSettings({ digest: false });
    expect(await sendWeeklyDigest(now)).toBe(false);
    expect(g.sent).toHaveLength(1);
  });

  it("instant alerts go to the owner's mailbox in their language and respect the toggle", async () => {
    const { acc, request } = await overdueCase();
    await db.owner.update({ where: { id: "owner" }, data: { locale: "ar" } });
    const g = gmailFake();
    vi.stubGlobal("fetch", g.fn);
    expect(await sendAlert("REPLY_RECEIVED", { requestId: request.id })).toBe(true);
    const parsed = await simpleParser(g.sent[0].mime);
    expect(parsed.subject).toBe("ردّت Noon Shopping");
    expect(parsed.text).toContain(request.reference);
    expect(parsed.html || "").toContain('dir="rtl"');
    expect(parsed.to && "text" in parsed.to ? parsed.to.text : "").toBe(acc.address);

    await db.setting.upsert({ where: { key: NOTIFICATIONS_KEY }, create: { key: NOTIFICATIONS_KEY, value: { replyReceived: false } }, update: { value: { replyReceived: false } } });
    expect(await sendAlert("REPLY_RECEIVED", { requestId: request.id })).toBe(false);
    expect(await sendAlert("OVERDUE", { requestId: request.id })).toBe(true);
    expect(g.sent).toHaveLength(2);
    expect(alertMessage("OVERDUE", "en", { company: "noon", ref: "SD-1", date: "1 Oct 2026", mailbox: "" }, "u").subject).toBe("noon missed the legal deadline");
  });
});
