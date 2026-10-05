import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { dataCounts } from "@/lib/settings/overview";
import { HEADER_RETENTION_DAYS } from "@/lib/jobs/retention";
import { EraseForm } from "./erase-form";

export const dynamic = "force-dynamic";

export default async function SettingsDataPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requireOwner(locale);
  const t = await getTranslations("settingsData");
  const c = await dataCounts();
  const n = (v: number) => formatNumber(locale, v);
  const consequences = [
    t("erase.revokes", { count: c.mailboxes, n: n(c.mailboxes) }),
    t("erase.deletes", { companies: n(c.companies), requests: n(c.requests) }),
    t("erase.stopsTracking", { count: c.openRequests, n: n(c.openRequests) }),
    t("erase.irreversible"),
  ];

  return (
    <main className="max-w-prose">
      <p className="text-sm">
        <Link href={`/${locale}/settings`} className="inline-flex min-h-tap items-center text-primary underline underline-offset-4">
          {t("back")}
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <section id="stored" aria-labelledby="stored-title" className="mt-6 rounded-lg border border-border bg-surface p-4 sm:p-6">
        <h2 id="stored-title" className="text-xl font-semibold">{t("stored.title")}</h2>
        <p className="mt-1 text-sm">
          {t("stored.counts", { companies: n(c.companies), requests: n(c.requests), subjects: n(c.subjects) })}
        </p>
        <p className="mt-1 text-sm text-muted">{t("stored.retention", { days: n(HEADER_RETENTION_DAYS) })}</p>
      </section>

      <section id="export" aria-labelledby="export-title" className="mt-8 rounded-lg border border-border bg-surface p-4 sm:p-6">
        <h2 id="export-title" className="text-xl font-semibold">{t("export.title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("export.help")}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <a href="/api/data/export" download className="inline-flex min-h-tap items-center rounded-md bg-primary px-4 py-2 font-medium text-primary-fg">
            {t("export.button")}
          </a>
          <a href="/api/data/export?replies=1" download className="inline-flex min-h-tap items-center rounded-md border border-border-strong px-4 py-2 font-medium">
            {t("export.withReplies")}
          </a>
        </div>
      </section>

      <section id="erase" aria-labelledby="erase-title" className="mt-8 rounded-lg border border-danger bg-surface p-4 sm:p-6">
        <h2 id="erase-title" className="text-xl font-semibold text-danger">{t("erase.title")}</h2>
        <p className="mt-1 text-sm">{t("erase.body")}</p>
        <EraseForm locale={locale} consequences={consequences} />
      </section>
    </main>
  );
}
