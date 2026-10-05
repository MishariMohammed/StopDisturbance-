"use server";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth/session";
import { setAiMode } from "@/lib/settings/ai";
import { db } from "@/lib/db";
import { ARABIC_REVIEWED_KEY } from "@/lib/legal/drafts";

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

/**
 * Arabic letters are only generated once the owner records that a lawyer reviewed the Arabic templates
 * (00-brief §11 Q6). Turning it on requires the explicit confirmation tick.
 */
export async function saveArabicReviewAction(formData: FormData) {
  const locale = formData.get("locale") === "en" ? "en" : "ar";
  await requireOwner(locale);
  const on = formData.get("arabicReviewed") === "on";
  if (on && formData.get("arabicConfirm") !== "on") redirect(`/${locale}/settings?arabic=confirm_required#arabic`);
  await db.setting.upsert({ where: { key: ARABIC_REVIEWED_KEY }, create: { key: ARABIC_REVIEWED_KEY, value: on }, update: { value: on } });
  await db.auditLog.create({ data: { action: "settings.arabic_templates_reviewed", entity: "setting", entityId: ARABIC_REVIEWED_KEY, data: { value: on } } });
  redirect(`/${locale}/settings?arabic=${on ? "saved_on" : "saved_off"}#arabic`);
}
