import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { hasSendScope, sendEmail } from "@/lib/send/mailbox";

// Notifications go from the owner's own connected mailbox to itself (04-ux §8.2, 00-review D15):
// no third-party email service, and they don't count toward the daily send cap.

/** The owner's first connected mailbox that can send (oldest ACTIVE account with the send scope). */
export async function notificationMailbox() {
  const accounts = await db.mailAccount.findMany({ where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  return accounts.find(hasSendScope) ?? null;
}

export async function sendToSelf(msg: { subject: string; text: string; lang: "en" | "ar" }, now = new Date()): Promise<boolean> {
  const account = await notificationMailbox();
  if (!account) {
    logger.info("no mailbox can send notifications");
    return false;
  }
  try {
    await sendEmail(account, { to: account.address, subject: msg.subject, text: msg.text, lang: msg.lang }, now);
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "notification send failed");
    return false;
  }
}
