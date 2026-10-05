// Jurisdiction decision table: docs/03-legal.md §5 rows 1–10 (rows additive; order = citation order).
// Pure. Citations come ONLY from 03-legal; changing one is a code-review item (00-brief §7).
// M1 PDPL always; M2 GDPR/UK GDPR only on EU/UK establishment (Art. 3(1), never 3(2));
// M3 no CCPA/state law unless Owner.usState is set; M6 "to the extent applicable" when a used fact is LOW.

export type FactConfidence = "HIGH" | "MEDIUM" | "LOW";

/**
 * Keys of Company.jurisdiction.facts[] (03 §5 "Inputs"; 00-brief §5 stage 5).
 * - hq_country: ISO 3166-1 alpha-2 (e.g. "US", "IE", "SA"). Implies the matching row below unless an explicit fact overrides it.
 * - ksa_presence: boolean (KSA CR, .sa domain, SAR pricing, Arabic site, KSA representative).
 * - eu_establishment: boolean, or the EU country code of the establishment (truthy = established).
 * - uk_establishment: boolean.
 * - eu_rep / uk_rep: boolean (Art. 27 representative named in the policy; does NOT give GDPR rights, row 5).
 * - is_us_sender: boolean (US postal address or US entity).
 * - is_data_broker: boolean (informational; no citation of its own).
 * - email_type: "marketing" | "transactional" (from the classifier).
 * - local_establishment: ISO country code of an establishment in AE, BH, QA, BR, CA or IN (row 9).
 * - relevant_countries: string[] from datarequests.org (informational; not an establishment, never cites a law).
 * Several facts may share a key (different sources): the strongest truthy one wins.
 * Compatible with the values src/lib/enrich/facts.ts writes (ISO-2 strings, "tld" | "arabic_site" | ..., booleans).
 */
export type JurisdictionFactKey =
  | "hq_country"
  | "ksa_presence"
  | "eu_establishment"
  | "uk_establishment"
  | "eu_rep"
  | "uk_rep"
  | "is_us_sender"
  | "is_data_broker"
  | "email_type"
  | "local_establishment"
  | "relevant_countries";

export const JURISDICTION_FACT_KEYS: readonly JurisdictionFactKey[] = [
  "hq_country", "ksa_presence", "eu_establishment", "uk_establishment", "eu_rep", "uk_rep",
  "is_us_sender", "is_data_broker", "email_type", "local_establishment", "relevant_countries",
];

export interface JurisdictionFact {
  key: JurisdictionFactKey;
  value: boolean | string | string[] | null;
  confidence: FactConfidence;
  source: string;
}

export interface OwnerResidence {
  /** Fixed to SA for this owner (03 §5 user_residence). */
  country?: string;
  /** US state code; null unless the owner is a US-state resident. */
  usState: string | null;
}

export type Lang = "en" | "ar";

export type LawKey =
  | "PDPL" | "CST_ANTISPAM" | "GDPR" | "UK_GDPR" | "CAN_SPAM" | "CCPA" | `US_STATE_${string}`
  | "UAE_PDPL" | "BR_LGPD" | "CA_PIPEDA" | "CA_CASL" | "IN_DPDP" | "BH_PDPL" | "QA_PDPPL";

export type Regulator =
  | "SDAIA" | "CST" | "EU_SA" | "ICO" | "FTC" | "CPPA" | "STATE_AG"
  | "UAE_DATA_OFFICE" | "ANPD" | "OPC" | "IN_DPB" | "BH_PDPA" | "QA_NCGAA";

export interface JurisdictionDecision {
  /** Ordered law keys (citation order). PDPL is always first. */
  lawKeys: LawKey[];
  /** Primary escalation target. Always SDAIA (PDPL is the base law; the owner files). */
  regulator: Regulator;
  /** All escalation options in table order. */
  regulators: Regulator[];
  /** Days demanded in the letter ({{response_days}}): PDPL 30. Exact tracking deadlines come from lib/deadlines. */
  deadlineDays: number;
  /** True when any fact used to add a law was LOW, or the universal fallback was used. */
  lowConfidence: boolean;
  /** Row 10: unknown HQ / insufficient data → universal fallback wording. */
  fallback: boolean;
  /** Table rows (1–10) that fired, for the LawExplainer and tests. */
  rows: number[];
  /** EU establishment country (for the lead SA lookup), if known. */
  euCountry: string | null;
  /** Full citation string, e.g. for {{law_citations}}. */
  citationsText(lang: Lang): string;
  /** Citations other than PDPL, formatted to append after 6a-AR's hard-coded PDPL clause ({{law_citations_extra}}). */
  extraCitationsText(lang: Lang): string;
  /** One-line "why these laws" (03 S7). */
  whyLine(lang: Lang): string;
}

