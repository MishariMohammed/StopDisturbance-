"use server";
import { requireOwner } from "@/lib/auth/session";
import { eraseEverything } from "@/lib/privacy/erase";
import { eraseWordMatches } from "@/lib/privacy/erase-word";

export type EraseState =
  | { status: "idle" }
  | { status: "wrong_word" }
  | { status: "done"; microsoftConsentUrl: string | null; revoked: number; mailboxes: number; keptAuditRows: number };

/** Type-to-confirm erase (04-ux §3.6): "ERASE" in English, «امسح» in Arabic. Paste is allowed (WCAG 3.3.8). */
export async function eraseEverythingAction(_prev: EraseState, formData: FormData): Promise<EraseState> {
  const locale = formData.get("locale") === "en" ? "en" : "ar";
  await requireOwner(locale);
  if (!eraseWordMatches(locale, String(formData.get("confirmWord") ?? ""))) return { status: "wrong_word" };
  const res = await eraseEverything({ keepSentAudit: formData.get("keepSentAudit") === "on" });
  return {
    status: "done",
    microsoftConsentUrl: res.microsoftConsentUrl,
    revoked: res.revocations.filter((r) => r.revoked).length,
    mailboxes: res.revocations.length,
    keptAuditRows: res.keptAuditRows,
  };
}
