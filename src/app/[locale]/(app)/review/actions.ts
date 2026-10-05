"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { UNDO_WINDOW_MS } from "@/lib/legal/drafts";
// The track API accepts first letters and follow-ups (6b reminder, 6e ID reply) alike.
import {
  approveOutbound,
  cancelQueued,
  closeRequest,
  markWebFormSubmitted,
  queueOutbound,
  updateOutbound,
} from "@/lib/track/actions";
import { holdQueued, loadOriginal, snapshotOriginal } from "@/lib/review/load";

const Id = z.string().min(1).max(64);
const Ids = z.array(Id).min(1).max(500);
const Locale = z.enum(["ar", "en"]).catch("ar");
const Patch = z.object({
  to: z.string().max(2000).nullable().optional(),
  subject: z.string().max(1000).nullable().optional(),
  body: z.string().max(50_000).nullable().optional(),
});
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

function done(loc: string) {
  revalidatePath(`/${loc}/review`);
  revalidatePath(`/${loc}/tracker`);
}

async function save(outboundId: string, patch: z.infer<typeof Patch>) {
  await snapshotOriginal(outboundId);
  return updateOutbound(outboundId, patch);
}

export async function saveDraftAction(locale: string, outboundId: string, patch: unknown): Promise<ActionResult<{ warnings: string[] }>> {
  const loc = await guard(locale);
  const parsed = z.object({ id: Id, patch: Patch }).safeParse({ id: outboundId, patch });
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const res = await save(parsed.data.id, parsed.data.patch);
    done(loc);
    return { ok: true, warnings: res.warnings };
  } catch (e) {
    return { ok: false, error: codeOf(e) };
  }
}

/** Per-item approval. Unsaved edits are saved first (which is what gets approved). */
export async function approveAction(locale: string, outboundId: string, patch?: unknown): Promise<ActionResult<{ warnings: string[] }>> {
  const loc = await guard(locale);
  const parsed = z.object({ id: Id, patch: Patch.optional() }).safeParse({ id: outboundId, patch });
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    let warnings: string[] = [];
    if (parsed.data.patch && Object.keys(parsed.data.patch).length) warnings = (await save(parsed.data.id, parsed.data.patch)).warnings;
    await approveOutbound(parsed.data.id);
    done(loc);
    return { ok: true, warnings };
  } catch (e) {
    done(loc);
    return { ok: false, error: codeOf(e) };
  }
}

/** Unticking a row's approval: an empty edit recomputes the hash and clears the approval (logged). */
export async function unapproveAction(locale: string, outboundId: string): Promise<ActionResult> {
  const loc = await guard(locale);
  if (!Id.safeParse(outboundId).success) return { ok: false, error: "invalid" };
  try {
    await save(outboundId, {});
    done(loc);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: codeOf(e) };
  }
}

export async function resetDraftAction(locale: string, outboundId: string): Promise<ActionResult<{ warnings: string[] }>> {
  const loc = await guard(locale);
  if (!Id.safeParse(outboundId).success) return { ok: false, error: "invalid" };
  const original = await loadOriginal(outboundId);
  if (!original) return { ok: false, error: "no_original" };
  try {
    const res = await updateOutbound(outboundId, original);
    done(loc);
    return { ok: true, warnings: res.warnings };
  } catch (e) {
    return { ok: false, error: codeOf(e) };
  }
}

/** Confirms a guessed (LOW) recipient so the draft can be approved (00-brief stage 4). */
export async function confirmRecipientAction(locale: string, contactId: string): Promise<ActionResult> {
  const loc = await guard(locale);
  if (!Id.safeParse(contactId).success) return { ok: false, error: "invalid" };
  const n = await db.companyContact.updateMany({ where: { id: contactId }, data: { ownerConfirmed: true } });
  if (!n.count) return { ok: false, error: "not_found" };
  await db.auditLog.create({ data: { action: "contact.owner_confirmed", entity: "companyContact", entityId: contactId, data: {} } });
  done(loc);
  return { ok: true };
}

/** After the SendConfirmDialog: each approved item enters QUEUED with a 10 s undo window. */
export async function queueAction(
  locale: string,
  outboundIds: string[],
): Promise<ActionResult<{ queued: { id: string; sendAfter: string }[]; failed: { id: string; error: string }[] }>> {
  const loc = await guard(locale);
  const parsed = Ids.safeParse(outboundIds);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const queued: { id: string; sendAfter: string }[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of [...new Set(parsed.data)]) {
    try {
      const { sendAfter } = await queueOutbound(id);
      queued.push({ id, sendAfter: sendAfter.toISOString() });
    } catch (e) {
      failed.push({ id, error: codeOf(e) });
    }
  }
  done(loc);
  return { ok: true, queued, failed };
}

export async function undoAction(locale: string, outboundIds: string[]): Promise<ActionResult<{ undone: number; missed: number }>> {
  const loc = await guard(locale);
  const parsed = Ids.safeParse(outboundIds);
  if (!parsed.success) return { ok: false, error: "invalid" };
  let undone = 0;
  let missed = 0;
  for (const id of parsed.data) {
    try {
      await cancelQueued(id);
      undone++;
    } catch {
      missed++;
    }
  }
  done(loc);
  return { ok: true, undone, missed };
}

/** Pauses the undo countdown (hover/focus on the toast) by keeping sendAfter a full window ahead. */
export async function holdAction(locale: string, outboundIds: string[]): Promise<ActionResult<{ held: number }>> {
  await guard(locale);
  const parsed = Ids.safeParse(outboundIds);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return { ok: true, held: await holdQueued(parsed.data, UNDO_WINDOW_MS) };
}

/** "I submitted it" for a web form: the tracker starts the legal clock from that date (04-ux §6.4). */
export async function webFormSubmittedAction(locale: string, requestId: string, day: string): Promise<ActionResult> {
  const loc = await guard(locale);
  const parsed = z.object({ id: Id, day: Day }).safeParse({ id: requestId, day });
  if (!parsed.success) return { ok: false, error: "invalid" };
  const at = new Date(`${parsed.data.day}T12:00:00+03:00`);
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 12 * 3600_000) return { ok: false, error: "bad_date" };
  try {
    await markWebFormSubmitted(parsed.data.id, at);
    done(loc);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: codeOf(e) };
  }
}

/** "Don't send": the request is cancelled (kept in the tracker as stopped). */
export async function cancelDraftAction(locale: string, requestId: string): Promise<ActionResult> {
  const loc = await guard(locale);
  if (!Id.safeParse(requestId).success) return { ok: false, error: "invalid" };
  try {
    await closeRequest(requestId, "CANCELLED");
    done(loc);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: codeOf(e) };
  }
}