// ---------- Citation texts (verbatim article numbers from 03-legal §§1–5) ----------

const PDPL_EN =
  "the Saudi Personal Data Protection Law (Royal Decree M/19 of 9/2/1443H, as amended), Arts. 2, 4, 5, 18, 25 and 26, and its Implementing Regulations, Arts. 4 and 28";
const PDPL_AR =
  "نظام حماية البيانات الشخصية الصادر بالمرسوم الملكي رقم (م/19) وتاريخ 9/2/1443هـ وتعديلاته (المواد 2 و4 و5 و18 و25 و26) ولائحته التنفيذية (المادتان 4 و28)";

const STATE_NAMES: Record<string, string> = {
  CA: "California", VA: "Virginia", CO: "Colorado", CT: "Connecticut", TX: "Texas", OR: "Oregon", UT: "Utah",
  IA: "Iowa", TN: "Tennessee", MT: "Montana", DE: "Delaware", NH: "New Hampshire", NJ: "New Jersey", NE: "Nebraska",
  MD: "Maryland", MN: "Minnesota", IN: "Indiana", KY: "Kentucky", RI: "Rhode Island",
};
/** Named laws from 03 §3; other listed states get a generic reference (03 names no statute for them). */
const STATE_LAW_EN: Record<string, string> = {
  VA: "the Virginia VCDPA (Va. Code §59.1-575 et seq.)",
  CO: "the Colorado Privacy Act (CPA)",
  CT: "the Connecticut CTDPA",
  TX: "the Texas TDPSA",
  OR: "the Oregon OCPA",
};

const CITE: Record<string, { en: string; ar: string }> = {
  CST_ANTISPAM: {
    en: "the CST Regulations for Curbing Spam Messages & Calls (Decision 493/1444)",
    ar: "لائحة الحد من الرسائل والاتصالات الاقتحامية الصادرة عن هيئة الاتصالات والفضاء والتقنية (القرار 493/1444)",
  },
  GDPR: {
    en: "the EU General Data Protection Regulation (GDPR), Arts. 3(1), 7(3), 12(3), 17 and 21(2)-(3), and the applicable national ePrivacy law",
    ar: "اللائحة العامة لحماية البيانات في الاتحاد الأوروبي (GDPR)، المواد 3(1) و7(3) و12(3) و17 و21(2)-(3)، وقانون الخصوصية الإلكترونية الوطني المعمول به",
  },
  UK_GDPR: {
    en: "the UK GDPR, Arts. 3(1), 12, 17 and 21, and PECR reg. 22",
    ar: "اللائحة العامة لحماية البيانات في المملكة المتحدة (UK GDPR)، المواد 3(1) و12 و17 و21، واللائحة 22 من PECR",
  },
  CAN_SPAM: {
    en: "the US CAN-SPAM Act, 15 U.S.C. §7704(a)(4)",
    ar: "قانون CAN-SPAM الأمريكي (15 U.S.C. §7704(a)(4))",
  },
  CCPA: {
    en: "the California Consumer Privacy Act as amended by the CPRA, Cal. Civ. Code §§1798.105, 1798.120 and 1798.121",
    ar: "قانون خصوصية المستهلك في كاليفورنيا بصيغته المعدلة (CCPA/CPRA)، المواد 1798.105 و1798.120 و1798.121 من القانون المدني لكاليفورنيا",
  },
  UAE_PDPL: {
    en: "the UAE Personal Data Protection Law (Federal Decree-Law 45/2021), Arts. 15 and 17",
    ar: "قانون حماية البيانات الشخصية الإماراتي (المرسوم بقانون اتحادي رقم 45 لسنة 2021)، المادتان 15 و17",
  },
  BR_LGPD: {
    en: "the Brazilian LGPD (Law 13.709/2018), Art. 18",
    ar: "القانون البرازيلي العام لحماية البيانات (LGPD، القانون 13.709/2018)، المادة 18",
  },
  CA_PIPEDA: {
    en: "Canada's PIPEDA, Principle 4.3.8",
    ar: "القانون الكندي PIPEDA، المبدأ 4.3.8",
  },
  CA_CASL: {
    en: "Canada's CASL, s.11(3)",
    ar: "القانون الكندي لمكافحة الرسائل الاقتحامية (CASL)، المادة 11(3)",
  },
  IN_DPDP: {
    en: "India's Digital Personal Data Protection Act 2023, ss. 6(4) and 12",
    ar: "قانون حماية البيانات الشخصية الرقمية الهندي لعام 2023، المادتان 6(4) و12",
  },
  BH_PDPL: {
    en: "the Bahrain Personal Data Protection Law (Law 30/2018)",
    ar: "قانون حماية البيانات الشخصية البحريني (القانون رقم 30 لسنة 2018)",
  },
  QA_PDPPL: {
    en: "the Qatar PDPPL (Law 13/2016), Art. 22",
    ar: "قانون حماية خصوصية البيانات الشخصية القطري (القانون رقم 13 لسنة 2016)، المادة 22",
  },
};

