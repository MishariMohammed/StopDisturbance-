import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { enqueueInitialSync } from "@/lib/jobs/queue";
import { scanFromFor, type ScanRange } from "@/lib/mail/scan-range";

export class ScanRangeError extends Error {
  constructor(public code: "not_found" | "not_active") {
    super(code);
  }
}

/** Sets the range, drops the sync cursor and progress, and queues a fresh initial sync for that mailbox. */
export async function restartScan(accountId: string, range: ScanRange, now = new Date()) {
  const account = await db.mailAccount.findUnique({ where: { id: accountId }, select: { id: true, status: true } });
  if (!account) throw new ScanRangeError("not_found");
  if (account.status !== "ACTIVE") throw new ScanRangeError("not_active");
  const scanFrom = scanFromFor(range, now);
  await db.mailAccount.update({
    where: { id: accountId },
    data: { scanFrom, syncCursor: Prisma.DbNull, scanProgress: Prisma.DbNull },
  });
  await audit("scan.range_changed", "MailAccount", accountId, { range });
  await enqueueInitialSync(accountId);
  return { scanFrom };
}

/** True when the mailbox's scanFrom is no longer the one a running initial sync started with. */
export async function scanRangeChanged(accountId: string, startedWith: Date): Promise<boolean> {
  const now = await db.mailAccount.findUnique({ where: { id: accountId }, select: { scanFrom: true } });
  return !!now && now.scanFrom.getTime() !== startedWith.getTime();
}
