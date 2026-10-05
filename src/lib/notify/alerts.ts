import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { formatLetterDate } from "@/lib/legal/drafts";
import { getNotificationSettings, type AlertKind } from "@/lib/notify/settings";
import { sendToSelf } from "@/lib/notify/self-send";

// Instant alerts (04-ux §8.2): plain text in the owner's UI language, company name + reference only —
// never subjects or reply content of the owner's mail (§8.1 minimisation). Failures never break the caller.

export type AlertEvent =
  | "REPLY_RECEIVED"
  | "NEEDS_ACTION"
  | "OVERDUE"
  | "REMINDER_AVAILABLE"
  | "ESCALATION_OPEN"
  | "DEADLINE_SOON"
  | "SEND_FAILED"
  | "BOUNCED"
  | "MAILBOX_DISCONNECTED";

const TOGGLE: Record<AlertEvent, AlertKind> = {
  REPLY_RECEIVED: "replyReceived",
  NEEDS_ACTION: "needsAction",
  OVERDUE: "overdue",
  REMINDER_AVAILABLE: "overdue",
  ESCALATION_OPEN: "overdue",
  DEADLINE_SOON: "deadlineSoon",
  SEND_FAILED: "sendFailed",
  BOUNCED: "sendFailed",
  MAILBOX_DISCONNECTED: "mailboxDisconnected",
};

type Ctx = { company: string; ref: string; date: string; mailbox: string };

const TEXT: Record<AlertEvent, { en: (c: Ctx) => [string, string]; ar: (c: Ctx) => [string, string] }> = {
  REPLY_RECEIVED: {
    en: (c) => [`${c.company} replied`, `${c.company} replied to your request ${c.ref}. Check what they said and confirm the status.`],
    ar: (c) => [`ردّت ${c.company}`, `ردّت ${c.company} على طلبك ${c.ref}. اطّلع على الرد وأكّد الحالة.`],
  },
  NEEDS_ACTION: {
    en: (c) => [`${c.company} needs your reply`, `${c.company} needs something from you for request ${c.ref}. Only share what's needed.`],
    ar: (c) => [`${c.company} بانتظار ردك`, `تحتاج ${c.company} إلى رد منك بخصوص الطلب ${c.ref}. شارك فقط ما يلزم.`],
  },
  OVERDUE: {
    en: (c) => [`${c.company} missed the legal deadline`, `${c.company} did not complete request ${c.ref} by ${c.date}, the legal deadline.`],
    ar: (c) => [`تجاوزت ${c.company} المهلة النظامية`, `لم تنفّذ ${c.company} الطلب ${c.ref} حتى ${c.date}، وهو آخر موعد نظامي.`],
  },
  REMINDER_AVAILABLE: {
    en: (c) => [`You can send ${c.company} a reminder`, `Request ${c.ref} is past its deadline. A reminder to ${c.company} is ready to review.`],
    ar: (c) => [`يمكنك إرسال تذكير إلى ${c.company}`, `تجاوز الطلب ${c.ref} مهلته. يمكنك مراجعة تذكير إلى ${c.company} وإرساله.`],
  },
  ESCALATION_OPEN: {
    en: (c) => [`You can now complain about ${c.company}`, `${c.company} still hasn't completed request ${c.ref}. You can prepare a complaint to the regulator.`],
    ar: (c) => [`يمكنك الآن تقديم شكوى ضد ${c.company}`, `لم تنفّذ ${c.company} الطلب ${c.ref} بعد. يمكنك إعداد شكوى إلى الجهة الرقابية.`],
  },
  DEADLINE_SOON: {
    en: (c) => [`${c.company}: deadline in 3 days`, `${c.company} has not replied to request ${c.ref}. The legal deadline is ${c.date}.`],
    ar: (c) => [`${c.company}: تنتهي المهلة خلال ٣ أيام`, `لم تردّ ${c.company} على الطلب ${c.ref}. آخر موعد نظامي ${c.date}.`],
  },
  SEND_FAILED: {
    en: (c) => [`Not sent: request to ${c.company}`, `Request ${c.ref} to ${c.company} could not be sent. Check the address and try again.`],
    ar: (c) => [`لم يُرسل: طلب إلى ${c.company}`, `تعذّر إرسال الطلب ${c.ref} إلى ${c.company}. تحقق من العنوان وحاول مرة أخرى.`],
  },
  BOUNCED: {
    en: (c) => [`Bounced: request to ${c.company}`, `Request ${c.ref} to ${c.company} bounced. The address may be wrong.`],
    ar: (c) => [`ارتدّ: طلب إلى ${c.company}`, `ارتدّ الطلب ${c.ref} المرسل إلى ${c.company}. قد يكون العنوان غير صحيح.`],
  },
  MAILBOX_DISCONNECTED: {
    en: (c) => [`Reconnect ${c.mailbox}`, `We lost access to ${c.mailbox}. Deadlines still count, but we can't see replies or send until you reconnect.`],
    ar: (c) => [`أعد ربط ${c.mailbox}`, `فقدنا الوصول إلى ${c.mailbox}. ما زالت المهل تُحتسب، لكن لا يمكننا رؤية الردود أو الإرسال حتى تعيد الربط.`],
  },
};

const FOOTER = {
  en: (url: string) => `Open the tracker: ${url}\nNotification settings: ${url.replace(/\/tracker.*$/, "/settings")}`,
  ar: (url: string) => `افتح المتابعة: ${url}\nإعدادات التنبيهات: ${url.replace(/\/tracker.*$/, "/settings")}`,
};

export async function ownerLocale(): Promise<"en" | "ar"> {
  const owner = await db.owner.findFirst({ select: { locale: true } });
  return owner?.locale === "en" ? "en" : "ar";
}

export function trackerUrl(lang: "en" | "ar", requestId?: string): string {
  const base = env().APP_URL.replace(/\/$/, "");
  return `${base}/${lang}/tracker${requestId ? `/${requestId}` : ""}`;
}

/** Builds an alert (exported for tests). */
export function alertMessage(event: AlertEvent, lang: "en" | "ar", ctx: Ctx, url: string) {
  const [subject, line] = TEXT[event][lang](ctx);
  return { subject, text: `${line}\n\n${FOOTER[lang](url)}\n`, lang };
}

export async function sendAlert(
  event: AlertEvent,
  target: { requestId?: string; mailbox?: string; date?: Date | null },
  now = new Date(),
): Promise<boolean> {
  try {
    const settings = await getNotificationSettings();
    if (!settings[TOGGLE[event]]) return false;
    const lang = await ownerLocale();
    let company = "";
    let ref = "";
    let date = target.date ?? null;
    if (target.requestId) {
      const req = await db.request.findUnique({ where: { id: target.requestId } });
      if (req) {
        ref = req.reference;
        date ??= req.dueAt;
        company = (await db.company.findUnique({ where: { id: req.companyId }, select: { name: true } }))?.name ?? "";
      }
    }
    const msg = alertMessage(
      event,
      lang,
      { company, ref, mailbox: target.mailbox ?? "", date: date ? formatLetterDate(date, lang) : "" },
      trackerUrl(lang, target.requestId),
    );
    return await sendToSelf(msg, now);
  } catch (err) {
    logger.warn({ err: (err as Error).message, event }, "alert failed");
    return false;
  }
}
