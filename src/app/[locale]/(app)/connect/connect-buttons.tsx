"use client";
import { useRef } from "react";
import { useTranslations } from "next-intl";

/** Provider buttons. Google always shows the unverified-app interstitial first (04-ux §4.4). */
export function ConnectButtons({ locale }: { locale: string }) {
  const t = useTranslations("connect");
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    dialog.current?.close();
    opener.current?.focus();
  };
  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-3">
        <button
          ref={opener}
          type="button"
          onClick={() => dialog.current?.showModal()}
          aria-haspopup="dialog"
          className="min-h-tap rounded-md bg-primary px-4 py-2 font-medium text-primary-fg"
        >
          {t("gmail")}
        </button>
        <a href={`/api/mail/microsoft/start?locale=${locale}`} className="inline-flex min-h-tap items-center rounded-md border border-border-strong px-4 py-2 font-medium">
          {t("outlook")}
        </a>
      </div>
      <p className="mt-2 max-w-prose text-sm text-muted">{t("microsoftNote")}</p>

      <dialog
        ref={dialog}
        aria-labelledby="google-warning-title"
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-6 text-text shadow-drawer"
      >
        <h2 id="google-warning-title" className="text-xl font-semibold">{t("interstitial.title")}</h2>
        <p className="mt-3">{t("interstitial.body1")}</p>
        <p className="mt-2">{t("interstitial.body2")}</p>
        <p className="mt-2">{t("interstitial.body3")}</p>
        <p className="mt-2 text-sm text-muted">
          {t("interstitial.revoke")} <bdi dir="ltr">myaccount.google.com/permissions</bdi>
        </p>
        <div className="mt-6 flex flex-wrap justify-between gap-3">
          <button type="button" onClick={close} className="min-h-tap rounded-md border border-border-strong px-4 py-2">
            {t("interstitial.notNow")}
          </button>
          <a href={`/api/mail/google/start?locale=${locale}`} className="inline-flex min-h-tap items-center rounded-md bg-primary px-4 py-2 font-medium text-primary-fg">
            {t("interstitial.continue")}
          </a>
        </div>
      </dialog>
    </div>
  );
}
