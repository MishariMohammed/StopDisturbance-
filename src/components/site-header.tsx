import { getTranslations } from "next-intl/server";
import { HelpLink } from "./help-link";
import { LanguageToggle } from "./language-toggle";
import { NavLinks, type NavItem } from "./nav-links";

/** App chrome. `nav` is omitted on /login and the public help page; HelpLink stays in the same place. */
export async function SiteHeader({ locale, nav = false }: { locale: string; nav?: boolean }) {
  const t = await getTranslations("nav");
  const tApp = await getTranslations("app");
  const base = `/${locale}`;
  const items: NavItem[] = [
    { href: `${base}/connect`, label: t("connect") },
    { href: `${base}/scan`, label: t("scan") },
    { href: `${base}/companies`, label: t("companies") },
    { href: `${base}/review`, label: t("review"), disabled: true, note: t("soon") },
    { href: `${base}/tracker`, label: t("tracker"), disabled: true, note: t("soon") },
    { href: `${base}/settings`, label: t("settings") },
  ];
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-content flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <span className="text-lg font-semibold">{tApp("name")}</span>
        {nav && <NavLinks items={items} label={t("label")} />}
        <div className="ms-auto flex items-center gap-2">
          <HelpLink locale={locale} />
          <LanguageToggle locale={locale} />
        </div>
      </div>
    </header>
  );
}
