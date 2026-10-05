// Western digits by default in both locales (04-ux §11.7); Gregorian calendar for Arabic dates (§11.8).

export function numberFormat(locale: string) {
  return new Intl.NumberFormat(locale === "ar" ? "ar-SA" : "en-GB", { numberingSystem: "latn" });
}

export function formatNumber(locale: string, n: number) {
  return numberFormat(locale).format(n);
}

export function formatDate(locale: string, iso: string | Date | null | undefined, style: "short" | "month" = "short") {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const opts: Intl.DateTimeFormatOptions =
    style === "month" ? { year: "numeric", month: "short" } : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", opts).format(d);
}

/** Optional secondary Hijri (Umm al-Qura) date (04-ux §7.2, §11.8). */
export function formatHijri(locale: string, iso: string | Date | null | undefined) {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(`${locale === "ar" ? "ar-SA" : "en-GB"}-u-ca-islamic-umalqura-nu-latn`, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Riyadh",
  }).format(d);
}

export function formatDateTime(locale: string, iso: string | Date | null | undefined) {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Riyadh",
  }).format(d);
}

/** yyyy-mm-dd of the Riyadh calendar day (for <input type="date"> defaults/max). */
export function riyadhDay(d: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
