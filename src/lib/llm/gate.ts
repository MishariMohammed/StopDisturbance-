import { db } from "@/lib/db";
import { env } from "@/lib/env";

// AI mode + TrainingOptOutGate (00-review D3, 03-legal M11). Default is Rules only.

export const AI_MODE_KEY = "aiMode";
export const OPT_OUT_KEY = "deepseekTrainingOptOutConfirmedAt";

export type AiMode = "RULES" | "DEEPSEEK";

export type GateStatus =
  | { ok: true; optOutConfirmedAt: Date }
  | { ok: false; reason: "rules_mode" | "no_training_opt_out" | "no_api_key" };

export class LlmGateError extends Error {
  constructor(public reason: Exclude<GateStatus, { ok: true }>["reason"]) {
    super(`LLM disabled: ${reason}`);
    this.name = "LlmGateError";
  }
}

export async function getAiMode(): Promise<AiMode> {
  const row = await db.setting.findUnique({ where: { key: AI_MODE_KEY } });
  return row?.value === "DEEPSEEK" ? "DEEPSEEK" : "RULES";
}

export async function getOptOutConfirmedAt(): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: OPT_OUT_KEY } });
  if (typeof row?.value !== "string") return null;
  const d = new Date(row.value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** All three must hold: aiMode=DEEPSEEK, a recorded training opt-out date, and an API key. */
export async function llmGate(): Promise<GateStatus> {
  if ((await getAiMode()) !== "DEEPSEEK") return { ok: false, reason: "rules_mode" };
  const optOut = await getOptOutConfirmedAt();
  if (!optOut) return { ok: false, reason: "no_training_opt_out" };
  if (!env().DEEPSEEK_API_KEY) return { ok: false, reason: "no_api_key" };
  return { ok: true, optOutConfirmedAt: optOut };
}

export async function assertLlmAllowed(): Promise<void> {
  const g = await llmGate();
  if (!g.ok) throw new LlmGateError(g.reason);
}
