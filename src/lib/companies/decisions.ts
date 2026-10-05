import type { DecisionValue } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { planBulkDecision, type BulkPlan } from "./bulk";

export class DecisionError extends Error {
  constructor(public code: "needs_confirm" | "not_found" | "empty") {
    super(code);
    this.name = "DecisionError";
  }
}

/** Writes Decision history rows, Company.decision and an audit entry. Marks only; never sends. */
export async function recordDecisions(ids: string[], value: DecisionValue, viaBulk: boolean): Promise<number> {
  if (!ids.length) return 0;
  await db.$transaction([
    db.decision.createMany({ data: ids.map((companyId) => ({ companyId, value, viaBulk })) }),
    db.company.updateMany({ where: { id: { in: ids } }, data: { decision: value } }),
  ]);
  await audit(viaBulk ? "decision.bulk" : "decision.set", "company", ids.length === 1 ? ids[0] : undefined, {
    value,
    count: ids.length,
    ids: ids.slice(0, 500),
  });
  await db.appEvent.create({ data: { name: "decision_set", props: { value, count: ids.length, viaBulk } } });
  return ids.length;
}

export async function decideOne(companyId: string, value: DecisionValue) {
  const c = await db.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!c) throw new DecisionError("not_found");
  await recordDecisions([companyId], value, false);
}

/**
 * Bulk decision with the server-side guards: low-confidence companies are skipped for Remove, and
 * a bulk Remove of more than 25 companies requires `confirmed`. Confidence is read from the DB, not
 * trusted from the client.
 */
export async function decideBulk(ids: string[], value: DecisionValue, confirmed: boolean): Promise<BulkPlan> {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new DecisionError("empty");
  const companies = await db.company.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, confidence: true },
  });
  const counts = await db.sender.groupBy({
    by: ["companyId"],
    where: { companyId: { in: unique }, isPersonal: false },
    _sum: { msgCount: true },
  });
  const emails = new Map(counts.map((c) => [c.companyId, c._sum.msgCount ?? 0]));
  const plan = planBulkDecision(
    companies.map((c) => ({ ...c, emailCount: emails.get(c.id) ?? 0 })),
    value,
  );
  if (plan.needsConfirm && !confirmed) throw new DecisionError("needs_confirm");
  await recordDecisions(plan.apply, value, true);
  return plan;
}