const FALLBACK_EN =
  "any other data protection or anti-spam law that applies to you, including where applicable GDPR/UK GDPR Arts. 17 and 21, and CAN-SPAM 15 U.S.C. §7704";
const FALLBACK_AR =
  "أي نظام آخر لحماية البيانات أو مكافحة الرسائل الاقتحامية ينطبق عليكم، بما في ذلك المادتان 17 و21 من اللائحة العامة لحماية البيانات (GDPR) ونظيرتها البريطانية، وقانون CAN-SPAM الأمريكي (15 U.S.C. §7704)";

const QUALIFIER = { en: "to the extent applicable, ", ar: "بقدر ما ينطبق، " } as const;

function citeFor(law: LawKey, lang: Lang): string {
  if (law.startsWith("US_STATE_")) {
    const code = law.slice("US_STATE_".length);
    if (lang === "en") return STATE_LAW_EN[code] ?? `the consumer data privacy law of ${STATE_NAMES[code]}`;
    return `قانون خصوصية بيانات المستهلك في ولاية ${STATE_NAMES[code]}`;
  }
  return CITE[law][lang];
}

// ---------- Fact handling ----------

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT",
  "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);
const LOCAL_LAWS: Record<string, { laws: LawKey[]; regulator: Regulator; en: string; ar: string }> = {
  AE: { laws: ["UAE_PDPL"], regulator: "UAE_DATA_OFFICE", en: "the UAE", ar: "الإمارات" },
  BH: { laws: ["BH_PDPL"], regulator: "BH_PDPA", en: "Bahrain", ar: "البحرين" },
  QA: { laws: ["QA_PDPPL"], regulator: "QA_NCGAA", en: "Qatar", ar: "قطر" },
  BR: { laws: ["BR_LGPD"], regulator: "ANPD", en: "Brazil", ar: "البرازيل" },
  CA: { laws: ["CA_PIPEDA", "CA_CASL"], regulator: "OPC", en: "Canada", ar: "كندا" },
  IN: { laws: ["IN_DPDP"], regulator: "IN_DPB", en: "India", ar: "الهند" },
};
/** India DPDP data-principal rights commence 13 May 2027 (03 §4); not cited before then. */
export const IN_DPDP_RIGHTS_FROM = new Date("2027-05-13T00:00:00+03:00");

interface Signal { on: boolean; low: boolean; value: string | null }

const RANK: Record<FactConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

function truthy(v: JurisdictionFact["value"]): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim() !== "" && !["false", "no", "none"].includes(v.trim().toLowerCase());
  return false;
}

const strongest = (fs: JurisdictionFact[]) => [...fs].sort((a, b) => RANK[b.confidence] - RANK[a.confidence])[0];

function hqFact(facts: JurisdictionFact[]): JurisdictionFact | undefined {
  return strongest(facts.filter((x) => x.key === "hq_country" && typeof x.value === "string" && x.value.trim() !== ""));
}

