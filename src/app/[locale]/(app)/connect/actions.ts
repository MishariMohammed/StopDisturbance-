"use server";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth/session";
import { saveSetup, setupSchema } from "@/lib/settings/setup";

export async function saveSetupAction(formData: FormData) {
  const current = formData.get("currentLocale") === "en" ? "en" : "ar";
  const session = await requireOwner(current);
  const parsed = setupSchema.safeParse({
    locale: formData.get("locale"),
    fullName: formData.get("fullName"),
    country: formData.get("country"),
  });
  if (!parsed.success) redirect(`/${current}/connect?setup=invalid`);
  await saveSetup(parsed.data, session.user.email);
  redirect(`/${parsed.data.locale}/connect?setup=saved`);
}
