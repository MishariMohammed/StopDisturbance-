import { db } from "@/lib/db";
import { formatLetterDate } from "@/lib/legal/drafts";
import type { Regulator } from "@/lib/legal/jurisdiction";
import { renderTemplate } from "@/lib/legal/render";
import { caseContext } from "@/lib/track/context";
import { isListMail } from "@/lib/track/poll";
import { regulatorInfo } from "@/lib/track/regulators";
import { companyDomains, TrackError } from "@/lib/track/state";

// EscalationWizard data (04-ux §7.4; template 6c EN, 6c-AR for SDAIA). We never file anything:
// the packet is text + the regulator portal link; the owner files and records the reference.

export interface EscalationPacket {
  regulator: { name: string; url: string };
  complaintText: string;
  deadlineInfo: string;
  evidenceSummary: string[];
}

const INFRINGE: Record<string, { deadline: string; marketing: string; deletion: string }> = {
  PDPL: { deadline: "IR Art. 4", marketing: "PDPL Art. 25–26, IR Art. 28", deletion: "PDPL Art. 4, 18" },
  GDPR: { deadline: "GDPR Art. 12(3)", marketing: "GDPR Art. 21(3)", deletion: "GDPR Art. 17" },
  UK_GDPR: { deadline: "UK GDPR Art. 12(3)", marketing: "UK GDPR Art. 21(3), PECR reg. 22", deletion: "UK GDPR Art. 17" },
  CAN_SPAM: { deadline: "15 U.S.C. §7704(a)(4)", marketing: "15 U.S.C. §7704(a)(4)", deletion: "" },
};

const CLASS_TEXT: Record<string, { en: string; ar: string }> = {
  ACKNOWLEDGED: { en: "acknowledgement only", ar: "إشعار استلام فقط" },
  NEEDS_ID: { en: "a request for identity verification", ar: "طلب التحقق من الهوية" },
  EXTENSION: { en: "an extension notice", ar: "إشعار بالتمديد" },
  REFUSED: { en: "a refusal", ar: "رفض الطلب" },
  COMPLETED: { en: "a claim of completion", ar: "إفادة بالتنفيذ" },
};

const DAY = 86_400_000;

