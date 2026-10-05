import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AI_MODE_KEY, OPT_OUT_KEY, type AiMode } from "@/lib/llm/gate";

// AI assist setting with the TrainingOptOutGate (04-ux §3.6, 00-review D3).

export type AiModeResult = { ok: true; mode: AiMode } | { ok: false; reason: "opt_out_required" | "bad_date" };

/** Parses a YYYY-MM-DD opt-out date; refuses future dates and dates before 2023. */
export function parseOptOutDate(input: string | null | undefined, now = new Date()): Date | null {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const d = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input) return null;
  if (d.getTime() > now.getTime() || d.getUTCFullYear() < 2023) return null;
  return d;
}

/**
 * RULES always succeeds. DEEPSEEK requires the owner to tick the training opt-out confirmation and
 * give the date; that date is stored as deepseekTrainingOptOutConfirmedAt.
 */
export async function setAiMode(
  mode: AiMode,
  gate: { confirmed: boolean; date?: string | null } = { confirmed: false },
  now = new Date(),
): Promise<AiModeResult> {
  if (mode === "DEEPSEEK") {
    if (!gate.confirmed) return { ok: false, reason: "opt_out_required" };
    const date = parseOptOutDate(gate.date, now);
    if (!date) return { ok: false, reason: "bad_date" };
    await db.$transaction([
      db.setting.upsert({ where: { key: OPT_OUT_KEY }, create: { key: OPT_OUT_KEY, value: date.toISOString() }, update: { value: date.toISOString() } }),
      db.setting.upsert({ where: { key: AI_MODE_KEY }, create: { key: AI_MODE_KEY, value: "DEEPSEEK" }, update: { value: "DEEPSEEK" } }),
    ]);
    await audit("settings.ai_mode", "setting", AI_MODE_KEY, { mode, optOutConfirmedAt: date.toISOString() });
    return { ok: true, mode };
  }
  await db.setting.upsert({ where: { key: AI_MODE_KEY }, create: { key: AI_MODE_KEY, value: "RULES" }, update: { value: "RULES" } });
  await audit("settings.ai_mode", "setting", AI_MODE_KEY, { mode: "RULES" });
  return { ok: true, mode: "RULES" };
}
