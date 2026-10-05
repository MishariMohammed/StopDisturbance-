import type { Confidence, DecisionValue } from "@prisma/client";

export type ReasonMethod = "RULES" | "LLM" | "MANUAL";

/** One reason a company is listed: a rule id (or label, for LLM/MANUAL) and where it came from. */
export type Reason = { id: string; method: ReasonMethod };

/** Everything the company list and the evidence drawer show for one company (serialisable). */
export type CompanyRow = {
  id: string;
  name: string;
  primaryDomain: string;
  /** All domains grouped into this company (CompanyDomain), primary first. */
  domains: string[];
  sendsAds: boolean;
  holdsData: boolean;
  confidence: Confidence;
  decision: DecisionValue | null;
  emailCount: number;
  marketingCount: number;
  transactionalCount: number;
  /** ISO timestamps; null only when there is no evidence (such rows are never rendered). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Up to 3 redacted example subjects. */
  subjects: string[];
  reasons: Reason[];
  /** True when any flag came from an LLM suggestion. */
  aiSuggested: boolean;
  accountIds: string[];
  senderDomains: string[];
  senderNames: string[];
};
