"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function Toggle({ locale }: { locale: string }) {
  const pathname = usePathname() ?? `/${locale}`;
  const search = useSearchParams()?.toString();
  const other = locale === "ar" ? "en" : "ar";
  const path = pathname.replace(/^\/(ar|en)(?=\/|$)/, `/${other}`);
  return (
    <a
      href={`${path}${search ? `?${search}` : ""}`}
      hrefLang={other}
      lang={other}
      className="inline-flex min-h-tap min-w-tap items-center justify-center rounded-md border border-border-strong px-3 text-sm font-medium"
    >
      {other === "ar" ? "العربية" : "English"}
    </a>
  );
}

/** Switches the route locale (which sets lang/dir on <html>), keeping the path and filters. */
export function LanguageToggle(props: { locale: string }) {
  return (
    <Suspense fallback={null}>
      <Toggle {...props} />
    </Suspense>
  );
}
