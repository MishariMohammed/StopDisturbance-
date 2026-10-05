import { db } from "@/lib/db";
import { readPayloadSample } from "@/lib/llm/client";

// Read models for /settings and /settings/data (04-ux §3.6).

export type AiCallRow = {
  id: string;
  at: Date;
  purpose: string;
  model: string;
  tokens: number;
  ok: boolean;
  fieldNames: string[];
  /** Decrypted payload sample; only filled when `reveal` is true and a sample still exists (≤20, ≤7 days). */
  payload: string | null;
  hasSample: boolean;
};

/** Last 20 AI calls. Payload values stay encrypted unless the owner explicitly reveals them. */
export async function recentAiCalls(reveal: boolean, limit = 20): Promise<AiCallRow[]> {
  const calls = await db.llmCallLog.findMany({ orderBy: [{ at: "desc" }, { id: "desc" }], take: limit });
  const samples = calls.length
    ? await db.llmPayloadSample.findMany({ where: { callId: { in: calls.map((c) => c.id) } } })
    : [];
  const byCall = new Map(samples.map((s) => [s.callId, s]));
  return calls.map((c) => {
    const sample = byCall.get(c.id);
    let payload: string | null = null;
    if (reveal && sample) {
      try {
        payload = readPayloadSample(sample.payloadCipher);
      } catch {
        payload = null;
      }
    }
    return {
      id: c.id,
      at: c.at,
      purpose: c.purpose,
      model: c.model,
      tokens: c.inTokens + c.outTokens,
      ok: c.ok,
      fieldNames: c.fieldNames,
      payload,
      hasSample: Boolean(sample),
    };
  });
}

export async function dataCounts() {
  const [mailboxes, companies, requests, openRequests, subjects] = await Promise.all([
    db.mailAccount.count({ where: { status: { not: "DISCONNECTED" } } }),
    db.company.count(),
    db.request.count(),
    db.request.count({ where: { closedAt: null } }),
    db.messageHeader.count({ where: { subject: { not: null } } }),
  ]);
  return { mailboxes, companies, requests, openRequests, subjects };
}
