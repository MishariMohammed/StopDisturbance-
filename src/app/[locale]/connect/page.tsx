import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import type { ScanProgress } from "@/lib/mail/gmail-sync";

export const dynamic = "force-dynamic";

export default async function ConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  await requireOwner(locale);
  const t = await getTranslations("connect");
  const accounts = await db.mailAccount.findMany({ orderBy: { createdAt: "asc" } });

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm opacity-80">{t("lead")}</p>

      {sp.error && <p role="alert" className="mt-4 rounded-md border border-red-400 p-3 text-sm">{t("error", { reason: sp.error })}</p>}
      {sp.partial && <p role="status" className="mt-4 rounded-md border p-3 text-sm">{t("partial")}</p>}

      <ul className="mt-8 flex flex-col gap-3">
        {accounts.map((a) => {
          const p = a.scanProgress as ScanProgress | null;
          return (
            <li key={a.id} className="rounded-md border p-4">
              <div className="flex items-center justify-between gap-4">
                <span dir="ltr" className="font-medium">{a.address}</span>
                <span className="text-sm">{a.status === "ACTIVE" ? t("connected") : t("needsReconnect")}</span>
              </div>
              {p && (
                <p className="mt-2 text-sm opacity-80" aria-live="polite">
                  {p.phase === "done" ? t("done", { count: p.fetched }) : t("scanning", { fetched: p.fetched, listed: p.listed })}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <section className="mt-8 rounded-md border p-4" aria-labelledby="unverified">
        <h2 id="unverified" className="font-semibold">{t("unverifiedTitle")}</h2>
        <p className="mt-1 text-sm opacity-80">{t("unverifiedBody")}</p>
      </section>

      <div className="mt-6 flex flex-wrap gap-3">
        <a href={`/api/mail/google/start?locale=${locale}`} className="rounded-md bg-brand px-4 py-3 text-brand-ink">{t("gmail")}</a>
        <span aria-disabled="true" className="rounded-md border px-4 py-3 opacity-50">{t("outlook")}</span>
      </div>
    </main>
  );
}
