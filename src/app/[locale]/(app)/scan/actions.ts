"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/session";
import { SCAN_RANGES } from "@/lib/mail/scan-range";
import { restartScan, ScanRangeError } from "@/lib/mail/restart-scan";

const Input = z.object({
  locale: z.enum(["ar", "en"]).catch("ar"),
  accountId: z.string().min(1).max(64),
  range: z.enum(SCAN_RANGES),
});

/** ScanRangeSelector (04-ux §3.2): changing the range restarts that mailbox's scan. */
export async function changeScanRangeAction(formData: FormData) {
  const locale = formData.get("locale") === "en" ? "en" : "ar";
  await requireOwner(locale);
  const parsed = Input.safeParse({ locale, accountId: formData.get("accountId"), range: formData.get("range") });
  if (!parsed.success) redirect(`/${locale}/scan?range=invalid`);
  let outcome = `restarted&account=${encodeURIComponent(parsed.data.accountId)}`;
  try {
    await restartScan(parsed.data.accountId, parsed.data.range);
  } catch (e) {
    if (!(e instanceof ScanRangeError)) throw e;
    outcome = e.code;
  }
  revalidatePath(`/${locale}/scan`);
  revalidatePath(`/${locale}/companies`);
  redirect(`/${locale}/scan?range=${outcome}`);
}
