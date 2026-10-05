"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { ScanStatus } from "@/lib/companies/scan-status";
import { formatNumber } from "@/lib/format";

const POLL_MS = 5000;

/** Polls /api/scan/status every 5 s; the live region therefore updates at most once per 5 s. */
export function ScanLive({ initial, locale }: { initial: ScanStatus; locale: string }) {
  const t = useTranslations("scan");
  const [status, setStatus] = useState(initial);
  const [stale, setStale] = useState(false);
  const n = (v: number) => formatNumber(locale, v);

  useEffect(() => {
    if (!status.running) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/scan/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as ScanStatus;
        if (alive) {
          setStatus(next);
          setStale(false);
        }
      } catch {
        if (alive) setStale(true);
      }
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [status.running]);

  if (!status.accounts.length) {
    return (
      <p className="mt-6">
        {t("noAccounts")}{" "}
        <Link href={`/${locale}/connect`} className="text-primary underline underline-offset-4">{t("connectLink")}</Link>
      </p>
    );
  }

  return (
    <>
      <ul className="mt-6 flex flex-col gap-4" aria-label={t("accounts")}>
        {status.accounts.map((a) => {
          const label = `${a.address}`;
          return (
            <li key={a.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span id={`acc-${a.id}`} className="font-medium"><bdi dir="ltr">{label}</bdi></span>
                <span className="text-muted">
                  {a.status !== "ACTIVE"
                    ? t("reconnect")
                    : a.phase === "done"
                      ? t("accountDone", { count: n(a.fetched) })
                      : a.phase === "pending"
                        ? t("waiting")
                        : a.percent === null
                          ? t("checked", { count: n(a.fetched) })
                          : t("progress", { fetched: n(a.fetched), listed: n(a.listed), percent: n(a.percent) })}
                </span>
              </div>
              <div
                role="progressbar"
                aria-labelledby={`acc-${a.id}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={a.percent ?? undefined}
                aria-valuetext={a.percent === null ? t("checked", { count: n(a.fetched) }) : `${n(a.percent)}%`}
                className="mt-2 flex h-3 overflow-hidden rounded-sm bg-surface-2 outline outline-1 outline-border-strong"
              >
                <div
                  className={`h-full ${a.status === "ACTIVE" ? "bg-primary" : "bg-danger"} ${a.percent === null ? "animate-pulse" : ""}`}
                  style={{ width: `${a.percent ?? 30}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="found-title" className="mt-8 rounded-lg border border-border bg-surface p-4">
        <h2 id="found-title" className="text-lg font-semibold">{status.running ? t("foundSoFar") : t("summaryTitle")}</h2>
        <p aria-live="polite" aria-atomic="true" className="mt-1">
          {t("tally", { companies: n(status.companies), ads: n(status.ads), data: n(status.data) })}
        </p>
        {status.recent.length > 0 && (
          <p aria-hidden="true" className="mt-2 text-sm text-muted">
            {t("recent")} {status.recent.map((r, i) => (
              <span key={i}>{i > 0 && " · "}<bdi>{r}</bdi></span>
            ))}
          </p>
        )}
        {stale && <p role="status" className="mt-2 text-sm text-warning">{t("stale")}</p>}
        <Link
          href={`/${locale}/companies`}
          className="mt-4 inline-flex min-h-tap items-center rounded-md bg-primary px-4 py-2 font-medium text-primary-fg"
        >
          {status.running ? t("seeSoFar") : t("cta")}
        </Link>
      </section>
    </>
  );
}
