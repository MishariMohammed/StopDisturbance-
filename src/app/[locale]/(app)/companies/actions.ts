"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/session";
import { decideBulk, decideOne, DecisionError } from "@/lib/companies/decisions";
import { GroupingError, mergeCompanies, splitDomain } from "@/lib/companies/merge";
import { createDrafts, DraftError } from "@/lib/legal/drafts";
import { draftableCompanyIds } from "@/lib/review/load";

const Value = z.enum(["KEEP", "UNSUBSCRIBE", "REMOVE"]);
const Id = z.string().min(1).max(64);
const Locale = z.enum(["ar", "en"]).catch("ar");

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function done(locale: string) {
  revalidatePath(`/${locale}/companies`);
}

export async function decideAction(locale: string, companyId: string, value: string): Promise<ActionResult> {
  const loc = Locale.parse(locale);
  await requireOwner(loc);
  const parsed = z.object({ companyId: Id, value: Value }).safeParse({ companyId, value });
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    await decideOne(parsed.data.companyId, parsed.data.value);
  } catch (e) {
    if (e instanceof DecisionError) return { ok: false, error: e.code };
    throw e;
  }
  done(loc);
  return { ok: true };
}

export async function bulkDecideAction(
  locale: string,
  ids: string[],
  value: string,
  confirmed: boolean,
): Promise<ActionResult<{ applied: number; skippedLow: number }>> {
  const loc = Locale.parse(locale);
  await requireOwner(loc);
  const parsed = z.object({ ids: z.array(Id).min(1).max(5000), value: Value, confirmed: z.boolean() }).safeParse({ ids, value, confirmed });
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const plan = await decideBulk(parsed.data.ids, parsed.data.value, parsed.data.confirmed);
    done(loc);
    return { ok: true, applied: plan.apply.length, skippedLow: plan.skippedLow.length };
  } catch (e) {
    if (e instanceof DecisionError) return { ok: false, error: e.code };
    throw e;
  }
}

export async function mergeAction(locale: string, targetId: string, sourceIds: string[]): Promise<ActionResult> {
  const loc = Locale.parse(locale);
  await requireOwner(loc);
  const parsed = z.object({ targetId: Id, sourceIds: z.array(Id).min(1).max(200) }).safeParse({ targetId, sourceIds });
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    await mergeCompanies(parsed.data.targetId, parsed.data.sourceIds);
  } catch (e) {
    if (e instanceof GroupingError) return { ok: false, error: e.code };
    throw e;
  }
  done(loc);
  return { ok: true };
}

export async function splitAction(locale: string, companyId: string, domain: string): Promise<ActionResult> {
  const loc = Locale.parse(locale);
  await requireOwner(loc);
  const parsed = z.object({ companyId: Id, domain: z.string().min(3).max(253) }).safeParse({ companyId, domain });
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    await splitDomain(parsed.data.companyId, parsed.data.domain);
  } catch (e) {
    if (e instanceof GroupingError) return { ok: false, error: e.code };
    throw e;
  }
  done(loc);
  return { ok: true };
}

/** "Create N drafts" (00-brief §9 M4): drafts for decided companies without an open request, then /review. */
export async function createDraftsAction(formData: FormData) {
  const loc = Locale.parse(formData.get("locale"));
  await requireOwner(loc);
  const ids = await draftableCompanyIds();
  let target = `/${loc}/review`;
  try {
    const { created, skipped } = await createDrafts(ids);
    const counts = new Map<string, number>();
    for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    const qs = new URLSearchParams({ created: String(new Set(created.map((c) => c.companyId)).size) });
    if (counts.size) qs.set("skipped", [...counts].map(([r, n]) => `${r}:${n}`).join(","));
    target = `${target}?${qs}`;
  } catch (e) {
    if (!(e instanceof DraftError)) throw e;
    target = `${target}?error=${e.code}`;
  }
  revalidatePath(`/${loc}/companies`);
  revalidatePath(`/${loc}/review`);
  redirect(target);
}
