import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth/session";
import { GMAIL_SCOPES } from "@/lib/mail/google-oauth";
import { MS_SCOPES } from "@/lib/mail/ms-oauth";
import { toAccountScan } from "@/lib/companies/scan-status";
import { COUNTRIES } from "@/lib/settings/setup";
import { formatNumber } from "@/lib/format";
import { ConnectButtons } from "./connect-buttons";
import { saveSetupAction } from "./actions";

export const dynamic = "force-dynamic";

const SCOPE_ROWS = ["googleProfile", "gmailRead", "gmailSend", "msRead", "msSend", "msOffline"] as const;

export default async function ConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  const session = await requireOwner(locale);
  const t = await getTranslations("connect");
  const tc = await getTranslations("countries");
  const [accounts, owner] = await Promise.all([
    db.mailAccount.findMany({ where: { status: { not: "DISCONNECTED" } }, orderBy: { createdAt: "asc" } }),
    db.owner.findUnique({ where: { id: "owner" } }),
  ]);
  const firstRun = !owner?.setupDoneAt;
  const cancelled = sp.error === "access_denied" || sp.error === "denied";

  return (
    <main className="max-w-prose">
      {firstRun && (
        <section aria-labelledby="setup-title" className="mb-10 rounded-lg border border-border bg-surface p-4 shadow-card sm:p-6">
          <h2 id="setup-title" className="text-xl font-semibold">{t("setup.title")}</h2>
          <p className="mt-1 text-sm text-muted">{t("setup.lead")}</p>
          {sp.setup === "invalid" && (
            <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">{t("setup.invalid")}</p>
          )}
          <form action={saveSetupAction} className="mt-4 space-y-4">
            <input type="hidden" name="currentLocale" value={locale} />
            <fieldset>
              <legend className="font-medium">{t("setup.language")}</legend>
              <div className="mt-1 flex flex-wrap gap-4">
                <label className="inline-flex min-h-tap items-center gap-2">
                  <input type="radio" name="locale" value="ar" defaultChecked={locale === "ar"} className="size-5" />
                  <span lang="ar">العربية</span>
                </label>
                <label className="inline-flex min-h-tap items-center gap-2">
                  <input type="radio" name="locale" value="en" defaultChecked={locale === "en"} className="size-5" />
                  <span lang="en">English</span>
                </label>
              </div>
            </fieldset>
            <div>
              <label htmlFor="fullName" className="block font-medium">{t("setup.name")}</label>
              <p id="fullName-help" className="text-sm text-muted">{t("setup.nameHelp")}</p>
              <input
                id="fullName"
                name="fullName"
                required
                maxLength={120}
                autoComplete="name"
                dir="auto"
                defaultValue={owner?.fullName || session.user.name || ""}
                aria-describedby="fullName-help"
                className="mt-1 min-h-tap w-full rounded-md border border-border-strong bg-surface px-3"
              />
            </div>
            <div>
              <label htmlFor="country" className="block font-medium">{t("setup.country")}</label>
              <select
                id="country"
                name="country"
                defaultValue={owner?.country ?? "SA"}
                className="mt-1 min-h-tap w-full rounded-md border border-border-strong bg-surface px-3"
              >
                {COUNTRIES.map((c) => (
                  <option key={c} value={c}>{tc(c)}</option>
                ))}
              </select>
            </div>
            <fieldset>
              <legend className="font-medium">{t("setup.ai")}</legend>
              <label className="mt-1 flex min-h-tap items-center gap-2">
                <input type="radio" name="aiMode" value="RULES" defaultChecked className="size-5" />
                {t("setup.aiRules")}
              </label>
              <label className="flex min-h-tap items-center gap-2 text-muted">
                <input type="radio" name="aiMode" value="DEEPSEEK" disabled aria-describedby="ai-gate-help" className="size-5" />
                {t("setup.aiDeepseek")}
              </label>
              <p id="ai-gate-help" className="text-sm text-muted">
                {t("setup.aiGate")}{" "}
                <Link href={`/${locale}/settings`} className="text-primary underline underline-offset-4">{t("setup.aiSettings")}</Link>
              </p>
            </fieldset>
            <button type="submit" className="min-h-tap rounded-md bg-primary px-4 py-2 font-medium text-primary-fg">
              {t("setup.save")}
            </button>
          </form>
        </section>
      )}
      {sp.setup === "saved" && <p role="status" className="mb-6 rounded-md bg-success-bg p-3 text-sm text-success">{t("setup.saved")}</p>}

      <h1 className="text-2xl font-semibold">{t("h1")}</h1>
      <p className="mt-2 text-muted">{t("sub")}</p>

      {sp.error && !cancelled && (
        <p role="alert" className="mt-4 rounded-md border border-danger bg-danger-bg p-3 text-sm text-danger">
          {t.has(`errors.${sp.error}`) ? t(`errors.${sp.error}` as "errors.connect_failed") : t("errors.connect_failed")}
        </p>
      )}
      {cancelled && <p role="status" className="mt-4 rounded-md border border-border p-3 text-sm">{t("cancelled")}</p>}
      {sp.partial && <p role="status" className="mt-4 rounded-md bg-warning-bg p-3 text-sm text-warning">{t("partial")}</p>}

      <section aria-labelledby="consent-do" className="mt-8 rounded-lg border border-border bg-surface p-4">
        <h2 id="consent-do" className="font-semibold">{t("consent.doTitle")}</h2>
        <ol className="mt-2 list-decimal space-y-1 ps-6 text-sm">
          <li>{t("consent.do1")}</li>
          <li>{t("consent.do2")}</li>
          <li>{t("consent.do3")}</li>
        </ol>
      </section>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="consent-store" className="rounded-lg border border-border bg-surface p-4">
          <h2 id="consent-store" className="font-semibold">{t("consent.storeTitle")}</h2>
          <p className="mt-2 text-sm">{t("consent.store")}</p>
        </section>
        <section aria-labelledby="consent-never" className="rounded-lg border border-border bg-surface p-4">
          <h2 id="consent-never" className="font-semibold">{t("consent.neverTitle")}</h2>
          <p className="mt-2 text-sm">{t("consent.never")}</p>
        </section>
      </div>

      <details className="mt-4 rounded-lg border border-border bg-surface p-4">
        <summary className="min-h-tap cursor-pointer font-medium">{t("ai.title")}</summary>
        <p className="mt-2 text-sm">{t("ai.body")}</p>
      </details>
      <details className="mt-2 rounded-lg border border-border bg-surface p-4">
        <summary className="min-h-tap cursor-pointer font-medium">{t("scopes.title")}</summary>
        <table className="mt-2 w-full text-sm">
          <caption className="sr-only">{t("scopes.title")}</caption>
          <thead>
            <tr>
              <th scope="col" className="p-2 text-start">{t("scopes.scope")}</th>
              <th scope="col" className="p-2 text-start">{t("scopes.meaning")}</th>
            </tr>
          </thead>
          <tbody>
            {SCOPE_ROWS.map((k) => (
              <tr key={k} className="border-t border-border align-top">
                <th scope="row" className="p-2 text-start font-mono text-xs font-normal"><bdi dir="ltr">{t(`scopes.${k}.name`)}</bdi></th>
                <td className="p-2">{t(`scopes.${k}.text`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <ConnectButtons locale={locale} />

      <section aria-labelledby="connected-title" className="mt-8">
        <h2 id="connected-title" className="text-lg font-semibold">{t("connectedTitle")}</h2>
        {accounts.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t("none")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {accounts.map((a) => {
              const scan = toAccountScan(a);
              const google = a.provider === "GOOGLE";
              const canSend = a.grantedScopes.some((s) => s === GMAIL_SCOPES.send || s.toLowerCase().endsWith(MS_SCOPES.send.toLowerCase()));
              const start = google ? "/api/mail/google/start" : "/api/mail/microsoft/start";
              return (
                <li key={a.id} className="rounded-lg border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium"><bdi dir="ltr">{a.address}</bdi></span>
                    <span className={`text-sm ${a.status === "ACTIVE" ? "text-success" : "text-danger"}`}>
                      {a.status === "ACTIVE" ? `✓ ${t("connected")}` : `! ${t("needsReconnect")}`}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {google ? "Gmail" : "Outlook"} · {t("scopeRead")}
                    {canSend ? ` · ${t("scopeSend")}` : ""}
                  </p>
                  {!canSend && a.status === "ACTIVE" && (
                    <p className="mt-2 text-sm">
                      <span className="rounded-sm bg-warning-bg px-1.5 py-0.5 font-medium text-warning">{t("limited")}</span>{" "}
                      {t("partialRow")}{" "}
                      <a href={`${start}?locale=${locale}&send=1&hint=${encodeURIComponent(a.address)}`} className="text-primary underline underline-offset-4">
                        {t("grantSend")}
                      </a>
                    </p>
                  )}
                  {a.status !== "ACTIVE" && (
                    <a href={`${start}?locale=${locale}&hint=${encodeURIComponent(a.address)}`} className="mt-2 inline-flex min-h-tap items-center text-primary underline underline-offset-4">
                      {t("reconnect")}
                    </a>
                  )}
                  {scan.phase !== "pending" && (
                    <p className="mt-1 text-sm text-muted">
                      {scan.phase === "done"
                        ? t("done", { count: formatNumber(locale, scan.fetched) })
                        : t("scanning", { fetched: formatNumber(locale, scan.fetched), listed: formatNumber(locale, scan.listed) })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="mt-8">
        {accounts.length > 0 ? (
          <Link href={`/${locale}/scan`} className="inline-flex min-h-tap items-center rounded-md bg-primary px-4 py-2 font-medium text-primary-fg">
            {t("continue")}
          </Link>
        ) : (
          <>
            <span aria-disabled="true" aria-describedby="continue-help" className="inline-flex min-h-tap items-center rounded-md border border-border px-4 py-2 text-muted">
              {t("continue")}
            </span>
            <p id="continue-help" className="mt-1 text-sm text-muted">{t("continueHelp")}</p>
          </>
        )}
      </div>
    </main>
  );
}
