"use client";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { eraseWordMatches, ERASE_WORDS } from "@/lib/privacy/erase-word";
import { eraseEverythingAction, type EraseState } from "./actions";

export function EraseForm({ locale, consequences }: { locale: string; consequences: string[] }) {
  const t = useTranslations("settingsData.erase");
  const [state, action, pending] = useActionState<EraseState, FormData>(eraseEverythingAction, { status: "idle" });
  const [word, setWord] = useState("");
  const expected = locale === "en" ? ERASE_WORDS.en : ERASE_WORDS.ar;
  const matches = eraseWordMatches(locale, word);

  if (state.status === "done") {
    return (
      <div role="status" className="mt-3 space-y-2 rounded-md bg-success-bg p-3 text-sm text-success" data-testid="erase-done">
        <p className="font-medium">{t("done")}</p>
        <p>{t("doneRevoked", { revoked: state.revoked, total: state.mailboxes })}</p>
        {state.keptAuditRows > 0 && <p>{t("doneKept", { count: state.keptAuditRows })}</p>}
        {state.microsoftConsentUrl && (
          <p>
            {t("msConsentLead")}{" "}
            <a href={state.microsoftConsentUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
              {t("msConsentLink")}
            </a>
          </p>
        )}
        <p>
          <a href={`/${locale}/login`} className="font-medium underline underline-offset-4">{t("startOver")}</a>
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="locale" value={locale} />
      <ul className="list-disc space-y-1 ps-5 text-sm">
        {consequences.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <label className="flex min-h-tap items-start gap-2 text-sm">
        <input type="checkbox" name="keepSentAudit" className="mt-1 size-5 shrink-0" />
        <span>{t("keepSentAudit")}</span>
      </label>
      <label htmlFor="confirmWord" className="block font-medium">
        {t("typeLabel", { word: expected })}
      </label>
      <input
        id="confirmWord"
        name="confirmWord"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={word}
        onChange={(e) => setWord(e.target.value)}
        aria-describedby="erase-word-help"
        aria-invalid={state.status === "wrong_word" ? true : undefined}
        className="min-h-tap w-full max-w-xs rounded-md border border-border-strong bg-surface px-3"
      />
      <p id="erase-word-help" className="text-sm text-muted">{t("typeHelp", { word: expected })}</p>
      {state.status === "wrong_word" && (
        <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">{t("wrongWord", { word: expected })}</p>
      )}
      <button
        type="submit"
        disabled={!matches || pending}
        className="min-h-tap rounded-md bg-danger px-4 py-2 font-medium text-primary-fg disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? t("erasing") : t("button")}
      </button>
    </form>
  );
}
