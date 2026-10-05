import { z } from "zod";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { llmGate } from "@/lib/llm/gate";
import { LlmClient } from "@/lib/llm/client";
import { buildLlmPayload, type ClassifySendersInput } from "@/lib/llm/payload";
import { ownerNameTerms } from "@/lib/llm/redact";
import { aggregateFlags, isUnsettled, minConfidence, refreshCompanyFlags } from "@/lib/scan/classify";
import { signalsFromRow } from "@/lib/scan/resolve";

// Stage 3, LLM part: senders the rules could not settle, only when the gate passes (00-brief §5).

export const LLM_BATCH_SIZE = 50;

export const SYSTEM_PROMPT = `You classify email senders for a personal privacy tool. Each input item describes one sender domain using only header flags, a display name, a message count and up to 3 redacted subjects ([NUM], [EMAIL], [URL], [NAME] are placeholders).
For each sender decide:
- "ads": it sends marketing/promotional mail (newsletters, offers).
- "holds_data": it has an account/customer relationship (orders, receipts, bookings, account or security notices).
- "personal": it is an individual person, not an organisation.
Use zero, one or two labels. Give confidence HIGH, MEDIUM or LOW.
Reply with a json object only, exactly in this shape:
{"results":[{"domain":"example.com","labels":["ads"],"confidence":"MEDIUM"}]}
Return one result per input domain, using the domain exactly as given.`;

export const classifyOutputSchema = z.object({
  results: z.array(
    z.object({
      domain: z.string(),
      labels: z.array(z.enum(["ads", "holds_data", "personal"])).max(3),
      confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    }),
  ),
});

export type ClassifyUnsettledResult =
  | { skipped: "rules_mode" | "no_training_opt_out" | "no_api_key"; classified: 0 }
  | { skipped: null; classified: number; failedBatches: number };

/** Senders whose latest RULES result is UNSETTLED, not personal, attached to a company, never manually classified. */
async function candidates() {
  const rules = await db.classification.findMany({ where: { method: "RULES", ruleIds: { has: "UNSETTLED" } } });
  const llm = await db.classification.findMany({ where: { method: "LLM" }, select: { senderId: true, createdAt: true } });
  const llmAt = new Map(llm.map((c) => [c.senderId, c.createdAt]));
  // Skip senders already suggested by the LLM since their latest rules run.
  const ids = rules
    .filter((c) => isUnsettled(c) && c.senderId && !(llmAt.get(c.senderId)! >= c.createdAt))
    .map((c) => c.senderId!);
  if (!ids.length) return [];
  const senders = await db.sender.findMany({ where: { id: { in: ids }, isPersonal: false, companyId: { not: null } } });
  const manual = await db.classification.findMany({
    where: {
      method: "MANUAL",
      OR: [{ senderId: { in: senders.map((s) => s.id) } }, { companyId: { in: senders.map((s) => s.companyId!) } }],
    },
    select: { senderId: true, companyId: true },
  });
  const blockedSenders = new Set(manual.map((m) => m.senderId));
  const blockedCompanies = new Set(manual.map((m) => m.companyId));
  return senders.filter((s) => !blockedSenders.has(s.id) && !blockedCompanies.has(s.companyId));
}

export async function classifyUnsettled(): Promise<ClassifyUnsettledResult> {
  // Gate first: in Rules-only mode nothing is built, and no client (or socket) is ever created.
  const gate = await llmGate();
  if (!gate.ok) return { skipped: gate.reason, classified: 0 };

  const todo = await candidates();
  if (!todo.length) return { skipped: null, classified: 0, failedBatches: 0 };
  const owner = await db.owner.findUnique({ where: { id: "owner" } });
  const ctx = { ownerNames: ownerNameTerms(owner?.fullName ?? "") };
  const client = await LlmClient.create();

  let classified = 0;
  let failedBatches = 0;
  for (let i = 0; i < todo.length; i += LLM_BATCH_SIZE) {
    const batch = todo.slice(i, i + LLM_BATCH_SIZE);
    const input: ClassifySendersInput = { senders: [] };
    for (const s of batch) {
      const rows = await db.messageHeader.findMany({
        where: { senderId: s.id, isPersonal: false },
        orderBy: { receivedAt: "desc" },
        take: 200,
      });
      const signals = rows.map((r) => ({ ...signalsFromRow(r, { decryptListUnsub: false }), esp: r.esp }));
      const subjects = [...new Set(rows.map((r) => r.subject).filter((x): x is string => Boolean(x)))].slice(0, 20);
      input.senders.push({
        domain: s.registrableDomain,
        displayName: s.displayName,
        flags: aggregateFlags(signals),
        msgCount: s.msgCount,
        subjects: subjects.length ? subjects : s.exampleSubjects,
        isPersonal: false,
      });
    }

    try {
      const payload = buildLlmPayload("classifySenders", input, ctx);
      const { data, callId } = await client.completeJson({
        purpose: "classifySenders",
        system: SYSTEM_PROMPT,
        payload,
        schema: classifyOutputSchema,
        maxTokens: 60 * batch.length + 500,
      });
      const byDomain = new Map(batch.map((s) => [s.registrableDomain, s]));
      const companies = new Set<string>();
      for (const r of data.results) {
        const s = byDomain.get(r.domain);
        if (!s) continue; // ignore anything we didn't ask about
        byDomain.delete(r.domain);
        await db.classification.deleteMany({ where: { senderId: s.id, method: "LLM" } });
        await db.classification.create({
          data: {
            senderId: s.id,
            companyId: s.companyId,
            method: "LLM",
            labels: [...new Set(r.labels)],
            ruleIds: ["LLM_SUGGESTION"],
            // An AI suggestion is one signal source: never above MEDIUM.
            confidence: minConfidence(r.confidence, "MEDIUM"),
            llmCallId: callId,
          },
        });
        if (s.companyId) companies.add(s.companyId);
        classified++;
      }
      for (const id of companies) await refreshCompanyFlags(id);
    } catch (err) {
      // Fall back to rules for this batch; never block the scan (04-ux §3.6).
      failedBatches++;
      logger.warn({ err: (err as Error).name, batch: i / LLM_BATCH_SIZE }, "llm classify batch failed");
    }
  }
  return { skipped: null, classified, failedBatches };
}
