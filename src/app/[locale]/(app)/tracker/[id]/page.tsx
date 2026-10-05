import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { trackerDetail, TrackError } from "@/lib/track/actions";
import { toPlain } from "@/lib/tracker-view/plain";
import { DetailClient } from "./detail-client";

export const dynamic = "force-dynamic";

export default async function TrackerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale, id } = await params;
  const sp = await searchParams;
  await requireOwner(locale);
  const t = await getTranslations("tracker");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  let detail;
  try {
    detail = await trackerDetail(id);
  } catch (e) {
    if (e instanceof TrackError && e.code === "not_found") notFound();
    throw e;
  }
  const [request, owner] = await Promise.all([
    db.request.findUnique({ where: { id }, select: { mailAccountId: true } }),
    db.owner.findFirst({ select: { fullName: true, loginEmails: true } }),
  ]);
  const account = request ? await db.mailAccount.findUnique({ where: { id: request.mailAccountId }, select: { provider: true, address: true } }) : null;

  return (
    <main>
      <p>
        <Link href={`/${locale}/tracker`} className="inline-flex min-h-tap items-center gap-1 text-sm font-medium text-primary underline underline-offset-4">
          <span aria-hidden="true" className="inline-block rtl:-scale-x-100">←</span>
          {t("detail.back")}
        </Link>
      </p>
      <DetailClient
        detail={toPlain(detail)}
        locale={locale}
        provider={account?.provider ?? null}
        ownerName={owner?.fullName ?? ""}
        emails={account ? [account.address] : []}
        openWizard={sp.escalate === "1"}
        now={Date.now()}
      />
    </main>
  );
}
