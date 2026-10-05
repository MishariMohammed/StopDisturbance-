import espDomainsJson from "../../../data/esp-domains.json";
import fingerprintsJson from "../../../data/esp-fingerprints.json";
import freemailJson from "../../../data/freemail-domains.json";
import { registrableDomain } from "@/lib/mail/headers";

// Per-message header signals (02-capabilities §3). Pure: no DB, no network.

export const ESP_DOMAINS: ReadonlySet<string> = new Set(espDomainsJson.domains);
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set(freemailJson.domains);

export type EspKind = "marketing" | "transactional" | "mixed";
export type EspMatch = { name: string; kind: EspKind };

type Fingerprint = { esp: string; kind: EspKind; domains: Set<string>; feedbackId?: RegExp; listId?: RegExp };

const FINGERPRINTS: Fingerprint[] = fingerprintsJson.fingerprints.map((f) => ({
  esp: f.esp,
  kind: f.kind as EspKind,
  domains: new Set(f.domains),
  feedbackId: "feedbackId" in f && f.feedbackId ? new RegExp(f.feedbackId, "i") : undefined,
  listId: "listId" in f && f.listId ? new RegExp(f.listId, "i") : undefined,
}));

/** The header fields resolve/classify look at (a MessageHeader row, with the List-Unsubscribe host decrypted). */
export type HeaderSignals = {
  fromAddress: string;
  fromName: string | null;
  fromDomain: string;
  replyToDomain: string | null;
  returnPathDomain: string | null;
  dkimDomains: string[];
  dkimPass: boolean;
  hasListUnsub: boolean;
  listUnsubHttpsHost: string | null;
  listUnsubMailto: string | null;
  oneClick: boolean;
  listId: string | null;
  feedbackId: string | null;
  precedence: string | null;
  autoSubmitted: string | null;
  labels: string[];
  subject: string | null;
};

export function isEspDomain(domain: string | null | undefined): boolean {
  return Boolean(domain && ESP_DOMAINS.has(domain));
}

export function isFreemailDomain(domain: string | null | undefined): boolean {
  return Boolean(domain && FREEMAIL_DOMAINS.has(domain));
}

/** A domain that may become a company: not an ESP, not a consumer mailbox provider. */
export function isBrandable(domain: string | null | undefined): domain is string {
  return Boolean(domain && domain.includes(".") && !isEspDomain(domain) && !isFreemailDomain(domain));
}

export function mailtoDomain(mailto: string | null): string | null {
  const m = mailto?.match(/^mailto:[^@?]+@([^?>\s]+)/i);
  return m ? registrableDomain(m[1]) : null;
}

export function urlHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** List-Id: `Name <list.host>` or a bare id → registrable domain of the id. */
export function listIdDomain(listId: string | null): string | null {
  if (!listId) return null;
  const id = (listId.match(/<([^>]+)>/)?.[1] ?? listId).trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(id)) return null;
  return registrableDomain(id);
}

export function dkimRegistrable(h: Pick<HeaderSignals, "dkimDomains">): string[] {
  return [...new Set(h.dkimDomains.map((d) => registrableDomain(d)))];
}

export function listUnsubDomains(h: Pick<HeaderSignals, "listUnsubHttpsHost" | "listUnsubMailto">): string[] {
  const out: string[] = [];
  if (h.listUnsubHttpsHost) out.push(registrableDomain(h.listUnsubHttpsHost));
  const m = mailtoDomain(h.listUnsubMailto);
  if (m) out.push(m);
  return [...new Set(out)];
}

/** ESP fingerprint from the allow-listed headers only. */
export function detectEsp(h: HeaderSignals): EspMatch | null {
  const infra = new Set<string>(
    [
      h.fromDomain,
      h.returnPathDomain,
      ...dkimRegistrable(h),
      ...listUnsubDomains(h),
      listIdDomain(h.listId),
    ].filter((d): d is string => Boolean(d)),
  );
  for (const f of FINGERPRINTS) {
    if ([...infra].some((d) => f.domains.has(d))) return { name: f.esp, kind: f.kind };
    if (f.feedbackId && h.feedbackId && f.feedbackId.test(h.feedbackId)) return { name: f.esp, kind: f.kind };
    if (f.listId && h.listId && f.listId.test(h.listId)) return { name: f.esp, kind: f.kind };
  }
  const generic = [...infra].find((d) => ESP_DOMAINS.has(d));
  return generic ? { name: generic, kind: "mixed" } : null;
}

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);

/** Any list/bulk/ESP signal: such mail is never from a personal correspondent. */
export function hasBulkSignals(h: HeaderSignals, esp: EspMatch | null): boolean {
  return Boolean(
    h.hasListUnsub || h.oneClick || h.listId || h.feedbackId || esp || (h.precedence && BULK_PRECEDENCE.has(h.precedence)),
  );
}

