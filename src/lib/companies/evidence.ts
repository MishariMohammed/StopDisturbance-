import type { Classification, Company, CompanyDomain, Sender } from "@prisma/client";
import type { CompanyRow, Reason } from "./types";

// "No company appears without evidence" (04-ux §1.3): email count, seen range and the rule that tagged it.

const NOT_REASONS = new Set(["UNSETTLED", "PERSONAL_FILTER"]);
const FLAG_LABELS = new Set(["ads", "holds_data"]);

export function hasEvidence(r: Pick<CompanyRow, "emailCount" | "reasons" | "firstSeen" | "lastSeen">): boolean {
  return r.emailCount > 0 && r.reasons.length > 0 && Boolean(r.firstSeen && r.lastSeen);
}

type Cls = Pick<Classification, "senderId" | "companyId" | "method" | "labels" | "ruleIds" | "createdAt">;

/** Reasons for one sender, mirroring refreshCompanyFlags: RULES when settled, else the latest LLM suggestion. */
function senderReasons(senderId: string, cls: Cls[]): Reason[] {
  const mine = cls.filter((c) => c.senderId === senderId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const rules = mine.find((c) => c.method === "RULES");
  const settled = rules && !rules.ruleIds.includes("UNSETTLED") && rules.labels.some((l) => FLAG_LABELS.has(l));
  if (settled) return rules.ruleIds.filter((id) => !NOT_REASONS.has(id)).map((id) => ({ id, method: "RULES" }));
  const llm = mine.find((c) => c.method === "LLM");
  if (llm) return llm.labels.filter((l) => FLAG_LABELS.has(l)).map((id) => ({ id, method: "LLM" }));
  return [];
}

export function buildCompanyRow(input: {
  company: Company;
  domains: Pick<CompanyDomain, "domain">[];
  senders: Sender[];
  classifications: Cls[];
}): CompanyRow {
  const { company, senders, classifications } = input;
  const own = senders.filter((s) => !s.isPersonal);
  const reasons = new Map<string, Reason>();
  const add = (r: Reason) => reasons.set(`${r.method}:${r.id}`, r);

  const manual = classifications.filter((c) => c.method === "MANUAL");
  if (manual.length) {
    for (const c of manual) c.labels.filter((l) => FLAG_LABELS.has(l)).forEach((id) => add({ id, method: "MANUAL" }));
  }
  for (const s of own) senderReasons(s.id, classifications).forEach(add);

  let first: Date | null = null;
  let last: Date | null = null;
  const subjects: string[] = [];
  for (const s of [...own].sort((a, b) => b.msgCount - a.msgCount)) {
    if (s.msgCount > 0) {
      if (!first || s.firstSeen < first) first = s.firstSeen;
      if (!last || s.lastSeen > last) last = s.lastSeen;
    }
    for (const subj of s.exampleSubjects) if (subjects.length < 3 && !subjects.includes(subj)) subjects.push(subj);
  }

  const domainSet = new Set([company.primaryDomain, ...input.domains.map((d) => d.domain)]);
  const reasonList = [...reasons.values()];
  return {
    id: company.id,
    name: company.name,
    primaryDomain: company.primaryDomain,
    domains: [...domainSet],
    sendsAds: company.sendsAds,
    holdsData: company.holdsData,
    confidence: company.confidence,
    decision: company.decision,
    emailCount: own.reduce((n, s) => n + s.msgCount, 0),
    marketingCount: own.reduce((n, s) => n + s.marketingCount, 0),
    transactionalCount: own.reduce((n, s) => n + s.transactionalCount, 0),
    firstSeen: first?.toISOString() ?? null,
    lastSeen: last?.toISOString() ?? null,
    subjects: subjects.map((s) => (s.length > 80 ? `${s.slice(0, 79)}…` : s)),
    reasons: reasonList,
    aiSuggested: reasonList.some((r) => r.method === "LLM"),
    accountIds: [...new Set(own.flatMap((s) => s.accountIds))],
    senderDomains: [...new Set(own.map((s) => s.registrableDomain))],
    senderNames: [...new Set(own.map((s) => s.displayName).filter((n): n is string => Boolean(n)))],
  };
}

/** True when the company had account/order mail in the last 90 days (04-ux §5.6 Remove warning). */
export function hasRecentAccountMail(r: Pick<CompanyRow, "holdsData" | "lastSeen">, now = new Date()): boolean {
  return r.holdsData && Boolean(r.lastSeen) && now.getTime() - new Date(r.lastSeen!).getTime() <= 90 * 24 * 3600 * 1000;
}
