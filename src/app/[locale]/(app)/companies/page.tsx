import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loadCompanies } from "@/lib/companies/load";
import { applyFilters, categoryCounts, companiesQuery, displayOrder, groupRows, paginate, parseFilters, parsePaging } from "@/lib/companies/filters";
import { toMatchRef } from "@/lib/companies/types";
import { overallPercent, toAccountScan } from "@/lib/companies/scan-status";
import { formatNumber } from "@/lib/format";
import { draftableCompanyIds } from "@/lib/review/load";
import { FilterBar } from "./filter-bar";
import { createDraftsAction } from "./actions";
import { CompanyList } from "./company-list";

export const dynamic = "force-dynamic";

export default async function CompaniesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  await requireOwner(locale);
  const t = await getTranslations("companies");
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const paging = parsePaging(sp);
  const [all, accountRows, draftable] = await Promise.all([
    loadCompanies(),
    db.mailAccount.findMany({
      where: { status: { not: "DISCONNECTED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, address: true, provider: true, status: true, scanProgress: true },
    }),
    draftableCompanyIds(),
  ]);
  const rows = displayOrder(applyFilters(all, filters, { locale }));
  const slice = paginate(rows, paging);
  const sectionTotals = Object.fromEntries(groupRows(rows).map((s) => [s.key, s.rows.length]));
  const pageHref = (page: number) => {
    const qs = companiesQuery(filters, { per: slice.per, page });
    return qs ? `/${locale}/companies?${qs}` : `/${locale}/companies`;
  };
  const counts = categoryCounts(all, filters);
  const scans = accountRows.map((a) => toAccountScan(a));
  const running = scans.some((s) => s.phase !== "done" && s.status === "ACTIVE");
  const percent = overallPercent(scans);
  const accounts = accountRows.map((a) => ({ id: a.id, address: a.address }));

  return (
    <main>
      <h1 className="text-2xl font-semibold">{t("title", { count: formatNumber(locale, all.length) })}</h1>
      <p className="mt-1 text-sm text-muted">{t("lead")}</p>
      {running && (
        <p role="status" className="mt-4 rounded-md bg-info-bg p-3 text-sm text-info">
          {percent === null ? t("stillScanning") : t("stillScanningPct", { percent: formatNumber(locale, percent) })}
        </p>
      )}
      {draftable.length > 0 && (
        <section aria-labelledby="drafts-title" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary bg-surface p-4">
          <div>
            <h2 id="drafts-title" className="font-semibold">{t("drafts.title", { count: formatNumber(locale, draftable.length) })}</h2>
            <p className="text-sm text-muted">{t("drafts.lead")}</p>
          </div>
          <form action={createDraftsAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg">
              {t("drafts.create", { count: formatNumber(locale, draftable.length) })}
            </button>
          </form>
        </section>
      )}
      <FilterBar filters={filters} per={slice.per} counts={counts} accounts={accounts} locale={locale} />
      {all.length === 0 ? (
        <p className="mt-8 rounded-lg border border-border bg-surface p-6">{t("emptyScan")}</p>
      ) : (
        <CompanyList
          key={`${JSON.stringify(filters)}:${slice.per}`}
          sections={groupRows(slice.rows)}
          sectionTotals={sectionTotals}
          matches={rows.map(toMatchRef)}
          pager={{
            page: slice.page,
            pages: slice.pages,
            from: slice.from,
            to: slice.to,
            total: slice.total,
            prev: slice.page > 1 ? pageHref(slice.page - 1) : null,
            next: slice.page < slice.pages ? pageHref(slice.page + 1) : null,
            first: slice.page > 2 ? pageHref(1) : null,
            last: slice.page < slice.pages - 1 ? pageHref(slice.pages) : null,
          }}
          accounts={accounts}
          locale={locale}
        />
      )}
    </main>
  );
}
