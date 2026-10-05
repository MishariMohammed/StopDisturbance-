import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { AI_MODE_KEY, OPT_OUT_KEY, type AiMode } from "@/lib/llm/gate";

// AI assist setting with the TrainingOptOutGate (04-ux §3.6, 00-review D3): DeepSeek needs the training
// opt-out confirmation with a date AND a passing "Test connection" (GET {LLM_BASE_URL}/models) for the
// current base URL and key.

export const LLM_TEST_KEY = "llmConnectionTest";
export const REPLY_AI_KEY = "replyAiEnabled";

export type AiModeResult =
  | { ok: true; mode: AiMode }
  | { ok: false; reason: "opt_out_required" | "bad_date" | "connection_test_required" };

export type ConnectionTest = { ok: boolean; at: string; baseUrl: string; keyHash: string; model: string; modelListed: boolean; status: number | null };

function keyHash(key: string) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export async function getConnectionTest(): Promise<ConnectionTest | null> {
  const row = await db.setting.findUnique({ where: { key: LLM_TEST_KEY } });
  const v = row?.value as ConnectionTest | undefined;
  return v && typeof v === "object" && typeof v.ok === "boolean" ? v : null;
}

/** True when the last test passed for the base URL and key configured now (a new key needs a new test). */
export async function connectionTestPassed(): Promise<boolean> {
  const t = await getConnectionTest();
  const e = env();
  return Boolean(t?.ok && e.DEEPSEEK_API_KEY && t.baseUrl === e.LLM_BASE_URL && t.keyHash === keyHash(e.DEEPSEEK_API_KEY));
}

/**
 * "Test connection": GET {LLM_BASE_URL}/models with the key. Sends no data other than the key.
 * The result (never the key) is stored as `llmConnectionTest`.
 */
export async function testLlmConnection(now = new Date()): Promise<ConnectionTest> {
  const e = env();
  const base: ConnectionTest = { ok: false, at: now.toISOString(), baseUrl: e.LLM_BASE_URL, keyHash: "", model: e.LLM_MODEL, modelListed: false, status: null };
  let result = base;
  if (e.DEEPSEEK_API_KEY) {
    result = { ...base, keyHash: keyHash(e.DEEPSEEK_API_KEY) };
    try {
      const res = await fetch(`${e.LLM_BASE_URL.replace(/\/+$/, "")}/models`, {
        headers: { authorization: `Bearer ${e.DEEPSEEK_API_KEY}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      result.status = res.status;
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
        result.ok = true;
        result.modelListed = Boolean(body?.data?.some((m) => m.id === e.LLM_MODEL));
      }
    } catch {
      result.status = null;
    }
  }
  await db.setting.upsert({ where: { key: LLM_TEST_KEY }, create: { key: LLM_TEST_KEY, value: result }, update: { value: result } });
  await audit("settings.llm_connection_test", "setting", LLM_TEST_KEY, { ok: result.ok, status: result.status, modelListed: result.modelListed });
  return result;
}

export async function getReplyAiEnabled(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: REPLY_AI_KEY } });
  return row?.value === true;
}

/** Reply classification by AI: separate opt-in, off by default. Turning it on needs the warning acknowledged. */
export async function setReplyAiEnabled(on: boolean, acknowledged: boolean): Promise<{ ok: boolean; reason?: "ack_required" }> {
  if (on && !acknowledged) return { ok: false, reason: "ack_required" };
  await db.setting.upsert({ where: { key: REPLY_AI_KEY }, create: { key: REPLY_AI_KEY, value: on }, update: { value: on } });
  await audit("settings.reply_ai", "setting", REPLY_AI_KEY, { value: on });
  return { ok: true };
}

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
 * give the date (stored as deepseekTrainingOptOutConfirmedAt), and a passing connection test.
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
    if (!(await connectionTestPassed())) return { ok: false, reason: "connection_test_required" };
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
