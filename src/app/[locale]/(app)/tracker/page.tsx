import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { trackerRows } from "@/lib/track/actions";
import { BUCKETS, bucketOf, parseTrackerFilters, type TrackerFilters } from "@/lib/tracker-view/view";
import { toPlain } from "@/lib/tracker-view/plain";
import { formatDate, formatNumber } from "@/lib/format";
import { StatusPill } from "@/components/status-pill";
import { DeadlineCountdown } from "@/components/deadline-countdown";
import { NextActionView } from "./next-action";

export const dynamic = "force-dynamic";

const CLOSED = ["COMPLETED", "REFUSED", "CANCELLED", "FAILED"];
const DEADLINE_STATUSES = ["SENT", "ACKNOWLEDGED", "NEEDS_ACTION", "OVERDUE"];

function href(locale: string, f: TrackerFilters, patch: Partial<TrackerFilters>) {
  const next = { ...f, ...patch };
  const qs = new URLSearchParams();
  if (next.tab !== "all") qs.set("tab", next.tab);
  if (next.q) qs.set("q", next.q);
  if (next.sort !== "deadline") qs.set("sort", next.sort);
  const s = qs.toString();
  return `/${locale}/tracker${s ? `?${s}` : ""}`;
}

export default async function TrackerPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  await requireOwner(locale);
  const t = await getTranslations("tracker");
  const filters = parseTrackerFilters(await searchParams);
  const [all, accounts] = await Promise.all([
    trackerRows(),
    db.mailAccount.findMany({ select: { id: true, provider: true } }),
  ]);
  const provider = new Map(accounts.map((a) => [a.id, a.provider]));
  const now = Date.now();
  const n = (v: number) => formatNumber(locale, v);
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, all.filter((r) => bucketOf(r.group) === b).length]));
  const q = filters.q.toLowerCase();
  let rows = all.filter((r) => (filters.tab === "all" || bucketOf(r.group) === filters.tab) && (!q || `${r.companyName} ${r.companyDomain} ${r.reference}`.toLowerCase().includes(q)));
  if (filters.sort === "company") rows = [...rows].sort((a, b) => a.companyName.localeCompare(b.companyName, locale));
  if (filters.sort === "recent") rows = [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const allClosed = all.length > 0 && all.every((r) => CLOSED.includes(r.status));

  return (
    <main>
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("lead")}</p>

      {all.length === 0 ? (
        <p className="mt-8 rounded-lg border border-border bg-surface p-6">{t("empty")}</p>
      ) : (
        <>
          {allClosed && (
            <p role="status" className="mt-4 rounded-md bg-success-bg p-3 text-sm text-success">
              {t("allClosed", { count: n(all.length), completed: n(all.filter((r) => r.status === "COMPLETED").length) })}
            </p>
          )}
          <nav aria-label={t("tabs.label")} className="mt-6">
            <ul className="flex flex-wrap gap-2">
              {(["all", ...BUCKETS] as const).map((b) => (
                <li key={b}>
                  <Link
                    href={href(locale, filters, { tab: b })}
                    aria-current={filters.tab === b ? "true" : undefined}
                    className={`inline-flex min-h-tap items-center gap-1 rounded-full border px-4 text-sm font-medium ${filters.tab === b ? "border-primary bg-primary text-primary-fg" : "border-border-strong bg-surface"}`}
                  >
                    {filters.tab === b && <span aria-hidden="true">✓</span>}
                    {t(`tabs.${b}`)} <span>{n(b === "all" ? all.length : counts[b])}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <form method="get" action={`/${locale}/tracker`} className="mt-4 flex flex-wrap items-end gap-3">
            {filters.tab !== "all" && <input type="hidden" name="tab" value={filters.tab} />}
            <div className="flex flex-col">
              <label htmlFor="tq" className="text-sm font-medium">{t("search")}</label>
              <input id="tq" name="q" type="search" dir="auto" defaultValue={filters.q} className="mt-1 min-h-tap rounded-md border border-border-strong bg-surface px-3" />
            </div>
            <div className="flex flex-col">
              <label htmlFor="ts" className="text-sm font-medium">{t("sort")}</label>
              <select id="ts" name="sort" defaultValue={filters.sort} className="mt-1 min-h-tap rounded-md border border-border-strong bg-surface px-2">
                {(["deadline", "company", "recent"] as const).map((s) => (
                  <option key={s} value={s}>{t(`sortOpt.${s}`)}</option>
                ))}
              </select>
            </div>
            <button type="submit" className="min-h-tap rounded-md border border-border-strong px-4 text-sm font-medium">{t("apply")}</button>
          </form>

          {rows.length === 0 ? (
            <p className="mt-6 rounded-lg border border-border bg-surface p-6">{t("emptyFilter")}</p>
          ) : (
            <ul className="mt-6 flex flex-col gap-2">
              {rows.map((r) => {
                const tracked = DEADLINE_STATUSES.includes(r.status) && r.dueAt;
                return (
                  <li key={r.requestId} data-request={r.reference} className="rounded-lg border border-border bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h2 className="text-lg font-semibold">
                        <Link href={`/${locale}/tracker/${r.requestId}`} className="underline-offset-4 hover:underline">
                          <bdi>{r.companyName}</bdi>
                        </Link>
                      </h2>
                      <StatusPill status={r.status} label={t(`status.${r.status}`)} />
                      <span className="text-sm text-muted">{t(`type.${r.type}`)}</span>
                      {r.extensionClaimed && <span className="rounded-sm border border-border-strong px-1.5 text-xs">{t("flags.extension")}</span>}
                      {r.stillEmailing && <span className="rounded-sm border border-warning px-1.5 text-xs text-warning">{t("flags.stillEmailing")}</span>}
                      {r.bounced && <span className="rounded-sm border border-danger px-1.5 text-xs text-danger">{t("flags.bounced")}</span>}
                    </div>
                    <p className="mt-1 flex flex-wrap items-start gap-x-4 gap-y-1 text-sm text-muted">
                      {r.clockStart && <span data-volatile>{t("sent", { date: formatDate(locale, r.clockStart) })}</span>}
                      {r.lastReplyAt && <span data-volatile>{t("lastReply", { date: formatDate(locale, r.lastReplyAt) })}</span>}
                      {tracked && (
                        <DeadlineCountdown
                          dueAt={r.dueAt!.toISOString()}
                          clockStart={r.clockStart?.toISOString()}
                          now={now}
                          locale={locale}
                          businessDays={r.lawKeys.length === 1 && r.lawKeys[0] === "CAN_SPAM"}
                        />
                      )}
                    </p>
                    {r.status === "NEEDS_ACTION" && r.needsActionReason && (
                      <p className="mt-1 text-sm text-warning">
                        {t.has(`reasons.${r.needsActionReason}`) ? t(`reasons.${r.needsActionReason}`, { mailbox: r.mailbox ?? "" }) : t("reasons.OTHER")}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{t("next")}</span>
                      <NextActionView
                        action={toPlain(r.nextAction)}
                        locale={locale}
                        ctx={{
                          requestId: r.requestId,
                          companyName: r.companyName,
                          mailbox: r.mailbox,
                          provider: provider.get(r.nextAction.accountId ?? "") ?? null,
                          regulator: t("sdaia"),
                          closed: CLOSED.includes(r.status),
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
