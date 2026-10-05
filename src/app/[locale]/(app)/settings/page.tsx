import { getTranslations } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { getAiMode, getOptOutConfirmedAt } from "@/lib/llm/gate";
import { formatDate } from "@/lib/format";
import { saveAiModeAction } from "./actions";

export const dynamic = "force-dynamic";

const OUTCOMES = ["saved_rules", "saved_deepseek", "opt_out_required", "bad_date"] as const;

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
  const [mode, optOut] = await Promise.all([getAiMode(), getOptOutConfirmedAt()]);
  const key = env().DEEPSEEK_API_KEY;
  const outcome = OUTCOMES.find((o) => o === sp.ai);
  const failed = outcome === "opt_out_required" || outcome === "bad_date";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="max-w-prose">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("lead")}</p>

      <section id="ai" aria-labelledby="ai-title" className="mt-8 rounded-lg border border-border bg-surface p-4 sm:p-6">
        <h2 id="ai-title" className="text-xl font-semibold">{t("ai.title")}</h2>
        <p className="mt-1 text-sm">
          {t("ai.current")} <strong>{mode === "DEEPSEEK" ? t("ai.deepseek") : t("ai.rules")}</strong>
        </p>
        {outcome &&
          (failed ? (
            <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">{t(`ai.outcome.${outcome}`)}</p>
          ) : (
            <p role="status" className="mt-3 rounded-md bg-success-bg p-3 text-sm text-success">{t(`ai.outcome.${outcome}`)}</p>
          ))}

        <form action={saveAiModeAction} className="mt-4 space-y-4">
          <input type="hidden" name="locale" value={locale} />
          <fieldset>
            <legend className="font-medium">{t("ai.mode")}</legend>
            <label className="mt-1 flex min-h-tap items-center gap-2">
              <input type="radio" name="aiMode" value="RULES" defaultChecked={mode === "RULES"} className="size-5" />
              {t("ai.rulesLong")}
            </label>
            <label className="flex min-h-tap items-center gap-2">
              <input type="radio" name="aiMode" value="DEEPSEEK" defaultChecked={mode === "DEEPSEEK"} aria-describedby="gate-help" className="size-5" />
              {t("ai.deepseekLong")}
            </label>
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

          <p className="text-sm">
            {t("ai.key")}{" "}
            {key ? (
              <bdi dir="ltr" className="font-mono">{`${key.slice(0, 3)}…${key.slice(-4)}`}</bdi>
            ) : (
              <span className="text-warning">{t("ai.noKey")}</span>
            )}{" "}
            · {t("ai.model")} <bdi dir="ltr" className="font-mono">{env().LLM_MODEL}</bdi>
          </p>

          <button type="submit" className="min-h-tap rounded-md bg-primary px-4 py-2 font-medium text-primary-fg">{t("ai.save")}</button>
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
      </section>
    </main>
  );
}
