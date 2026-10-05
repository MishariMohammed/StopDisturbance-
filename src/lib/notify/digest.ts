import { db } from "@/lib/db";
import { formatLetterDate } from "@/lib/legal/drafts";
import { ownerLocale, trackerUrl } from "@/lib/notify/alerts";
import { sendToSelf } from "@/lib/notify/self-send";
import { getNotificationSettings } from "@/lib/notify/settings";
import { trackerRows, type TrackerRow } from "@/lib/track/tracker";

// Weekly digest, Sunday 09:00 Asia/Riyadh (04-ux §8.1). Company names only: no subject lines or reply
// content of the owner's mail. Sent from the owner's first connected mailbox to itself.

const WEEK = 7 * 86_400_000;

const T = {
  en: {
    replied: (n: number) => `${n} ${n === 1 ? "company" : "companies"} replied`,
    passed: (n: number) => `${n} ${n === 1 ? "deadline" : "deadlines"} passed`,
    quiet: "Your weekly StopDisturbance update",
    needs: (n: number) => `Needs you (${n})`,
    good: (n: number) => `Good news (${n})`,
    waiting: (n: number) => `Waiting (${n})`,
    nextDeadline: (c: string, d: string) => ` — next deadline: ${c}, ${d}`,
    action: {
      CONFIRM_REPLY: (c: string) => `${c} replied — confirm what they said`,
      REPLY_WITH_DETAILS: (c: string) => `${c} needs your reply`,
      SEND_REMINDER: (c: string, d?: number) => `${c} is ${d ?? 0} days past deadline → Send reminder`,
      ESCALATE: (c: string) => `${c} → File a complaint`,
      FIX_ADDRESS: (c: string) => `${c}: request not sent → Fix address`,
      GRANT_SEND_PERMISSION: (c: string) => `${c}: allow sending from your mailbox`,
      RECONNECT_MAILBOX: (c: string) => `${c}: reconnect your mailbox`,
      SUBMIT_WEB_FORM: (c: string) => `${c}: submit the web form`,
      OTHER: (c: string) => `${c} needs your attention`,
    },
    completed: (c: string) => `${c} confirmed deletion`,
    open: "Open tracker",
    manage: "Manage emails",
  },
  ar: {
    replied: (n: number) => `ردّت ${n} ${n === 1 ? "شركة" : "شركات"}`,
    passed: (n: number) => (n === 1 ? "انتهت مهلة واحدة" : `انتهت ${n} مهل`),
    quiet: "ملخصك الأسبوعي",
    needs: (n: number) => `بانتظارك (${n})`,
    good: (n: number) => `أخبار جيدة (${n})`,
    waiting: (n: number) => `قيد الانتظار (${n})`,
    nextDeadline: (c: string, d: string) => ` — أقرب موعد: ${c}، ${d}`,
    action: {
      CONFIRM_REPLY: (c: string) => `ردّت ${c} — أكّد مضمون الرد`,
      REPLY_WITH_DETAILS: (c: string) => `${c} بانتظار ردك`,
      SEND_REMINDER: (c: string, d?: number) => `تجاوزت ${c} المهلة بـ ${d ?? 0} يوم ← أرسل تذكيرًا`,
      ESCALATE: (c: string) => `${c} ← قدّم شكوى`,
      FIX_ADDRESS: (c: string) => `${c}: لم يُرسل الطلب ← صحّح العنوان`,
      GRANT_SEND_PERMISSION: (c: string) => `${c}: اسمح بالإرسال من بريدك`,
      RECONNECT_MAILBOX: (c: string) => `${c}: أعد ربط بريدك`,
      SUBMIT_WEB_FORM: (c: string) => `${c}: أرسل النموذج الإلكتروني`,
      OTHER: (c: string) => `${c} بحاجة إلى انتباهك`,
    },
    completed: (c: string) => `أكدت ${c} حذف بياناتك`,
    open: "افتح المتابعة",
    manage: "إدارة الرسائل",
  },
} as const;

type ActionKey = keyof (typeof T)["en"]["action"];

export async function buildDigest(now = new Date(), lang?: "en" | "ar"): Promise<{ subject: string; text: string; lang: "en" | "ar" } | null> {
  const l = lang ?? (await ownerLocale());
  const t = T[l];
  const rows = await trackerRows(undefined, now);
  if (!rows.length) return null;
  const since = new Date(now.getTime() - WEEK);
  const repliedCompanies = new Set(
    (await db.inboundReply.findMany({ where: { receivedAt: { gte: since }, NOT: { suggestedClass: "BOUNCE" } }, select: { requestId: true } }))
      .map((r) => rows.find((x) => x.requestId === r.requestId)?.companyId)
      .filter(Boolean),
  );
  const overdue = rows.filter((r) => r.status === "OVERDUE");
  const needs = rows.filter((r) => r.group === "NEEDS_YOU" || r.group === "OVERDUE");
  const good = rows.filter((r) => r.status === "COMPLETED" && r.closedAt && r.closedAt >= since);
  const waiting = rows.filter((r) => r.group === "WAITING");
  const next = waiting.filter((r) => r.dueAt).sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime())[0];

  const subjectParts: string[] = [];
  if (repliedCompanies.size) subjectParts.push(t.replied(repliedCompanies.size));
  if (overdue.length) subjectParts.push(t.passed(overdue.length));
  const subject = subjectParts.join(" · ") || t.quiet;

  const line = (r: TrackerRow) => {
    const k = (r.nextAction.kind in t.action ? r.nextAction.kind : "OTHER") as ActionKey;
    const over = r.daysLeft !== null && r.daysLeft < 0 ? -r.daysLeft : 0;
    return `  ${t.action[k](r.companyName, over)}`;
  };
  const lines: string[] = [];
  if (needs.length) lines.push(t.needs(needs.length), ...needs.map(line), "");
  if (good.length) lines.push(t.good(good.length), ...good.map((r) => `  ${t.completed(r.companyName)}`), "");
  lines.push(t.waiting(waiting.length) + (next ? t.nextDeadline(next.companyName, formatLetterDate(next.dueAt!, l)) : ""), "");
  const url = trackerUrl(l);
  lines.push(`${t.open}: ${url}`, `${t.manage}: ${url.replace(/\/tracker$/, "/settings")}`);
  return { subject, text: lines.join("\n") + "\n", lang: l };
}

export async function sendWeeklyDigest(now = new Date()): Promise<boolean> {
  if (!(await getNotificationSettings()).digest) return false;
  const d = await buildDigest(now);
  if (!d) return false;
  return sendToSelf(d, now);
}
