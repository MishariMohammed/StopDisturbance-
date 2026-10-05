"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { riyadhDay } from "@/lib/format";
import { CopyButton } from "./copy-button";

const safeUrl = (u: string | null) => {
  try {
    const url = new URL(u ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

/**
 * Web forms are submitted by the owner, never by us (04-ux §6.4): numbered steps, a copy button per field,
 * [Open form ↗], then "I submitted it" with the date, which starts the tracker's deadline.
 */
export function WebFormGuide({
  formUrl,
  fullName,
  emails,
  requestText,
  pending,
  onSubmitted,
}: {
  formUrl: string | null;
  fullName: string;
  emails: string[];
  requestText: string;
  pending?: boolean;
  onSubmitted: (day: string) => void;
}) {
  const t = useTranslations("webForm");
  const id = useId();
  const today = riyadhDay();
  const [day, setDay] = useState(today);
  const href = safeUrl(formUrl);
  const fields = [
    { key: "name", value: fullName },
    { key: "email", value: emails.join(", ") },
  ].filter((f) => f.value);
  return (
    <section aria-labelledby={`${id}-t`} className="rounded-md border border-border bg-surface-2 p-3">
      <h3 id={`${id}-t`} className="font-semibold">{t("title")}</h3>
      <p className="mt-1 text-sm text-muted">{t("lead")}</p>
      <ol className="mt-3 list-decimal space-y-3 ps-5 text-sm">
        <li>
          {t("step1")}{" "}
          {href ? (
            <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-tap items-center gap-1 font-medium text-primary underline underline-offset-4">
              {t("open")}
              <span aria-hidden="true">↗</span>
              <span className="sr-only"> {t("newTab")}</span>
            </a>
          ) : (
            <span className="text-warning">{t("noUrl")}</span>
          )}
          {formUrl && <bdi dir="ltr" className="mt-1 block break-all text-xs text-muted">{formUrl}</bdi>}
        </li>
        <li>
          {t("step2")}
          <ul className="mt-2 space-y-2">
            {fields.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(`field.${f.key}`)}:</span>
                <bdi dir="auto">{f.value}</bdi>
                <CopyButton text={f.value} label={t("copyField", { field: t(`field.${f.key}`) })} />
              </li>
            ))}
            <li>
              <span className="font-medium">{t("field.request")}:</span>
              <pre tabIndex={0} aria-label={t("field.request")} dir="auto" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-2 font-sans text-sm">
                {requestText}
              </pre>
              <CopyButton text={requestText} label={t("copyField", { field: t("field.request") })} />
            </li>
          </ul>
        </li>
        <li>{t("step3")}</li>
        <li>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (day) onSubmitted(day);
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <span className="w-full">{t("step4")}</span>
            <span className="flex flex-col">
              <label htmlFor={`${id}-d`} className="text-sm font-medium">{t("date")}</label>
              <input
                id={`${id}-d`}
                type="date"
                required
                dir="ltr"
                max={today}
                value={day}
                onChange={(e) => setDay(e.target.value)}
                className="mt-1 min-h-tap rounded-md border border-border-strong bg-surface px-3"
              />
            </span>
            <button type="submit" disabled={pending} className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg disabled:opacity-60">
              {t("submitted")}
            </button>
          </form>
        </li>
      </ol>
    </section>
  );
}
