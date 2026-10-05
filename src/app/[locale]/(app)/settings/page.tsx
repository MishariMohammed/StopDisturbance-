import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { getAiMode, getOptOutConfirmedAt } from "@/lib/llm/gate";
import { formatDate, formatNumber } from "@/lib/format";
import { db } from "@/lib/db";
import { ARABIC_REVIEWED_KEY } from "@/lib/legal/drafts";
import { hasSendScope } from "@/lib/send/mailbox";
import { connectionTestPassed, getConnectionTest, getReplyAiEnabled } from "@/lib/settings/ai";
import { ALERT_KINDS, getNotificationSettings } from "@/lib/notify/settings";
import { getRetentionYears, RETENTION_YEARS_OPTIONS } from "@/lib/jobs/retention";
import { MICROSOFT_CONSENT_URL } from "@/lib/privacy/erase";
import { recentAiCalls } from "@/lib/settings/overview";
import {
  disconnectMailboxAction,
  saveAiModeAction,
  saveArabicReviewAction,
  saveNotificationsAction,
  saveReplyAiAction,
  saveRetentionAction,
  testConnectionAction,
} from "./actions";

export const dynamic = "force-dynamic";

const OUTCOMES = ["saved_rules", "saved_deepseek", "opt_out_required", "bad_date", "connection_test_required"] as const;
const ARABIC_OUTCOMES = ["saved_on", "saved_off", "confirm_required"] as const;
const TEST_OUTCOMES = ["ok", "failed", "no_key"] as const;
const REPLY_AI_OUTCOMES = ["saved_on", "saved_off", "ack_required"] as const;
const MAILBOX_OUTCOMES = ["disconnected", "disconnected_ms", "confirm_required", "not_found"] as const;
const BAD = new Set(["opt_out_required", "bad_date", "connection_test_required", "confirm_required", "failed", "no_key", "ack_required", "not_found", "invalid"]);

const card = "mt-8 rounded-lg border border-border bg-surface p-4 sm:p-6";
const button = "min-h-tap rounded-md bg-primary px-4 py-2 font-medium text-primary-fg";
const secondary = "inline-flex min-h-tap items-center rounded-md border border-border-strong px-4 py-2 font-medium";

function Notice({ text, bad }: { text: string; bad: boolean }) {
  return bad ? (
    <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">{text}</p>
  ) : (
    <p role="status" className="mt-3 rounded-md bg-success-bg p-3 text-sm text-success">{text}</p>
  );
}