// Transactional / account subjects (EN + AR). Matched case-insensitively anywhere in the subject.
const TXN_SUBJECT = new RegExp(
  [
    "receipt", "invoice", "\\border\\b", "your order", "order #", "order confirm", "purchase", "payment", "paid",
    "shipped", "shipping", "shipment", "dispatched", "delivered", "delivery", "out for delivery", "tracking",
    "booking", "reservation", "itinerary", "e-?ticket", "boarding pass", "check-?in", "refund", "return request",
    "your account", "account update", "welcome to", "verify", "verification", "confirm your", "password",
    "security alert", "sign-?in", "log-?in", "new device", "two-step", "statement", "\\bbill\\b", "billing",
    "renewal", "renews", "subscription", "membership", "your trip", "your ride", "appointment", "terms of service",
    "privacy policy", "policy update",
    "إيصال", "فاتورة", "فاتورت", "طلبك", "رقم الطلب", "تأكيد الطلب", "تم شحن", "الشحن", "شحنتك", "التوصيل", "توصيل", "تم التوصيل",
    "حجز", "تذكرة", "بطاقة الصعود", "استرداد", "مرتجع", "حسابك", "مرحبا بك", "مرحباً بك", "أهلاً بك", "تحقق", "تأكيد",
    "كلمة المرور", "تنبيه أمني", "تسجيل الدخول", "جهاز جديد", "اشتراكك", "تجديد", "الدفع", "عملية دفع", "رحلتك",
    "عضويتك", "موعدك", "تحديث السياسة",
  ].join("|"),
  "iu",
);

// Promotional subjects override transactional keywords ("Order now and save 50%").
const PROMO_SUBJECT = new RegExp(
  [
    "\\d+ ?% ?off", "% off", "\\bsale\\b", "\\bdeals?\\b", "\\boffers?\\b", "discount", "coupon", "promo", "save up to",
    "free shipping", "black friday", "white friday", "cyber monday", "flash", "limited time", "new arrivals",
    "shop now", "order now", "don't miss", "last chance", "exclusive", "newsletter", "weekly", "digest",
    "خصم", "خصومات", "تخفيض", "تخفيضات", "عرض", "عروض", "كوبون", "كود الخصم", "الجمعة البيضاء", "تسوق الآن",
    "لفترة محدودة", "وصل حديثا", "وصل حديثاً", "النشرة", "لا تفوت",
  ].join("|"),
  "iu",
);

export function isTransactionalSubject(subject: string | null): boolean {
  return Boolean(subject && TXN_SUBJECT.test(subject) && !PROMO_SUBJECT.test(subject));
}

export function isPromoSubject(subject: string | null): boolean {
  return Boolean(subject && PROMO_SUBJECT.test(subject));
}

export function isAutoSubmitted(h: Pick<HeaderSignals, "autoSubmitted">): boolean {
  return Boolean(h.autoSubmitted && h.autoSubmitted !== "no");
}

/** Gmail SPAM and the Outlook junk folder. */
export function isJunk(h: Pick<HeaderSignals, "labels">): boolean {
  return h.labels.includes("SPAM") || h.labels.includes("FOLDER_JUNK");
}

export function hasListHeaders(h: HeaderSignals): boolean {
  return Boolean(h.hasListUnsub || h.oneClick || h.listId);
}

/** Message-level classes (02-capabilities §3.4 rules 2–3). Personal mail is neither. */
export function messageClass(h: HeaderSignals, esp: EspMatch | null): { isMarketing: boolean; isTransactional: boolean } {
  const txnSubject = isTransactionalSubject(h.subject);
  const promotions = h.labels.includes("CATEGORY_PROMOTIONS");
  // Outlook "Other" (not Focused) is a weak promotions signal: only counts when nothing says transactional.
  const outlookOther = h.labels.includes("OTHER");
  const updates = h.labels.includes("CATEGORY_UPDATES");
  const list = hasListHeaders(h);
  const bulkPrecedence = Boolean(h.precedence && BULK_PRECEDENCE.has(h.precedence));

  const isTransactional =
    txnSubject ||
    isAutoSubmitted(h) ||
    (updates && !list && !isPromoSubject(h.subject)) ||
    (esp?.kind === "transactional" && !list);

  const isMarketing =
    promotions ||
    h.oneClick ||
    (!txnSubject &&
      (list || bulkPrecedence || (outlookOther && !isTransactional) || isPromoSubject(h.subject) || (esp?.kind === "marketing") || (Boolean(h.feedbackId) && esp !== null && !isTransactional)));

  return { isMarketing, isTransactional };
}