/**
 * Strongest truthy fact for `key` wins; an explicit false (and no truthy fact) means off;
 * with no fact at all, derive from hq_country with the hq fact's confidence.
 */
function signal(facts: JurisdictionFact[], key: JurisdictionFactKey, fromHq: (hq: string) => boolean): Signal {
  const explicit = facts.filter((x) => x.key === key && x.value !== null && !Array.isArray(x.value));
  const best = strongest(explicit.filter((x) => truthy(x.value)));
  if (best) {
    return { on: true, low: best.confidence === "LOW", value: typeof best.value === "string" ? best.value.trim().toUpperCase() : null };
  }
  if (explicit.length) return { on: false, low: false, value: null };
  const hq = hqFact(facts);
  if (hq && fromHq(String(hq.value).trim().toUpperCase())) {
    return { on: true, low: hq.confidence === "LOW", value: String(hq.value).trim().toUpperCase() };
  }
  return { on: false, low: false, value: null };
}

// ---------- Decision ----------

export function decideJurisdiction(
  facts: readonly JurisdictionFact[],
  owner: OwnerResidence,
  asOf: Date = new Date(),
): JurisdictionDecision {
  const fs = [...facts];
  const laws: { key: LawKey; low: boolean }[] = [];
  const regulators: Regulator[] = [];
  const rows: number[] = [];
  const why: { en: string[]; ar: string[] } = { en: [], ar: [] };
  let anyLow = false;
  const add = (key: LawKey, low: boolean) => {
    if (laws.some((l) => l.key === key)) return;
    laws.push({ key, low });
    if (low) anyLow = true;
  };
  const reg = (r: Regulator) => { if (!regulators.includes(r)) regulators.push(r); };

  // Row 1: always (user_residence = SA).
  rows.push(1);
  add("PDPL", false);
  reg("SDAIA");
  why.en.push("You live in Saudi Arabia, so the Saudi PDPL applies to every company that handles your data.");
  why.ar.push("أنت مقيم في السعودية، لذا ينطبق نظام حماية البيانات الشخصية على أي جهة تعالج بياناتك.");

  const ksaRaw = signal(fs, "ksa_presence", (hq) => hq === "SA");
  // An Arabic site alone does not make a company KSA-based (row 2: CR/.sa/address) → conditional wording.
  const ksa = { ...ksaRaw, low: ksaRaw.low || ksaRaw.value === "ARABIC_SITE" };
  const eu = signal(fs, "eu_establishment", (hq) => EU_COUNTRIES.has(hq));
  const uk = signal(fs, "uk_establishment", (hq) => hq === "GB" || hq === "UK");
  const euRep = signal(fs, "eu_rep", () => false);
  const ukRep = signal(fs, "uk_rep", () => false);
  const us = signal(fs, "is_us_sender", (hq) => hq === "US");
  const local = signal(fs, "local_establishment", (hq) => hq in LOCAL_LAWS);
  const emailType = fs.find((f) => f.key === "email_type" && typeof f.value === "string");
  // Unknown email type → include, not exclude (03 §5), with conditional wording.
  const marketing = emailType ? { on: String(emailType.value).toLowerCase() === "marketing", low: emailType.confidence === "LOW" } : { on: true, low: true };

  // Row 2: KSA-based company.
  if (ksa.on) {
    rows.push(2);
    add("CST_ANTISPAM", ksa.low);
    reg("CST");
    why.en.push("The company is based in Saudi Arabia, so the CST anti-spam rules are added.");
    why.ar.push("الجهة قائمة في السعودية، لذا أُضيفت ضوابط هيئة الاتصالات والفضاء والتقنية لمكافحة الرسائل الاقتحامية.");
  }

  // Row 3: EU establishment (Art. 3(1) only).
  if (eu.on) {
    rows.push(3);
    add("GDPR", eu.low);
    reg("EU_SA");
    why.en.push("The company has an establishment in the EU, so GDPR protects you too (Art. 3(1)).");
    why.ar.push("للجهة منشأة في الاتحاد الأوروبي، لذا تحميك اللائحة الأوروبية أيضاً (المادة 3(1)).");
  }

  // Row 4: UK establishment.
  if (uk.on) {
    rows.push(4);
    add("UK_GDPR", uk.low);
    reg("ICO");
    why.en.push("The company is established in the UK, so UK GDPR applies.");
    why.ar.push("الجهة قائمة في المملكة المتحدة، لذا تنطبق اللائحة البريطانية.");
  }

  // Row 5: only an EU/UK representative → never claim GDPR rights.
  if ((euRep.on && !eu.on) || (ukRep.on && !uk.on)) {
    rows.push(5);
    why.en.push("It names only an EU/UK representative, which does not give a Saudi resident GDPR rights, so GDPR is not cited.");
    why.ar.push("لم تذكر الجهة سوى ممثل في أوروبا أو بريطانيا، وهذا لا يمنح المقيم في السعودية حقوقاً بموجب اللائحة الأوروبية، لذا لم نستند إليها.");
  }

  // Row 6: US sender of marketing email.
  if (us.on && marketing.on) {
    rows.push(6);
    add("CAN_SPAM", us.low || marketing.low);
    reg("FTC");
    why.en.push("It is a US sender of marketing email, so CAN-SPAM requires it to honor your opt-out within 10 business days.");
    why.ar.push("الجهة مرسل أمريكي لرسائل تسويقية، لذا يُلزمها قانون CAN-SPAM بإيقافها خلال 10 أيام عمل.");
  }

  // Row 7 / 8: US state laws only for a US-state resident (M3).
  const state = owner.usState?.toUpperCase() ?? null;
  if (state && STATE_NAMES[state]) {
    rows.push(8);
    add(state === "CA" ? "CCPA" : `US_STATE_${state}`, false);
    reg(state === "CA" ? "CPPA" : "STATE_AG");
    why.en.push(`You are a resident of ${STATE_NAMES[state]}, so its privacy law applies.`);
    why.ar.push(`أنت مقيم في ولاية ${STATE_NAMES[state]}، لذا ينطبق قانون الخصوصية فيها.`);
  } else if (us.on) {
    rows.push(7);
    why.en.push("US state privacy laws protect only their own residents, so they are not cited.");
    why.ar.push("قوانين الخصوصية في الولايات الأمريكية تحمي سكانها فقط، لذا لم نستند إليها.");
  }

  // Row 9: UAE / Bahrain / Qatar / Brazil / Canada / India establishment.
  if (local.on && local.value && LOCAL_LAWS[local.value]) {
    const l = LOCAL_LAWS[local.value];
    const lawsHere = l.laws.filter((k) => (k !== "IN_DPDP" || asOf >= IN_DPDP_RIGHTS_FROM) && (k !== "CA_CASL" || marketing.on));
    if (lawsHere.length) {
      rows.push(9);
      for (const k of lawsHere) add(k, local.low || (k === "CA_CASL" && marketing.low));
      reg(l.regulator);
      why.en.push(`The company is established in ${l.en}, so its local data protection law is added.`);
      why.ar.push(`الجهة قائمة في ${l.ar}، لذا أُضيف نظام حماية البيانات المحلي فيها.`);
    }
  }

  // Row 10: unknown HQ / insufficient data → universal fallback.
  const hqKnown = hqFact(fs) !== undefined;
  const fallback = !hqKnown && !ksa.on && !eu.on && !uk.on && !us.on && !local.on;
  if (fallback) {
    rows.push(10);
    anyLow = true;
    why.en.push("We couldn't tell where the company is based, so the request relies on Saudi law plus other laws \"to the extent applicable\".");
    why.ar.push("لم نتمكن من تحديد مقر الجهة، لذا يستند الطلب إلى النظام السعودي وأي نظام آخر «بقدر انطباقه».");
  }

  const extras = laws.filter((l) => l.key !== "PDPL");

  function extraItems(lang: Lang): string[] {
    const items = extras.map((l) => (l.low ? QUALIFIER[lang] : "") + citeFor(l.key, lang));
    if (fallback) items.push(QUALIFIER[lang] + (lang === "en" ? FALLBACK_EN : FALLBACK_AR));
    return items;
  }

  return {
    lawKeys: laws.map((l) => l.key),
    regulator: "SDAIA",
    regulators,
    deadlineDays: 30,
    lowConfidence: anyLow,
    fallback,
    rows,
    euCountry: eu.on && eu.value && EU_COUNTRIES.has(eu.value) ? eu.value : null,
    citationsText(lang) {
      return joinList([lang === "en" ? PDPL_EN : PDPL_AR, ...extraItems(lang)], lang);
    },
    extraCitationsText(lang) {
      const items = extraItems(lang);
      if (!items.length) return "";
      return lang === "en" ? `; ${joinList(items, "en")}` : `، وكذلك ${joinList(items, "ar")}`;
    },
    whyLine(lang) {
      return why[lang].join(" ");
    },
  };
}

