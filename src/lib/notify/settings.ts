import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

// Setting `notifications` (00-brief §4): weekly digest + instant alerts, each toggleable (04-ux §8.2).
// Stored as an object; `false` switches everything off. Missing keys default to on.

export const NOTIFICATIONS_KEY = "notifications";

export const ALERT_KINDS = ["replyReceived", "needsAction", "overdue", "deadlineSoon", "sendFailed", "mailboxDisconnected"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export type NotificationSettings = { digest: boolean } & Record<AlertKind, boolean>;

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  digest: true,
  replyReceived: true,
  needsAction: true,
  overdue: true,
  deadlineSoon: true,
  sendFailed: true,
  mailboxDisconnected: true,
};

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const row = await db.setting.findUnique({ where: { key: NOTIFICATIONS_KEY } });
  if (row?.value === false) return Object.fromEntries(Object.keys(DEFAULT_NOTIFICATIONS).map((k) => [k, false])) as NotificationSettings;
  const v = row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : {};
  const out = { ...DEFAULT_NOTIFICATIONS };
  for (const k of Object.keys(out) as (keyof NotificationSettings)[]) if (typeof v[k] === "boolean") out[k] = v[k] as boolean;
  return out;
}

export async function setNotificationSettings(patch: Partial<NotificationSettings>): Promise<NotificationSettings> {
  const next = { ...(await getNotificationSettings()) };
  for (const k of Object.keys(DEFAULT_NOTIFICATIONS) as (keyof NotificationSettings)[]) if (typeof patch[k] === "boolean") next[k] = patch[k]!;
  await db.setting.upsert({ where: { key: NOTIFICATIONS_KEY }, create: { key: NOTIFICATIONS_KEY, value: next }, update: { value: next } });
  await audit("settings.notifications", "setting", NOTIFICATIONS_KEY, next);
  return next;
}
