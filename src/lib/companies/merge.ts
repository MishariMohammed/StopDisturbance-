import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { refreshCompanyFlags } from "@/lib/scan/classify";

// Owner corrections to grouping (04-ux §5.1). Mappings are written with source "manual", which the
// resolver never overwrites.

export class GroupingError extends Error {
  constructor(public code: "not_found" | "too_few" | "primary_domain" | "domain_not_in_company") {
    super(code);
    this.name = "GroupingError";
  }
}

/** Merges `sourceIds` into `targetId`: domains, senders, classifications, history move; sources are deleted. */
export async function mergeCompanies(targetId: string, sourceIds: string[]): Promise<void> {
  const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);
  if (!sources.length) throw new GroupingError("too_few");
  const all = await db.company.findMany({ where: { id: { in: [targetId, ...sources] } } });
  if (all.length !== sources.length + 1) throw new GroupingError("not_found");
  const sourceCompanies = all.filter((c) => c.id !== targetId);

  await db.$transaction(async (tx) => {
    // Every domain of the merged companies (including their primary domains) now maps to the target.
    const domains = await tx.companyDomain.findMany({ where: { companyId: { in: sources } } });
    const allDomains = new Set([...domains.map((d) => d.domain), ...sourceCompanies.map((c) => c.primaryDomain)]);
    for (const domain of allDomains) {
      await tx.companyDomain.upsert({
        where: { domain },
        create: { domain, companyId: targetId, source: "manual" },
        update: { companyId: targetId, source: "manual" },
      });
    }
    const where = { companyId: { in: sources } };
    await tx.sender.updateMany({ where, data: { companyId: targetId } });
    await tx.classification.updateMany({ where, data: { companyId: targetId } });
    await tx.decision.updateMany({ where, data: { companyId: targetId } });
    await tx.companyContact.updateMany({ where, data: { companyId: targetId } });
    await tx.request.updateMany({ where, data: { companyId: targetId } });
    await tx.company.deleteMany({ where: { id: { in: sources } } });
  });
  await refreshCompanyFlags(targetId);
  await audit("company.merge", "company", targetId, {
    merged: sourceCompanies.map((c) => ({ id: c.id, domain: c.primaryDomain })),
  });
}

/** Moves one domain (and its senders) out of a company into a new company of its own. Returns the new id. */
export async function splitDomain(companyId: string, domain: string): Promise<string> {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new GroupingError("not_found");
  if (company.primaryDomain === domain) throw new GroupingError("primary_domain");
  const mapping = await db.companyDomain.findUnique({ where: { domain } });
  if (!mapping || mapping.companyId !== companyId) throw new GroupingError("domain_not_in_company");

  const newId = await db.$transaction(async (tx) => {
    const senders = await tx.sender.findMany({ where: { companyId, registrableDomain: domain } });
    const top = [...senders].sort((a, b) => b.msgCount - a.msgCount)[0];
    const label = domain.split(".")[0] ?? domain;
    const created = await tx.company.create({
      data: { primaryDomain: domain, name: top?.displayName || label.charAt(0).toUpperCase() + label.slice(1) },
    });
    await tx.companyDomain.update({ where: { domain }, data: { companyId: created.id, source: "manual" } });
    const ids = senders.map((s) => s.id);
    await tx.sender.updateMany({ where: { id: { in: ids } }, data: { companyId: created.id } });
    await tx.classification.updateMany({ where: { senderId: { in: ids } }, data: { companyId: created.id } });
    return created.id;
  });
  await refreshCompanyFlags(companyId);
  await refreshCompanyFlags(newId);
  await audit("company.split", "company", companyId, { domain, newCompanyId: newId });
  return newId;
}
