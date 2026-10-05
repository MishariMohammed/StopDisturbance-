import { db } from "@/lib/db";
import { buildCompanyRow, hasEvidence } from "./evidence";
import type { CompanyRow } from "./types";

/**
 * Every company that has evidence (04-ux §1.3). Companies with no messages, no seen range or no
 * reason are dropped here, so no page can render them.
 */
export async function loadCompanies(): Promise<CompanyRow[]> {
  const [companies, domains, senders, classifications] = await Promise.all([
    db.company.findMany(),
    db.companyDomain.findMany({ select: { domain: true, companyId: true } }),
    db.sender.findMany({ where: { companyId: { not: null }, isPersonal: false } }),
    db.classification.findMany({
      where: { OR: [{ companyId: { not: null } }, { senderId: { not: null } }] },
      select: { senderId: true, companyId: true, method: true, labels: true, ruleIds: true, createdAt: true },
    }),
  ]);
  const by = <T>(rows: T[], key: (r: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(r);
      if (k) m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const domainsBy = by(domains, (d) => d.companyId);
  const sendersBy = by(senders, (s) => s.companyId);
  const senderCompany = new Map(senders.map((s) => [s.id, s.companyId!]));
  const clsBy = by(classifications, (c) => c.companyId ?? (c.senderId ? (senderCompany.get(c.senderId) ?? null) : null));
  // A sender's classification may predate a merge (companyId stale): attach it by sender too.
  for (const c of classifications) {
    const owner = c.senderId ? senderCompany.get(c.senderId) : undefined;
    if (owner && c.companyId && c.companyId !== owner) clsBy.set(owner, [...(clsBy.get(owner) ?? []), c]);
  }

  return companies
    .map((company) =>
      buildCompanyRow({
        company,
        domains: domainsBy.get(company.id) ?? [],
        senders: sendersBy.get(company.id) ?? [],
        classifications: (clsBy.get(company.id) ?? []).filter(
          (c) => c.method === "MANUAL" ? c.companyId === company.id : true,
        ),
      }),
    )
    .filter(hasEvidence);
}
