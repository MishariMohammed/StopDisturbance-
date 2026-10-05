"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/session";
import {
  cancelQueued,
  closeRequest,
  confirmReply,
  createIdReplyDraft,
  createReminderDraft,
  escalationPacket,
  markEscalated,
  markWebFormSubmitted,
  recordExtension,
  replyText,
} from "@/lib/track/actions";

const Id = z.string().min(1).max(64);
const Locale = z.enum(["ar", "en"]).catch("ar");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ReplyClass = z.enum(["ACKNOWLEDGED", "COMPLETED", "REFUSED", "NEEDS_ID", "EXTENSION", "NOT_RELATED"]);
const Outcome = z.enum(["COMPLETED", "REFUSED", "CANCELLED"]);

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function codeOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : "failed";
}

async function guard(locale: string) {
  const loc = Locale.parse(locale);
  await requireOwner(loc);
  return loc;
}

function done(loc: string, requestId?: string) {
  revalidatePath(`/${loc}/tracker`);
  if (requestId) revalidatePath(`/${loc}/tracker/${requestId}`);
  revalidatePath(`/${loc}/review`);
}

/** A Riyadh calendar day (from <input type="date">) as noon local time; never in the future. */
function dayToDate(day: string): Date | null {
  if (!Day.safeParse(day).success) return null;
  const d = new Date(`${day}T12:00:00+03:00`);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 12 * 3600_000) return null;
  return d;
}

async function wrap<T extends object>(loc: string, requestId: string | undefined, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const res = await fn();
    done(loc, requestId);
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: codeOf(e) };
  }
}

export async function cancelQueuedAction(locale: string, requestId: string, outboundId: string): Promise<ActionResult> {
  const loc = await guard(locale);
  if (!Id.safeParse(outboundId).success || !Id.safeParse(requestId).success) return { ok: false, error: "invalid" };
  return wrap(loc, requestId, async () => {
    await cancelQueued(outboundId);
    return {};
  });
}

export async function webFormSubmittedAction(locale: string, requestId: string, day: string): Promise<ActionResult> {
  const loc = await guard(locale);
  const at = dayToDate(day);
  if (!Id.safeParse(requestId).success) return { ok: false, error: "invalid" };
  if (!at) return { ok: false, error: "bad_date" };
  return wrap(loc, requestId, async () => {
    await markWebFormSubmitted(requestId, at);
    return {};
  });
}

/** Creates the pre-drafted reminder (or 6e identity reply) and returns its id; the owner reviews it on /review. */
export async function followUpDraftAction(locale: string, requestId: string, kind: "REMINDER" | "ID_REPLY"): Promise<ActionResult<{ outboundId: string }>> {
  const loc = await guard(locale);
  if (!Id.safeParse(requestId).success || (kind !== "REMINDER" && kind !== "ID_REPLY")) return { ok: false, error: "invalid" };
  return wrap(loc, requestId, async () => (kind === "REMINDER" ? createReminderDraft(requestId) : createIdReplyDraft(requestId)));
}

export async function confirmReplyAction(locale: string, requestId: string, replyId: string, cls: string, extensionDay?: string): Promise<ActionResult> {
  const loc = await guard(locale);
  const parsed = z.object({ requestId: Id, replyId: Id, cls: ReplyClass }).safeParse({ requestId, replyId, cls });
  if (!parsed.success) return { ok: false, error: "invalid" };
  let notice: Date | undefined;
  if (parsed.data.cls === "EXTENSION") {
    const d = extensionDay ? dayToDate(extensionDay) : null;
    if (!d) return { ok: false, error: "bad_date" };
    notice = d;
  }
  return wrap(loc, requestId, async () => {
    await confirmReply(parsed.data.replyId, parsed.data.cls, notice);
    return {};
  });
}

export async function recordExtensionAction(locale: string, requestId: string, day: string): Promise<ActionResult> {
  const loc = await guard(locale);
  const at = dayToDate(day);
  if (!Id.safeParse(requestId).success) return { ok: false, error: "invalid" };
  if (!at) return { ok: false, error: "bad_date" };
  return wrap(loc, requestId, async () => {
    await recordExtension(requestId, at);
    return {};
  });
}

/** Builds the complaint packet for the EscalationWizard. Read-only: nothing is filed. */
export async function escalationPacketAction(locale: string, requestId: string, lang: string) {
  await guard(locale);
  if (!Id.safeParse(requestId).success) return { ok: false as const, error: "invalid" };
  try {
    const packet = await escalationPacket(requestId, lang === "ar" ? "ar" : "en");
    return { ok: true as const, packet: JSON.parse(JSON.stringify(packet)) as typeof packet };
  } catch (e) {
    return { ok: false as const, error: codeOf(e) };
  }
}

/** "I filed it": the owner filed with the regulator themselves; we record the date and reference. */
export async function markEscalatedAction(locale: string, requestId: string, complaintRef: string): Promise<ActionResult> {
  const loc = await guard(locale);
  const parsed = z.object({ id: Id, ref: z.string().trim().max(120) }).safeParse({ id: requestId, ref: complaintRef });
  if (!parsed.success) return { ok: false, error: "invalid" };
  return wrap(loc, requestId, async () => {
    await markEscalated(parsed.data.id, parsed.data.ref || undefined);
    return {};
  });
}

export async function closeRequestAction(locale: string, requestId: string, outcome: string): Promise<ActionResult> {
  const loc = await guard(locale);
  const parsed = z.object({ id: Id, outcome: Outcome }).safeParse({ id: requestId, outcome });
  if (!parsed.success) return { ok: false, error: "invalid" };
  return wrap(loc, requestId, async () => {
    await closeRequest(parsed.data.id, parsed.data.outcome);
    return {};
  });
}

/** "Show full reply": decrypted text of one stored reply (owner only). */
export async function replyTextAction(locale: string, replyId: string): Promise<ActionResult<{ text: string }>> {
  await guard(locale);
  if (!Id.safeParse(replyId).success) return { ok: false, error: "invalid" };
  try {
    return { ok: true, text: await replyText(replyId) };
  } catch (e) {
    return { ok: false, error: codeOf(e) };
  }
}
