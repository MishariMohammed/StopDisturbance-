import type { Company, Request } from "@prisma/client";
import { db } from "@/lib/db";
import { decideJurisdiction, factsFromJson, type JurisdictionDecision, type JurisdictionFact } from "@/lib/legal/jurisdiction";
import { countryName } from "@/lib/legal/drafts";

// Letter context for follow-ups (6b reminder, 6c complaint, 6e ID reply), built from the same sources as
// the first letter (drafts.ts): Owner, Company facts → jurisdiction, mailboxes that received the mail.

export interface CaseContext {
  request: Request;
  company: Company;
  owner: { fullName: string; country: string; countryName: string; usState: string | null };
  mailbox: { id: string; address: string } | null;
  emailAddresses: string[];
  jurisdiction: JurisdictionDecision;
}

/** Same rule as drafts.ts: the classifier's sendsAds stands in for email_type when enrichment has none. */
function withEmailType(facts: JurisdictionFact[], sendsAds: boolean): JurisdictionFact[] {
  if (facts.some((f) => f.key === "email_type")) return facts;
  return sendsAds ? [...facts, { key: "email_type", value: "marketing", confidence: "MEDIUM", source: "classifier" }] : facts;
}

export async function caseContext(request: Request): Promise<CaseContext> {
  const company = await db.company.findUniqueOrThrow({ where: { id: request.companyId } });
  const owner = await db.owner.findFirst();
  const mailbox = await db.mailAccount.findUnique({ where: { id: request.mailAccountId }, select: { id: true, address: true } });
  const senders = await db.sender.findMany({ where: { companyId: company.id }, select: { accountIds: true } });
  const accIds = [...new Set(senders.flatMap((s) => s.accountIds))];
  const boxes = accIds.length ? await db.mailAccount.findMany({ where: { id: { in: accIds } }, select: { id: true, address: true } }) : [];
  const emailAddresses = [...new Set([mailbox?.address, ...boxes.map((b) => b.address)].filter((a): a is string => Boolean(a)))];
  const jurisdiction = decideJurisdiction(
    withEmailType(factsFromJson(company.jurisdiction), company.sendsAds),
    { usState: owner?.usState ?? null },
    request.clockStart ?? request.createdAt,
  );
  return {
    request,
    company,
    owner: {
      fullName: owner?.fullName?.trim() ?? "",
      country: owner?.country ?? "SA",
      countryName: countryName(owner?.country ?? "SA"),
      usState: owner?.usState ?? null,
    },
    mailbox,
    emailAddresses,
    jurisdiction,
  };
}
