import type { Confidence } from "@prisma/client";

// Jurisdiction facts gathered during enrichment (00-brief §5 stage 5 inputs, 03-legal §5 "Inputs").
// Enrichment only records facts; src/lib/legal turns them into laws.
//
// Keys (03-legal §5):
//   hq_country          ISO-2 of the controller's postal address (datarequests address, LLM)
//   relevant_countries  string[] from datarequests `relevant-countries` (ISO-2 lower-case or "all")
//   eu_establishment    ISO-2 of an EU/EEA establishment named in the policy
//   uk_establishment    "GB" when the policy names a UK establishment/controller
//   eu_rep / uk_rep     ISO-2 of an Art. 27 representative named in the policy (not an establishment)
//   ksa_presence        "tld" | "arabic_site" | "cr_number" | "address"
//   is_us_sender        true when a US postal address appears in the policy

export type FactKey =
  | "hq_country"
  | "relevant_countries"
  | "eu_establishment"
  | "uk_establishment"
  | "eu_rep"
  | "uk_rep"
  | "ksa_presence"
  | "is_us_sender";

export type Fact = {
  key: FactKey;
  value: string | boolean | string[];
  confidence: Confidence;
  /** datarequests | domain | homepage | policy | llm_policy */
  source: string;
};

const sameFact = (a: Fact, b: Fact) => a.key === b.key && a.source === b.source && JSON.stringify(a.value) === JSON.stringify(b.value);

/** De-duplicates facts (same key + source + value), keeping the highest confidence. */
export function dedupeFacts(facts: Fact[]): Fact[] {
  const order: Record<Confidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const out: Fact[] = [];
  for (const f of facts) {
    const i = out.findIndex((o) => sameFact(o, f));
    if (i < 0) out.push(f);
    else if (order[f.confidence] < order[out[i].confidence]) out[i] = f;
  }
  return out;
}

/**
 * Merges freshly gathered facts into an existing Company.jurisdiction JSON. Facts from the sources this
 * run re-checked are replaced; facts from other sources (e.g. manual or another stage) are kept, and
 * every other top-level key of `jurisdiction` is left untouched.
 */
export function mergeJurisdiction(existing: unknown, fresh: Fact[], checkedSources: string[]): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const old = Array.isArray(base.facts) ? (base.facts as Fact[]) : [];
  const kept = old.filter((f) => !checkedSources.includes(f.source));
  base.facts = dedupeFacts([...kept, ...fresh]);
  return base;
}
