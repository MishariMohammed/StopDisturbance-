import { useTranslations } from "next-intl";
import type { LawSummaryKey } from "@/lib/review/plan";

type Summary = { en: string; ar: string; deadline: { en: string; ar: string } };

const LINKS: Record<LawSummaryKey, string> = {
  PDPL: "https://sdaia.gov.sa/en/SDAIA/about/Pages/RegulationsAndPolicies.aspx",
  GDPR: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
  UK_GDPR: "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/",
  CAN_SPAM: "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business",
  UNKNOWN: "https://sdaia.gov.sa/en/SDAIA/about/Pages/RegulationsAndPolicies.aspx",
};

/** LawBadge + 2-sentence plain summary + why + link (04-ux §6.3). */
export function LawExplainer({
  keys,
  summaries,
  why,
  lowConfidence,
  locale,
  headingId,
}: {
  keys: LawSummaryKey[];
  summaries: Record<LawSummaryKey, Summary>;
  why: { en: string; ar: string } | null;
  lowConfidence: boolean;
  locale: string;
  headingId: string;
}) {
  const t = useTranslations("review.law");
  const lang = locale === "ar" ? "ar" : "en";
  return (
    <section aria-labelledby={headingId} className="rounded-md border border-border p-3">
      <h3 id={headingId} className="flex flex-wrap items-center gap-2 font-semibold">
        {t("title")}
        {keys.map((k) => (
          <span key={k} className="rounded-sm border border-primary px-1.5 text-xs font-medium text-primary">
            {t(`name.${k}`)}
          </span>
        ))}
      </h3>
      <details className="mt-1">
        <summary className="min-h-6 cursor-pointer text-sm font-medium text-primary underline underline-offset-4">{t("what")}</summary>
        <ul className="mt-2 space-y-2 text-sm">
          {keys.map((k) => (
            <li key={k}>
              <p>
                <strong>{t(`name.${k}`)}:</strong> {summaries[k][lang]}
              </p>
              <p className="text-muted">
                {t("deadline")} {summaries[k].deadline[lang]}
              </p>
              <a href={LINKS[k]} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-6 items-center text-primary underline underline-offset-4">
                {t("read", { law: t(`name.${k}`) })}
                <span aria-hidden="true" className="ms-1">↗</span>
                <span className="sr-only"> {t("newTab")}</span>
              </a>
            </li>
          ))}
        </ul>
        {why && (
          <p className="mt-2 text-sm">
            <strong>{t("why")}</strong> <span dir="auto">{why[lang]}</span>
          </p>
        )}
        {lowConfidence && <p className="mt-2 text-sm text-muted">{t("lowConfidence")}</p>}
      </details>
    </section>
  );
}
