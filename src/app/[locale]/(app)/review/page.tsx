import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { loadReview } from "@/lib/review/load";
import { formatNumber } from "@/lib/format";
import { ReviewClient } from "./review-client";

export const dynamic = "force-dynamic";

const SKIP_REASONS = ["not_found", "no_decision", "keep", "open_request", "no_mailbox", "no_contact"] as const;

/** `?skipped=no_contact:2,no_mailbox:1` from the companies "Create drafts" action. */
function parseSkipped(raw: string | undefined): { reason: (typeof SKIP_REASONS)[number]; count: number }[] {
  if (!raw) return [];
  return raw.split(",").flatMap((part) => {
    const [reason, n] = part.split(":");
    const count = Number(n);
    const r = SKIP_REASONS.find((x) => x === reason);
    return r && Number.isInteger(count) && count > 0 ? [{ reason: r, count }] : [];
  });
}

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  await requireOwner(locale);
  const t = await getTranslations("review");
  const data = await loadReview();
  const n = (v: number) => formatNumber(locale, v);
  const created = Number(sp.created ?? "");
  const skipped = parseSkipped(sp.skipped);
  const approved = data.items.filter((i) => i.approved).length;
  const view = sp.view === "list" ? "list" : "one";

  return (
    <main>
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("lead")}</p>
      {(Number.isInteger(created) && sp.created) || skipped.length ? (
        <div role="status" className="mt-4 rounded-md bg-info-bg p-3 text-sm text-info">
          {sp.created && <p>{t("created", { count: n(created) })}</p>}
          {skipped.length > 0 && (
            <ul className="mt-1 list-disc ps-5">
              {skipped.map((s) => (
                <li key={s.reason}>{t(`skipped.${s.reason}`, { count: n(s.count) })}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {sp.error === "owner_incomplete" && (
        <p role="alert" className="mt-4 rounded-md bg-danger-bg p-3 text-sm text-danger">
          {t("ownerIncomplete")}{" "}
          <Link href={`/${locale}/connect`} className="font-medium underline underline-offset-4">{t("goConnect")}</Link>
        </p>
      )}
      {data.items.length === 0 ? (
        <p className="mt-8 rounded-lg border border-border bg-surface p-6">
          {t("empty")}{" "}
          <Link href={`/${locale}/companies`} className="font-medium text-primary underline underline-offset-4">{t("goCompanies")}</Link>
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="font-medium">
              {t("counts", { total: n(data.items.length), approved: n(approved), toReview: n(data.items.length - approved) })}
            </p>
            <nav aria-label={t("view.label")}>
              <ul className="flex gap-1">
                {(["one", "list"] as const).map((v) => (
                  <li key={v}>
                    <Link
                      href={`/${locale}/review${v === "list" ? "?view=list" : ""}`}
                      aria-current={view === v ? "page" : undefined}
                      className={`inline-flex min-h-tap items-center rounded-md border px-3 text-sm font-medium ${view === v ? "border-primary bg-primary text-primary-fg" : "border-border-strong"}`}
                    >
                      {view === v && <span aria-hidden="true" className="me-1">✓</span>}
                      {t(`view.${v}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <ReviewClient data={data} view={view} initialId={sp.item ?? null} locale={locale} />
        </>
      )}
    </main>
  );
}
