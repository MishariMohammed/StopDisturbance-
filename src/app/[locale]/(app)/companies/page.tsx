import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loadCompanies } from "@/lib/companies/load";
import { applyFilters, categoryCounts, groupRows, parseFilters } from "@/lib/companies/filters";
import { overallPercent, toAccountScan } from "@/lib/companies/scan-status";
import { formatNumber } from "@/lib/format";
import { FilterBar } from "./filter-bar";
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
  const filters = parseFilters(await searchParams);
  const [all, accountRows] = await Promise.all([
    loadCompanies(),
    db.mailAccount.findMany({
      where: { status: { not: "DISCONNECTED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, address: true, provider: true, status: true, scanProgress: true },
    }),
  ]);
  const rows = applyFilters(all, filters, { locale });
  const counts = categoryCounts(all, filters);
  const scans = accountRows.map(toAccountScan);
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
      <FilterBar filters={filters} counts={counts} accounts={accounts} locale={locale} />
      {all.length === 0 ? (
        <p className="mt-8 rounded-lg border border-border bg-surface p-6">{t("emptyScan")}</p>
      ) : (
        <CompanyList
          key={JSON.stringify(filters)}
          sections={groupRows(rows)}
          matching={rows.length}
          accounts={accounts}
          locale={locale}
        />
      )}
    </main>
  );
}