function joinList(items: string[], lang: Lang): string {
  if (items.length <= 1) return items.join("");
  if (lang === "ar") return items.join("، و");
  return `${items.slice(0, -1).join("; ")}; and ${items[items.length - 1]}`;
}

/** Plain-language law summaries for the LawExplainer (04-ux §6.3). */
export const LAW_SUMMARIES: Record<"PDPL" | "GDPR" | "UK_GDPR" | "CAN_SPAM" | "UNKNOWN", { en: string; ar: string; deadline: { en: string; ar: string } }> = {
  PDPL: {
    en: "You can ask a company to delete your data and stop using it for marketing. They must answer within 30 days.",
    ar: "يحق لك أن تطلب من الشركة حذف بياناتك والتوقف عن استخدامها للتسويق، وعليها الرد خلال ٣٠ يومًا.",
    deadline: { en: "30 days (+30 if they notify extension)", ar: "٣٠ يومًا (+٣٠ إذا أُشعرت بالتمديد)" },
  },
  GDPR: {
    en: "You have the right to erasure and to object to marketing. They must answer within one month.",
    ar: "لك الحق في المحو والاعتراض على التسويق، وعليهم الرد خلال شهر.",
    deadline: { en: "1 month (+2 if notified)", ar: "شهر واحد (+شهران عند الإشعار)" },
  },
  UK_GDPR: {
    en: "Same rights as GDPR, for companies established in the UK. They must answer within one month.",
    ar: "نفس حقوق اللائحة الأوروبية للشركات القائمة في المملكة المتحدة، وعليهم الرد خلال شهر.",
    deadline: { en: "1 month (+2 if notified)", ar: "شهر واحد (+شهران عند الإشعار)" },
  },
  CAN_SPAM: {
    en: "US law requires them to stop marketing emails within 10 business days. It doesn't require deletion.",
    ar: "يُلزم القانون الأمريكي الشركة بإيقاف الرسائل التسويقية خلال ١٠ أيام عمل، ولا يُلزمها بالحذف.",
    deadline: { en: "10 business days (opt-out only)", ar: "١٠ أيام عمل (إيقاف التسويق فقط)" },
  },
  UNKNOWN: {
    en: "We couldn't tell which law applies. We'll send a general request based on Saudi law, plus other laws \"to the extent applicable\".",
    ar: "لم نتمكن من تحديد النظام المنطبق، وسنرسل طلبًا عامًا يستند إلى النظام السعودي وأي نظام آخر «بقدر انطباقه».",
    deadline: { en: "30 days (PDPL)", ar: "٣٠ يومًا (النظام السعودي)" },
  },
};

/** Parse Company.jurisdiction JSON leniently into facts (unknown keys / malformed rows are dropped). */
export function factsFromJson(json: unknown): JurisdictionFact[] {
  const raw = (json as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(raw)) return [];
  const keys = new Set<string>(JURISDICTION_FACT_KEYS);
  return raw.flatMap((f): JurisdictionFact[] => {
    if (!f || typeof f !== "object") return [];
    const { key, value, confidence, source } = f as Record<string, unknown>;
    if (typeof key !== "string" || !keys.has(key)) return [];
    if (confidence !== "HIGH" && confidence !== "MEDIUM" && confidence !== "LOW") return [];
    const v =
      typeof value === "boolean" || typeof value === "string"
        ? value
        : Array.isArray(value) && value.every((x) => typeof x === "string")
          ? (value as string[])
          : null;
    return [{ key: key as JurisdictionFactKey, value: v, confidence, source: typeof source === "string" ? source : "" }];
  });
}
