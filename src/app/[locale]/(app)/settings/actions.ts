"use server";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth/session";
import { setAiMode } from "@/lib/settings/ai";

export async function saveAiModeAction(formData: FormData) {
  const locale = formData.get("locale") === "en" ? "en" : "ar";
  await requireOwner(locale);
  const mode = formData.get("aiMode") === "DEEPSEEK" ? "DEEPSEEK" : "RULES";
  const res = await setAiMode(mode, {
    confirmed: formData.get("optOutConfirmed") === "on",
    date: String(formData.get("optOutDate") ?? ""),
  });
  redirect(`/${locale}/settings?ai=${res.ok ? `saved_${res.mode.toLowerCase()}` : res.reason}#ai`);
}
