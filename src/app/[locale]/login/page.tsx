import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getOwnerSession } from "@/lib/auth/session";
import { LoginButtons } from "./buttons";

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (await getOwnerSession()) redirect(`/${locale}/connect`);
  const t = await getTranslations("login");
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm opacity-80">{t("lead")}</p>
      <LoginButtons locale={locale} labels={{ google: t("google"), microsoft: t("microsoft") }} />
    </main>
  );
}
