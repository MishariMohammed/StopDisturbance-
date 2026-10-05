import type { ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireOwner } from "@/lib/auth/session";
import { SiteHeader } from "@/components/site-header";

// Shared chrome for the owner's pages. /login and /what-we-see live outside this group.
export default async function AppLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireOwner(locale);
  const t = await getTranslations("nav");
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:p-2">
        {t("skip")}
      </a>
      <SiteHeader locale={locale} nav />
      <div id="main" tabIndex={-1} className="mx-auto max-w-content px-4 pb-32 pt-6">
        {children}
      </div>
    </>
  );
}
