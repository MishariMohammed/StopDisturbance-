import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** "What we can see" — same place in the header on every page (WCAG 3.2.6). */
export async function HelpLink({ locale }: { locale: string }) {
  const t = await getTranslations("nav");
  return (
    <Link
      href={`/${locale}/what-we-see`}
      className="inline-flex min-h-tap items-center rounded-md px-2 text-sm font-medium text-primary underline underline-offset-4"
    >
      {t("help")}
    </Link>
  );
}
