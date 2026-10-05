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
