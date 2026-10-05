"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CATEGORIES,
  CONFIDENCE_FILTERS,
  DECISION_FILTERS,
  DEFAULT_FILTERS,
  SEEN_FILTERS,
  SORTS,
  filtersToQuery,
  type Category,
  type Filters,
} from "@/lib/companies/filters";
import { formatNumber } from "@/lib/format";

const SEARCH_DEBOUNCE_MS = 200;

/** Filters live in the URL (04-ux §5.2) so back/forward and shared links restore the view. */
export function FilterBar({
  filters,
  counts,
  accounts,
  locale,
}: {
  filters: Filters;
  counts: Record<Category, number>;
  accounts: { id: string; address: string }[];
  locale: string;
}) {
  const t = useTranslations("companies.filters");
  const router = useRouter();
  const pathname = usePathname() ?? `/${locale}/companies`;
  const [q, setQ] = useState(filters.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ids = useId();

  const href = (patch: Partial<Filters>) => {
    const qs = filtersToQuery({ ...filters, ...patch });
    return qs ? `${pathname}?${qs}` : pathname;
  };

  // Back/forward or a chip link changed the query: show it in the box.
  const [shownQ, setShownQ] = useState(filters.q);
  if (shownQ !== filters.q) {
    setShownQ(filters.q);
    setQ(filters.q);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onSearch = (value: string) => {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.replace(href({ q: value.trim() }), { scroll: false }), SEARCH_DEBOUNCE_MS);
  };

  const select = <K extends keyof Filters>(key: K, label: string, options: readonly string[], optionLabel: (v: string) => string) => (
    <div className="flex flex-col">
      <label htmlFor={`${ids}-${key}`} className="text-sm font-medium">{label}</label>
      <select
        id={`${ids}-${key}`}
        value={filters[key]}
        onChange={(e) => router.push(href({ [key]: e.target.value } as Partial<Filters>), { scroll: false })}
        className="mt-1 min-h-tap rounded-md border border-border-strong bg-surface px-2"
      >
        {options.map((o) => (
          <option key={o} value={o}>{optionLabel(o)}</option>
        ))}
      </select>
    </div>
  );

  const active = filtersToQuery({ ...filters, sort: DEFAULT_FILTERS.sort }) !== "";

  return (
    <section aria-label={t("label")} className="mt-6 space-y-4">
      <div className="max-w-xl">
        <label htmlFor={`${ids}-q`} className="text-sm font-medium">{t("search")}</label>
        <input
          id={`${ids}-q`}
          type="search"
          value={q}
          dir="auto"
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="mt-1 min-h-tap w-full rounded-md border border-border-strong bg-surface px-3"
        />
      </div>
      <nav aria-label={t("categories")}>
        <ul className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <li key={c}>
              <Link
                href={href({ cat: c })}
                scroll={false}
                aria-current={filters.cat === c ? "true" : undefined}
                className={`inline-flex min-h-tap items-center gap-1 rounded-full border px-4 text-sm font-medium ${
                  filters.cat === c ? "border-primary bg-primary text-primary-fg" : "border-border-strong bg-surface"
                }`}
              >
                {filters.cat === c && <span aria-hidden="true">✓</span>}
                {t(`cat.${c}`)} <span>{formatNumber(locale, counts[c])}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-wrap items-end gap-3">
        {select("decision", t("decision"), DECISION_FILTERS, (v) => t(`decisionOpt.${v}`))}
        {select("confidence", t("confidence"), CONFIDENCE_FILTERS, (v) => t(`confidenceOpt.${v}`))}
        {select("seen", t("seen"), SEEN_FILTERS, (v) => t(`seenOpt.${v}`))}
        {accounts.length > 1 && (
          <div className="flex flex-col">
            <label htmlFor={`${ids}-mailbox`} className="text-sm font-medium">{t("mailbox")}</label>
            <select
              id={`${ids}-mailbox`}
              value={filters.mailbox}
              onChange={(e) => router.push(href({ mailbox: e.target.value }), { scroll: false })}
              className="mt-1 min-h-tap rounded-md border border-border-strong bg-surface px-2"
            >
              <option value="">{t("allMailboxes")}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.address}</option>
              ))}
            </select>
          </div>
        )}
        {select("sort", t("sort"), SORTS, (v) => t(`sortOpt.${v}`))}
        {active && (
          <Link href={href({ ...DEFAULT_FILTERS, sort: filters.sort })} scroll={false} className="inline-flex min-h-tap items-center px-2 text-sm text-primary underline underline-offset-4">
            {t("clear")}
          </Link>
        )}
      </div>
    </section>
  );
}
