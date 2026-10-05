import { db } from "@/lib/db";
import { ownerEmails } from "@/lib/env";

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ownerEmails().includes(email.trim().toLowerCase());
}

/**
 * The first successful login pins the provider subject (Google `sub` / Microsoft `oid`).
 * Later logins from a different subject with the same email are refused (00-brief §8).
 */
export async function checkAndPinSubject(providerId: string, subject: string): Promise<boolean> {
  const field = providerId === "google" ? "googleSub" : providerId === "microsoft" ? "msOid" : null;
  if (!field) return false;
  const owner = await db.owner.upsert({
    where: { id: "owner" },
    create: { id: "owner", loginEmails: [], [field]: subject },
    update: {},
  });
  const pinned = owner[field];
  if (pinned && pinned !== subject) return false;
  if (!pinned) await db.owner.update({ where: { id: "owner" }, data: { [field]: subject } });
  return true;
}