export async function escalationPacket(requestId: string, lang: "en" | "ar", regulatorKey?: Regulator): Promise<EscalationPacket> {
  const request = await db.request.findUnique({ where: { id: requestId } });
  if (!request) throw new TrackError("not_found");
  if (!request.clockStart) throw new TrackError("bad_status", "Nothing was sent yet");
  const ctx = await caseContext(request);
  const fmt = (d: Date) => formatLetterDate(d, lang);

  // Arabic text is the SDAIA version (03-legal 6c-AR); English defaults to SDAIA too (PDPL is the base law).
  const key: Regulator = lang === "ar" ? "SDAIA" : (regulatorKey ?? ctx.jurisdiction.regulator);
  const reg = await regulatorInfo(key, ctx.jurisdiction.euCountry);

  const [replies, evidence, outs, senders] = await Promise.all([
    db.inboundReply.findMany({ where: { requestId, ownerConfirmed: true }, orderBy: { receivedAt: "asc" } }),
    db.evidenceHeader.findMany({ where: { requestId }, orderBy: { receivedAt: "asc" }, select: { receivedAt: true } }),
    db.outboundMessage.findMany({ where: { requestId, sentAt: { not: null } }, orderBy: { sentAt: "asc" } }),
    db.sender.findMany({ where: { companyId: request.companyId }, select: { id: true, firstSeen: true } }),
  ]);
  const domains = await companyDomains(request.companyId);
  const later = await db.messageHeader.findMany({
    where: { receivedAt: { gt: request.clockStart }, OR: [{ fromDomain: { in: domains } }, { senderId: { in: senders.map((s) => s.id) } }] },
    orderBy: { receivedAt: "asc" },
  });
  const marketingDates = [...new Set([...evidence.map((e) => e.receivedAt), ...later.filter(isListMail).map((h) => h.receivedAt)].map((d) => d.getTime()))]
    .sort((a, b) => a - b)
    .map((t) => new Date(t));
  const firstSeen = senders.reduce<Date | null>((m, s) => (!m || s.firstSeen < m ? s.firstSeen : m), null) ?? request.clockStart;

  const none = lang === "en" ? "none" : "لا يوجد";
  const responseSummary = replies.length
    ? replies
        .filter((r) => r.suggestedClass && CLASS_TEXT[r.suggestedClass])
        .map((r) => `${CLASS_TEXT[r.suggestedClass!][lang]} (${fmt(r.receivedAt)})`)
        .join(lang === "en" ? "; " : "؛ ") || none
    : none;
  const laws = ctx.jurisdiction.lawKeys.filter((k) => INFRINGE[k]);
  const infringe = (f: "deadline" | "marketing" | "deletion") => laws.map((k) => INFRINGE[k][f]).filter(Boolean).join(" / ") || INFRINGE.PDPL[f];
  const initial = outs.find((o) => o.kind === "INITIAL" || o.kind === "UNSUB_MAILTO" || o.kind === "ONE_CLICK_POST");
  const reminder = outs.find((o) => o.kind === "REMINDER");

  const evidenceList: string[] =
    lang === "en"
      ? [
          initial
            ? `original request sent ${fmt(request.clockStart)}${initial.internetMessageId ? ` (Message-ID ${initial.internetMessageId})` : ""}`
            : `web-form request submitted ${fmt(request.clockStart)}`,
          ...(reminder?.sentAt ? [`reminder sent ${fmt(reminder.sentAt)}`] : []),
          ...(replies.length ? [`${replies.length} company ${replies.length === 1 ? "reply" : "replies"}`] : []),
          ...(marketingDates.length ? [`${marketingDates.length} marketing emails received after the request (full headers)`] : []),
        ]
      : [
          initial ? `الطلب الأصلي المرسل في ${fmt(request.clockStart)}` : `الطلب المقدم عبر النموذج في ${fmt(request.clockStart)}`,
          ...(reminder?.sentAt ? [`التذكير المرسل في ${fmt(reminder.sentAt)}`] : []),
          ...(replies.length ? [`ردود الجهة (${replies.length})`] : []),
          ...(marketingDates.length ? [`رسائل تسويقية بعد الطلب (${marketingDates.length}) مع ترويساتها الكاملة`] : []),
        ];

  const values: Record<string, string> = {
    company: ctx.company.name,
    company_address_part: "",
    company_domain: ctx.company.primaryDomain,
    full_name: ctx.owner.fullName,
    country_of_residence: ctx.owner.countryName,
    user_email: ctx.mailbox?.address ?? ctx.emailAddresses[0] ?? "",
    law_citations: ctx.jurisdiction.citationsText(lang),
    email_addresses: ctx.emailAddresses.join(lang === "en" ? ", " : "، "),
    first_seen_date: fmt(firstSeen),
    reference_id: request.reference,
    original_send_date: fmt(request.clockStart),
    deadline_date: fmt(request.dueAt ?? request.clockStart),
    reminder_date: request.reminderSentAt ? fmt(request.reminderSentAt) : lang === "en" ? "— (no reminder was sent)" : "— (لم يُرسل)",
    response_summary: responseSummary,
    count: String(marketingDates.length),
    dates: marketingDates.length ? marketingDates.slice(0, 10).map(fmt).join(lang === "en" ? ", " : "، ") : none,
    infringement_deadline: infringe("deadline"),
    infringement_marketing: infringe("marketing"),
    infringement_deletion: infringe("deletion"),
    evidence_list: evidenceList.join(lang === "en" ? "; " : "؛ "),
  };
  const letter = renderTemplate("6c", lang, values);

  const due = request.dueAt;
  const daysOver = due ? Math.max(0, Math.floor((Date.now() - due.getTime()) / DAY)) : 0;
  const parts: string[] = [];
  if (lang === "en") {
    if (due) parts.push(`Legal deadline: ${fmt(due)}${daysOver > 0 ? ` (${daysOver} days ago)` : ""}.`);
    if (request.extendedDueAt) parts.push(`Extended deadline: ${fmt(request.extendedDueAt)}.`);
    parts.push(request.reminderSentAt ? `Reminder sent ${fmt(request.reminderSentAt)}.` : "No reminder sent.");
    if (request.complaintWindowEndsAt) parts.push(`SDAIA complaint window ends ${fmt(request.complaintWindowEndsAt)}.`);
  } else {
    if (due) parts.push(`آخر موعد نظامي: ${fmt(due)}${daysOver > 0 ? ` (قبل ${daysOver} يومًا)` : ""}.`);
    if (request.extendedDueAt) parts.push(`الموعد بعد التمديد: ${fmt(request.extendedDueAt)}.`);
    parts.push(request.reminderSentAt ? `أُرسل التذكير في ${fmt(request.reminderSentAt)}.` : "لم يُرسل تذكير.");
    if (request.complaintWindowEndsAt) parts.push(`تنتهي مهلة تقديم الشكوى إلى سدايا في ${fmt(request.complaintWindowEndsAt)}.`);
  }

  return {
    regulator: { name: reg.name[lang], url: reg.url },
    complaintText: letter.body.trim(),
    deadlineInfo: parts.join(" "),
    evidenceSummary: evidenceList,
  };
}
