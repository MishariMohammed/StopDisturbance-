import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { loadScanStatus } from "@/lib/companies/scan-status";
import { ScanLive } from "./scan-live";

export const dynamic = "force-dynamic";

export default async function ScanPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requireOwner(locale);
  const t = await getTranslations("scan");
  const status = await loadScanStatus();
  return (
    <main className="max-w-prose">
      <h1 className="text-2xl font-semibold">{status.running ? t("title") : t("titleDone")}</h1>
      <p className="mt-2 text-muted">{t("leave")}</p>
      <ScanLive initial={status} locale={locale} />
    </main>
  );
}
