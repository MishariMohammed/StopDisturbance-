import { getTranslations, setRequestLocale } from "next-intl/server";
import { SiteHeader } from "@/components/site-header";

// "What we can see" (04-ux §1.1). Static copy only, no data, so it is reachable before sign-in.
export default async function WhatWeSeePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("whatWeSee");
  const tc = await getTranslations("connect");
  const sections = ["read", "store", "never", "ai", "control"] as const;
  return (
    <>
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-prose px-4 py-10">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-2 text-muted">{t("lead")}</p>
        {sections.map((s) => (
          <section key={s} aria-labelledby={`wws-${s}`} className="mt-8">
            <h2 id={`wws-${s}`} className="text-xl font-semibold">{t(`${s}.title`)}</h2>
            <p className="mt-2">{t(`${s}.body`)}</p>
          </section>
        ))}
        <section aria-labelledby="wws-scopes" className="mt-8">
          <h2 id="wws-scopes" className="text-xl font-semibold">{tc("scopes.title")}</h2>
          <ul className="mt-2 list-disc space-y-2 ps-5">
            {(["googleProfile", "gmailRead", "gmailSend", "msRead", "msSend", "msOffline"] as const).map((k) => (
              <li key={k}>
                <bdi dir="ltr" className="font-mono text-sm">{tc(`scopes.${k}.name`)}</bdi>: {tc(`scopes.${k}.text`)}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