function pick<T extends string>(list: readonly T[], v: string | undefined): T | undefined {
  return list.find((o) => o === v);
}

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  await requireOwner(locale);
  const t = await getTranslations("settings");
  const reveal = sp.reveal === "1";
  const [mode, optOut, arabicSetting, accounts, test, testPassed, replyAi, notifications, retentionYears, calls] = await Promise.all([
    getAiMode(),
    getOptOutConfirmedAt(),
    db.setting.findUnique({ where: { key: ARABIC_REVIEWED_KEY } }),
    db.mailAccount.findMany({ orderBy: { createdAt: "asc" } }),
    getConnectionTest(),
    connectionTestPassed(),
    getReplyAiEnabled(),
    getNotificationSettings(),
    getRetentionYears(),
    recentAiCalls(reveal),
  ]);
  const arabicReviewed = arabicSetting?.value === true;
  const e = env();
  const key = e.DEEPSEEK_API_KEY;
  const outcome = pick(OUTCOMES, sp.ai);
  const arabicOutcome = pick(ARABIC_OUTCOMES, sp.arabic);
  const testOutcome = pick(TEST_OUTCOMES, sp.test);
  const replyAiOutcome = pick(REPLY_AI_OUTCOMES, sp.replyAi);
  const mailboxOutcome = pick(MAILBOX_OUTCOMES, sp.mailbox);
  const retentionOutcome = pick(["saved", "invalid"] as const, sp.retention);
  const today = new Date().toISOString().slice(0, 10);
  const deepseekLocked = mode !== "DEEPSEEK" && !testPassed;
  const testingMode = e.GOOGLE_PUBLISHING_MODE === "testing";

  return (
    <main className="max-w-prose">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("lead")}</p>
      <nav aria-label={t("sectionsLabel")} className="mt-3 text-sm">
        <Link href={`/${locale}/settings/data`} className="inline-flex min-h-tap items-center text-primary underline underline-offset-4">
          {t("dataLink")}
        </Link>
      </nav>

      {/* Mailboxes */}
      <section id="mailboxes" aria-labelledby="mailboxes-title" className={card}>
        <h2 id="mailboxes-title" className="text-xl font-semibold">{t("mailboxes.title")}</h2>
        {mailboxOutcome && (
          <Notice text={t(`mailboxes.outcome.${mailboxOutcome}`)} bad={BAD.has(mailboxOutcome)} />
        )}
        {mailboxOutcome === "disconnected_ms" && (
          <p className="mt-2 text-sm">
            <a href={MICROSOFT_CONSENT_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">
              {t("mailboxes.msConsent")}
            </a>
          </p>
        )}
        {accounts.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t("mailboxes.none")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {accounts.map((a) => {
              const google = a.provider === "GOOGLE";
              const canSend = hasSendScope(a);
              const start = google ? "/api/mail/google/start" : "/api/mail/microsoft/start";
              const reconnectHref = `${start}?locale=${locale}${canSend ? "&send=1" : ""}&hint=${encodeURIComponent(a.address)}`;
              const status = a.status === "ACTIVE" ? "active" : a.status === "DISCONNECTED" ? "disconnected" : "needsReconnect";
              return (
                <li key={a.id} data-mailbox={a.address} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium"><bdi dir="ltr">{a.address}</bdi></span>
                    <span className={`text-sm ${status === "active" ? "text-success" : status === "disconnected" ? "text-muted" : "text-danger"}`}>
                      {status === "active" ? "✓ " : "! "}
                      {t(`mailboxes.status.${status}`)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {google ? "Gmail" : "Outlook"} · {t("mailboxes.read")} · {canSend ? t("mailboxes.send") : t("mailboxes.noSend")}
                  </p>
                  {status === "active" && (
                    <p className="mt-1 text-sm">
                      {google ? t("mailboxes.gmailToken") : t("mailboxes.token")}{" "}
                      {a.lastRefreshAt
                        ? t("mailboxes.lastRefreshed", { date: formatDate(locale, a.lastRefreshAt) })
                        : t("mailboxes.notRefreshed")}
                    </p>
                  )}
                  {google && testingMode && status === "active" && (
                    <p className="mt-1 text-sm text-warning">{t("mailboxes.testingMode")}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-start gap-3">
                    <a href={reconnectHref} className={secondary}>
                      {t("mailboxes.reconnect")}
                      <span className="sr-only"> <bdi dir="ltr">{a.address}</bdi></span>
                    </a>
                    {status !== "disconnected" && (
                      <details className="min-w-0">
                        <summary className="inline-flex min-h-tap cursor-pointer items-center rounded-md border border-danger px-4 py-2 font-medium text-danger">
                          {t("mailboxes.disconnect")}
                          <span className="sr-only"> <bdi dir="ltr">{a.address}</bdi></span>
                        </summary>
                        <form action={disconnectMailboxAction} className="mt-2 space-y-2 rounded-md border border-border p-3">
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="accountId" value={a.id} />
                          <p className="text-sm">{t("mailboxes.disconnectBody")}</p>
                          <label className="flex min-h-tap items-start gap-2 text-sm">
                            <input type="checkbox" name="confirm" required className="mt-1 size-5 shrink-0" />
                            <span>{t("mailboxes.disconnectConfirm")}</span>
                          </label>
                          <button type="submit" className="min-h-tap rounded-md bg-danger px-4 py-2 font-medium text-primary-fg">
                            {t("mailboxes.disconnectButton")}
                          </button>
                        </form>
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3">
          <Link href={`/${locale}/connect`} className="inline-flex min-h-tap items-center text-primary underline underline-offset-4">
            {t("mailboxes.connectAnother")}
          </Link>
        </p>
      </section>

      {/* AI assist */}
      <section id="ai" aria-labelledby="ai-title" className={card}>
        <h2 id="ai-title" className="text-xl font-semibold">{t("ai.title")}</h2>
        <p className="mt-1 text-sm">
          {t("ai.current")} <strong>{mode === "DEEPSEEK" ? t("ai.deepseek") : t("ai.rules")}</strong>
        </p>
        {outcome && <Notice text={t(`ai.outcome.${outcome}`)} bad={BAD.has(outcome)} />}
        {testOutcome && <Notice text={t(`ai.test.${testOutcome}`)} bad={BAD.has(testOutcome)} />}

        <div className="mt-4 rounded-md border border-border p-3">
          <p className="text-sm">
            {t("ai.key")}{" "}
            {key ? (
              <bdi dir="ltr" className="font-mono">{`${key.slice(0, 3)}…${key.slice(-4)}`}</bdi>
            ) : (
              <span className="text-warning">{t("ai.noKey")}</span>
            )}{" "}
            · {t("ai.model")} <bdi dir="ltr" className="font-mono">{e.LLM_MODEL}</bdi>
          </p>
          <p className="mt-1 text-sm" id="test-state">
            {test
              ? testPassed
                ? `✓ ${t("ai.test.passedOn", { date: formatDate(locale, test.at) })}`
                : `! ${t("ai.test.notPassed")}`
              : t("ai.test.never")}
          </p>
          <form action={testConnectionAction} className="mt-2">
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className={secondary}>{t("ai.test.button")}</button>
          </form>
          <p className="mt-1 text-xs text-muted">{t("ai.test.help")}</p>
        </div>

        <form action={saveAiModeAction} className="mt-4 space-y-4">
          <input type="hidden" name="locale" value={locale} />
          <fieldset>
            <legend className="font-medium">{t("ai.mode")}</legend>
            <label className="mt-1 flex min-h-tap items-center gap-2">
              <input type="radio" name="aiMode" value="RULES" defaultChecked={mode === "RULES"} className="size-5" />
              {t("ai.rulesLong")}
            </label>
            <label className="flex min-h-tap items-center gap-2">
              <input
                type="radio"
                name="aiMode"
                value="DEEPSEEK"
                defaultChecked={mode === "DEEPSEEK"}
                disabled={deepseekLocked}
                aria-describedby="gate-help test-state"
                className="size-5"
              />
              {t("ai.deepseekLong")}
            </label>
            {deepseekLocked && <p className="text-sm text-muted">{t("ai.lockedHelp")}</p>}
          </fieldset>

          <fieldset className="rounded-md border border-border p-3" aria-describedby="gate-help">
            <legend className="px-1 font-medium">{t("ai.gateTitle")}</legend>
            <p id="gate-help" className="text-sm text-muted">{t("ai.gateHelp")}</p>
            <label className="mt-2 flex min-h-tap items-start gap-2">
              <input type="checkbox" name="optOutConfirmed" defaultChecked={Boolean(optOut)} className="mt-1 size-5 shrink-0" />
              <span>{t("ai.gateCheck")}</span>
            </label>
            <label htmlFor="optOutDate" className="mt-2 block text-sm font-medium">{t("ai.gateDate")}</label>
            <input
              id="optOutDate"
              name="optOutDate"
              type="date"
              max={today}
              dir="ltr"
              defaultValue={optOut ? optOut.toISOString().slice(0, 10) : ""}
              className="mt-1 min-h-tap rounded-md border border-border-strong bg-surface px-3"
            />
            {optOut && <p className="mt-2 text-sm">{t("ai.confirmedOn", { date: formatDate(locale, optOut) })}</p>}
          </fieldset>

          <button type="submit" className={button}>{t("ai.save")}</button>
        </form>

        <details className="mt-6">
          <summary className="min-h-tap cursor-pointer font-medium">{t("ai.disclosureTitle")}</summary>
          <dl className="mt-2 space-y-2 text-sm">
            <dt className="font-semibold">{t("ai.sentTitle")}</dt>
            <dd>{t("ai.sent")}</dd>
            <dt className="font-semibold">{t("ai.neverTitle")}</dt>
            <dd>{t("ai.never")}</dd>
          </dl>
        </details>

        {/* Reply classification by AI: own opt-in, off by default */}
        <div id="reply-ai" className="mt-6 border-t border-border pt-4">
          <h3 className="text-lg font-semibold">{t("replyAi.title")}</h3>
          <p className="mt-1 text-sm">
            {t("replyAi.current")} <strong>{replyAi ? t("replyAi.on") : t("replyAi.off")}</strong>
          </p>
          {replyAiOutcome && <Notice text={t(`replyAi.outcome.${replyAiOutcome}`)} bad={BAD.has(replyAiOutcome)} />}
          <p id="reply-ai-warning" className="mt-3 rounded-md bg-warning-bg p-3 text-sm text-warning">
            <span aria-hidden="true">⚠ </span>
            {t("replyAi.warning")}
          </p>
          <form action={saveReplyAiAction} className="mt-3 space-y-2">
            <input type="hidden" name="locale" value={locale} />
            <label className="flex min-h-tap items-start gap-2">
              <input type="checkbox" name="replyAi" defaultChecked={replyAi} aria-describedby="reply-ai-warning" className="mt-1 size-5 shrink-0" />
              <span>{t("replyAi.check")}</span>
            </label>
            <label className="flex min-h-tap items-start gap-2">
              <input type="checkbox" name="replyAiAck" className="mt-1 size-5 shrink-0" />
              <span>{t("replyAi.ack")}</span>
            </label>
            <button type="submit" className={button}>{t("replyAi.save")}</button>
          </form>
        </div>

        {/* Last 20 AI calls */}
        <div id="ai-log" className="mt-6 border-t border-border pt-4">
          <h3 className="text-lg font-semibold">{t("aiLog.title")}</h3>
          <p className="mt-1 text-sm text-muted">{t("aiLog.help")}</p>
          {calls.length === 0 ? (
            <p className="mt-2 text-sm">{t("aiLog.none")}</p>
          ) : (
            <>
              <p className="mt-2">
                <Link
                  href={reveal ? `/${locale}/settings#ai-log` : `/${locale}/settings?reveal=1#ai-log`}
                  className="inline-flex min-h-tap items-center text-primary underline underline-offset-4"
                >
                  {reveal ? t("aiLog.hide") : t("aiLog.reveal")}
                </Link>
              </p>
              <ol className="mt-2 flex flex-col gap-2 text-sm">
                {calls.map((c) => (
                  <li key={c.id} className="rounded-md border border-border p-2">
                    <p>
                      <span>{formatDate(locale, c.at)}</span> · <span>{t("aiLog.purpose", { purpose: c.purpose })}</span> ·{" "}
                      <span>{t("aiLog.tokens", { count: formatNumber(locale, c.tokens) })}</span> ·{" "}
                      <span>{c.ok ? `✓ ${t("aiLog.ok")}` : `! ${t("aiLog.failed")}`}</span>
                    </p>
                    <p className="mt-1 text-muted">
                      {t("aiLog.fields")} <bdi dir="ltr" className="font-mono">{c.fieldNames.join(", ") || "—"}</bdi>
                    </p>
                    {reveal &&
                      (c.payload ? (
                        <pre dir="ltr" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 text-xs">{c.payload}</pre>
                      ) : (
                        <p className="mt-1 text-muted">{t("aiLog.noSample")}</p>
                      ))}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </section>

      {/* Arabic letters */}
      <section id="arabic" aria-labelledby="arabic-title" className={card}>
        <h2 id="arabic-title" className="text-xl font-semibold">{t("arabic.title")}</h2>
        <p className="mt-1 text-sm">
          {t("arabic.current")} <strong>{arabicReviewed ? t("arabic.on") : t("arabic.off")}</strong>
        </p>
        {arabicOutcome && <Notice text={t(`arabic.outcome.${arabicOutcome}`)} bad={BAD.has(arabicOutcome)} />}
        <p id="arabic-warning" className="mt-3 rounded-md bg-warning-bg p-3 text-sm text-warning">
          <span aria-hidden="true">⚠ </span>
          {t("arabic.warning")}
        </p>
        <form action={saveArabicReviewAction} className="mt-4 space-y-3">
          <input type="hidden" name="locale" value={locale} />
          <label className="flex min-h-tap items-start gap-2">
            <input type="checkbox" name="arabicReviewed" defaultChecked={arabicReviewed} aria-describedby="arabic-warning" className="mt-1 size-5 shrink-0" />
            <span>{t("arabic.check")}</span>
          </label>
          <label className="flex min-h-tap items-start gap-2">
            <input type="checkbox" name="arabicConfirm" className="mt-1 size-5 shrink-0" />
            <span>{t("arabic.confirm")}</span>
          </label>
          <p className="text-sm text-muted">{t("arabic.help")}</p>
          <button type="submit" className={button}>{t("arabic.save")}</button>
        </form>
      </section>

      {/* Notifications */}
      <section id="notifications" aria-labelledby="notifications-title" className={card}>
        <h2 id="notifications-title" className="text-xl font-semibold">{t("notifications.title")}</h2>
        {sp.notifications === "saved" && <Notice text={t("notifications.saved")} bad={false} />}
        <p className="mt-1 text-sm text-muted">{t("notifications.help")}</p>
        <form action={saveNotificationsAction} className="mt-3 space-y-1">
          <input type="hidden" name="locale" value={locale} />
          <label className="flex min-h-tap items-center gap-2">
            <input type="checkbox" name="digest" defaultChecked={notifications.digest} className="size-5 shrink-0" />
            <span>{t("notifications.digest")}</span>
          </label>
          <fieldset className="mt-2">
            <legend className="font-medium">{t("notifications.instant")}</legend>
            {ALERT_KINDS.map((k) => (
              <label key={k} className="flex min-h-tap items-center gap-2">
                <input type="checkbox" name={k} defaultChecked={notifications[k]} className="size-5 shrink-0" />
                <span>{t(`notifications.kinds.${k}`)}</span>
              </label>
            ))}
          </fieldset>
          <button type="submit" className={`${button} mt-2`}>{t("notifications.save")}</button>
        </form>
      </section>

      {/* Retention */}
      <section id="retention" aria-labelledby="retention-title" className={card}>
        <h2 id="retention-title" className="text-xl font-semibold">{t("retention.title")}</h2>
        {retentionOutcome && <Notice text={t(`retention.${retentionOutcome}`)} bad={BAD.has(retentionOutcome)} />}
        <p className="mt-1 text-sm text-muted">{t("retention.help")}</p>
        <form action={saveRetentionAction} className="mt-3 space-y-3">
          <input type="hidden" name="locale" value={locale} />
          <label htmlFor="retentionYears" className="block font-medium">{t("retention.label")}</label>
          <select
            id="retentionYears"
            name="retentionYears"
            defaultValue={String(retentionYears)}
            className="min-h-tap rounded-md border border-border-strong bg-surface px-3"
          >
            {RETENTION_YEARS_OPTIONS.map((y) => (
              <option key={y} value={y}>{t("retention.years", { count: y })}</option>
            ))}
          </select>
          <div>
            <button type="submit" className={button}>{t("retention.save")}</button>
          </div>
        </form>
      </section>
    </main>
  );
}
