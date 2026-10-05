import type { MailAccount } from "@prisma/client";
import { sendEmail } from "@/lib/send/mailbox";
import type { ProviderSendResult } from "@/lib/send/gmail-send";

// RFC 2369 mailto: unsubscribe (02-capabilities §5.3): a plain-text email from the owner's mailbox to the
// list's unsubscribe address, with the list's own subject/body kept verbatim (drafts.ts filled them).
// Approved individually like every other send (03-legal M4).

export async function sendMailtoUnsub(
  account: MailAccount,
  item: { to: string; subject: string | null; body: string | null; fromName?: string | null },
  now = new Date(),
): Promise<ProviderSendResult> {
  return sendEmail(
    account,
    { to: item.to, subject: item.subject ?? "Unsubscribe", text: item.body ?? "Unsubscribe\n", fromName: item.fromName, plainOnly: true },
    now,
  );
}
