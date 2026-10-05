"use server";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth/session";
import { setAiMode, setReplyAiEnabled, testLlmConnection } from "@/lib/settings/ai";
import { db } from "@/lib/db";
import { ARABIC_REVIEWED_KEY } from "@/lib/legal/drafts";
import { ALERT_KINDS, setNotificationSettings, type NotificationSettings } from "@/lib/notify/settings";
import { setRetentionYears } from "@/lib/jobs/retention";
import { disconnectMailbox } from "@/lib/privacy/erase";

// Every action checks the owner session first (requireOwner redirects to /login otherwise).

function localeOf(formData: FormData) {
  return formData.get("locale") === "en" ? "en" : "ar";
}

export async function saveAiModeAction(formData: FormData) {
  const locale = localeOf(formData);
  await requireOwner(locale);
  const mode = formData.get("aiMode") === "DEEPSEEK" ? "DEEPSEEK" : "RULES";
  const res = await setAiMode(mode, {
    confirmed: formData.get("optOutConfirmed") === "on",
    date: String(formData.get("optOutDate") ?? ""),
  });
  redirect(`/${locale}/settings?ai=${res.ok ? `saved_${res.mode.toLowerCase()}` : res.reason}#ai`);
}

/** "Test connection": GET {LLM_BASE_URL}/models with the key; the result gates DeepSeek (00-review D3). */
export async function testConnectionAction(formData: FormData) {
  const locale = localeOf(formData);
  await requireOwner(locale);
  const res = await testLlmConnection();
  redirect(`/${locale}/settings?test=${res.ok ? "ok" : res.keyHash ? "failed" : "no_key"}#ai`);
}

export async function saveReplyAiAction(formData: FormData) {
  const locale = localeOf(formData);
  await requireOwner(locale);
  const on = formData.get("replyAi") === "on";
  const res = await setReplyAiEnabled(on, formData.get("replyAiAck") === "on");
  redirect(`/${locale}/settings?replyAi=${res.ok ? (on ? "saved_on" : "saved_off") : res.reason}#reply-ai`);
}

/**
 * Arabic letters are only generated once the owner records that a lawyer reviewed the Arabic templates
 * (00-brief §11 Q6). Turning it on requires the explicit confirmation tick.
 */
export async function saveArabicReviewAction(formData: FormData) {
  const locale = localeOf(formData);
  await requireOwner(locale);
  const on = formData.get("arabicReviewed") === "on";
  if (on && formData.get("arabicConfirm") !== "on") redirect(`/${locale}/settings?arabic=confirm_required#arabic`);
  await db.setting.upsert({ where: { key: ARABIC_REVIEWED_KEY }, create: { key: ARABIC_REVIEWED_KEY, value: on }, update: { value: on } });
  await db.auditLog.create({ data: { action: "settings.arabic_templates_reviewed", entity: "setting", entityId: ARABIC_REVIEWED_KEY, data: { value: on } } });
  redirect(`/${locale}/settings?arabic=${on ? "saved_on" : "saved_off"}#arabic`);
}

export async function saveNotificationsAction(formData: FormData) {
  const locale = localeOf(formData);
  await requireOwner(locale);
  const patch: Partial<NotificationSettings> = { digest: formData.get("digest") === "on" };
  for (const k of ALERT_KINDS) patch[k] = formData.get(k) === "on";
  await setNotificationSettings(patch);
  redirect(`/${locale}/settings?notifications=saved#notifications`);
}

export async function saveRetentionAction(formData: FormData) {
  const locale = localeOf(formData);
  await requireOwner(locale);
  const years = Number(formData.get("retentionYears"));
  if (![1, 2, 3].includes(years)) redirect(`/${locale}/settings?retention=invalid#retention`);
  await setRetentionYears(years);
  redirect(`/${locale}/settings?retention=saved#retention`);
}

/** Revokes the mailbox grant and deletes its headers (00-brief §8 "Erase and disconnect"). */
export async function disconnectMailboxAction(formData: FormData) {
  const locale = localeOf(formData);
  await requireOwner(locale);
  const id = String(formData.get("accountId") ?? "");
  if (formData.get("confirm") !== "on") redirect(`/${locale}/settings?mailbox=confirm_required#mailboxes`);
  const account = await db.mailAccount.findUnique({ where: { id }, select: { provider: true } });
  if (!account) redirect(`/${locale}/settings?mailbox=not_found#mailboxes`);
  await disconnectMailbox(id);
  redirect(`/${locale}/settings?mailbox=${account.provider === "MICROSOFT" ? "disconnected_ms" : "disconnected"}#mailboxes`);
}
