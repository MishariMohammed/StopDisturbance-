import type { Confidence, DecisionValue } from "@prisma/client";

// Guards against accidental mass decisions (04-ux §5.5, §5.7).

export const BULK_REMOVE_CONFIRM_OVER = 25;

export type BulkCandidate = { id: string; name: string; confidence: Confidence; emailCount: number };

export type BulkPlan = {
  /** Ids the decision will be applied to. */
  apply: string[];
  /** Low-confidence ids skipped (bulk Remove only). */
  skippedLow: string[];
  /** Bulk Remove of more than 25 companies needs an explicit confirmation. */
  needsConfirm: boolean;
  /** The 3 biggest companies (by email count) among `apply`, for the confirmation text. */
  topNames: string[];
};

/** Low-confidence companies can't be bulk-marked Remove; they are reviewed individually. */
export function bulkRemoveEligible(c: Pick<BulkCandidate, "confidence">): boolean {
  return c.confidence !== "LOW";
}

export function planBulkDecision(candidates: BulkCandidate[], value: DecisionValue): BulkPlan {
  const remove = value === "REMOVE";
  const applyRows = remove ? candidates.filter(bulkRemoveEligible) : candidates;
  const skippedLow = remove ? candidates.filter((c) => !bulkRemoveEligible(c)).map((c) => c.id) : [];
  const topNames = [...applyRows]
    .sort((a, b) => b.emailCount - a.emailCount || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((c) => c.name);
  return {
    apply: applyRows.map((c) => c.id),
    skippedLow,
    needsConfirm: remove && applyRows.length > BULK_REMOVE_CONFIRM_OVER,
    topNames,
  };
}
