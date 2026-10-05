import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { loadScanStatus } from "@/lib/companies/scan-status";
import { ScanLive } from "./scan-live";

export const dynamic = "force-dynamic";

export default async function ScanPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  await requireOwner(locale);
  const t = await getTranslations("scan");
  const status = await loadScanStatus();
  const sp = await searchParams;
  const outcome = typeof sp.range === "string" ? sp.range : "";
  const restarted = outcome === "restarted" ? status.accounts.find((a) => a.id === sp.account) : undefined;
  return (
    <main className="max-w-prose">
      <h1 className="text-2xl font-semibold">{status.running ? t("title") : t("titleDone")}</h1>
      <p className="mt-2 text-muted">{t("leave")}</p>
      {restarted && (
        <p role="status" className="mt-4 rounded-md bg-info-bg p-3 text-sm text-info">
          {t("range.restarted", { mailbox: restarted.address, range: t(`range.opt.${restarted.range ?? "3y"}`) })}
        </p>
      )}
      {outcome && outcome !== "restarted" && (
        <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("range.error")}</p>
      )}
      <ScanLive initial={status} locale={locale} />
    </main>
  );
}
