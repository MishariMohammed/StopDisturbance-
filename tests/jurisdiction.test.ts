import { describe, expect, it } from "vitest";
import {
  decideJurisdiction,
  factsFromJson,
  LAW_SUMMARIES,
  type JurisdictionFact,
  type JurisdictionFactKey,
} from "@/lib/legal/jurisdiction";

const SA = { country: "SA", usState: null };
const f = (key: JurisdictionFactKey, value: JurisdictionFact["value"], confidence: JurisdictionFact["confidence"] = "HIGH"): JurisdictionFact =>
  ({ key, value, confidence, source: "test" });
const marketing = f("email_type", "marketing");
const NOW = new Date("2026-10-05T12:00:00+03:00");

describe("03-legal §5 decision table", () => {
  it("row 1: PDPL always, SDAIA, 30 days", () => {
    const d = decideJurisdiction([f("hq_country", "JP")], SA, NOW);
    expect(d.lawKeys).toEqual(["PDPL"]);
    expect(d.rows).toEqual([1]);
    expect(d.regulator).toBe("SDAIA");
    expect(d.deadlineDays).toBe(30);
    expect(d.lowConfidence).toBe(false);
    expect(d.citationsText("en")).toBe(
      "the Saudi Personal Data Protection Law (Royal Decree M/19 of 9/2/1443H, as amended), Arts. 2, 4, 5, 18, 25 and 26, and its Implementing Regulations, Arts. 4 and 28",
    );
    expect(d.citationsText("ar")).toContain("نظام حماية البيانات الشخصية");
    expect(d.extraCitationsText("ar")).toBe("");
    expect(d.extraCitationsText("en")).toBe("");
    expect(d.whyLine("en")).toMatch(/Saudi PDPL/);
  });

  it("row 2: KSA-based company adds the CST anti-spam rules", () => {
    const d = decideJurisdiction([f("ksa_presence", "cr_number")], SA, NOW);
    expect(d.lawKeys).toEqual(["PDPL", "CST_ANTISPAM"]);
    expect(d.rows).toContain(2);
    expect(d.regulators).toEqual(["SDAIA", "CST"]);
    expect(d.citationsText("en")).toContain("CST Regulations for Curbing Spam Messages & Calls (Decision 493/1444)");
    // hq_country SA implies KSA presence too.
    expect(decideJurisdiction([f("hq_country", "sa")], SA, NOW).rows).toContain(2);
  });

  it("row 3: EU establishment adds GDPR Art. 3(1) articles and ePrivacy; lead SA", () => {
    const d = decideJurisdiction([f("eu_establishment", "IE")], SA, NOW);
    expect(d.lawKeys).toEqual(["PDPL", "GDPR"]);
    expect(d.euCountry).toBe("IE");
    expect(d.regulators).toContain("EU_SA");
    expect(d.citationsText("en")).toContain("GDPR), Arts. 3(1), 7(3), 12(3), 17 and 21(2)-(3), and the applicable national ePrivacy law");
    expect(d.citationsText("en")).not.toContain("3(2)");
    expect(decideJurisdiction([f("hq_country", "DE")], SA, NOW).lawKeys).toContain("GDPR");
    expect(decideJurisdiction([f("eu_establishment", true)], SA, NOW).euCountry).toBeNull();
  });

  it("row 4: UK establishment adds UK GDPR and PECR reg. 22; ICO", () => {
    const d = decideJurisdiction([f("uk_establishment", "GB")], SA, NOW);
    expect(d.lawKeys).toEqual(["PDPL", "UK_GDPR"]);
    expect(d.regulators).toContain("ICO");
    expect(d.citationsText("en")).toContain("the UK GDPR, Arts. 3(1), 12, 17 and 21, and PECR reg. 22");
  });

  it("row 5: only an EU/UK representative → no GDPR rights claimed", () => {
    const d = decideJurisdiction([f("hq_country", "US"), f("eu_rep", "IE"), f("uk_rep", "GB"), f("email_type", "transactional")], SA, NOW);
    expect(d.rows).toContain(5);
    expect(d.lawKeys).not.toContain("GDPR");
    expect(d.lawKeys).not.toContain("UK_GDPR");
    expect(d.citationsText("en")).not.toMatch(/GDPR/);
    expect(d.whyLine("en")).toMatch(/representative/);
    // With a real establishment the representative row does not fire.
    expect(decideJurisdiction([f("eu_establishment", "IE"), f("eu_rep", "IE")], SA, NOW).rows).not.toContain(5);
  });

  it("row 6: US marketing sender adds CAN-SPAM §7704(a)(4); FTC", () => {
    const d = decideJurisdiction([f("is_us_sender", true), marketing], SA, NOW);
    expect(d.lawKeys).toEqual(["PDPL", "CAN_SPAM"]);
    expect(d.regulators).toContain("FTC");
    expect(d.lowConfidence).toBe(false);
    expect(d.citationsText("en")).toContain("CAN-SPAM Act, 15 U.S.C. §7704(a)(4)");
    // Transactional-only US sender: no CAN-SPAM.
    expect(decideJurisdiction([f("is_us_sender", true), f("email_type", "transactional")], SA, NOW).lawKeys).toEqual(["PDPL"]);
    // Unknown email type: include, not exclude, with conditional wording.
    const unknown = decideJurisdiction([f("hq_country", "US")], SA, NOW);
    expect(unknown.lawKeys).toContain("CAN_SPAM");
    expect(unknown.lowConfidence).toBe(true);
    expect(unknown.citationsText("en")).toContain("to the extent applicable, the US CAN-SPAM Act");
  });

  it("row 7: US company and no US-state residence → no CCPA / state law", () => {
    const d = decideJurisdiction([f("hq_country", "US"), marketing], SA, NOW);
    expect(d.rows).toContain(7);
    expect(d.lawKeys.some((k) => k === "CCPA" || k.startsWith("US_STATE_"))).toBe(false);
    expect(d.citationsText("en")).not.toMatch(/California|CCPA|1798/);
    expect(d.whyLine("en")).toMatch(/US state privacy laws protect only their own residents/);
  });

  it("row 8: owner resident in a US state adds that law (CCPA §§1798.105/.120/.121 for CA)", () => {
    const ca = decideJurisdiction([f("hq_country", "US"), marketing], { usState: "ca" }, NOW);
    expect(ca.rows).toContain(8);
    expect(ca.rows).not.toContain(7);
    expect(ca.lawKeys).toEqual(["PDPL", "CAN_SPAM", "CCPA"]);
    expect(ca.regulators).toContain("CPPA");
    expect(ca.citationsText("en")).toContain("Cal. Civ. Code §§1798.105, 1798.120 and 1798.121");
    const va = decideJurisdiction([], { usState: "VA" }, NOW);
    expect(va.lawKeys).toContain("US_STATE_VA");
    expect(va.citationsText("en")).toContain("Va. Code §59.1-575 et seq.");
    expect(va.regulators).toContain("STATE_AG");
    expect(decideJurisdiction([], { usState: "UT" }, NOW).citationsText("en")).toContain("the consumer data privacy law of Utah");
    expect(decideJurisdiction([], { usState: "UT" }, NOW).citationsText("ar")).toContain("Utah");
    // A state without a listed privacy law adds nothing.
    expect(decideJurisdiction([f("hq_country", "JP")], { usState: "NY" }, NOW).lawKeys).toEqual(["PDPL"]);
  });

  it("row 9: UAE / Bahrain / Qatar / Brazil / Canada / India establishment adds the local law", () => {
    expect(decideJurisdiction([f("hq_country", "AE")], SA, NOW).lawKeys).toEqual(["PDPL", "UAE_PDPL"]);
    expect(decideJurisdiction([f("local_establishment", "BH")], SA, NOW).lawKeys).toEqual(["PDPL", "BH_PDPL"]);
    expect(decideJurisdiction([f("hq_country", "QA")], SA, NOW).citationsText("en")).toContain("Law 13/2016), Art. 22");
    expect(decideJurisdiction([f("hq_country", "BR")], SA, NOW).citationsText("en")).toContain("Law 13.709/2018), Art. 18");
    const ca = decideJurisdiction([f("hq_country", "CA"), marketing], SA, NOW);
    expect(ca.lawKeys).toEqual(["PDPL", "CA_PIPEDA", "CA_CASL"]);
    expect(ca.regulators).toContain("OPC");
    expect(decideJurisdiction([f("hq_country", "CA"), f("email_type", "transactional")], SA, NOW).lawKeys).toEqual(["PDPL", "CA_PIPEDA"]);
    // India: data-principal rights commence 13 May 2027 (03 §4).
    expect(decideJurisdiction([f("hq_country", "IN")], SA, NOW).lawKeys).toEqual(["PDPL"]);
    expect(decideJurisdiction([f("hq_country", "IN")], SA, new Date("2027-06-01")).lawKeys).toEqual(["PDPL", "IN_DPDP"]);
    expect(decideJurisdiction([f("hq_country", "AE")], SA, NOW).rows).toContain(9);
  });

  it("row 10: unknown HQ → universal fallback, conditional wording, 30 days, SDAIA", () => {
    const d = decideJurisdiction([], SA, NOW);
    expect(d.rows).toEqual([1, 10]);
    expect(d.fallback).toBe(true);
    expect(d.lawKeys).toEqual(["PDPL"]);
    expect(d.lowConfidence).toBe(true);
    expect(d.deadlineDays).toBe(30);
    expect(d.regulator).toBe("SDAIA");
    expect(d.citationsText("en")).toContain(
      "to the extent applicable, any other data protection or anti-spam law that applies to you, including where applicable GDPR/UK GDPR Arts. 17 and 21, and CAN-SPAM 15 U.S.C. §7704",
    );
    expect(d.citationsText("ar")).toContain("بقدر ما ينطبق");
    expect(d.extraCitationsText("ar").startsWith("، وكذلك ")).toBe(true);
    expect(d.whyLine("ar")).toMatch(/بقدر انطباقه/);
  });
});

describe("guards (M1–M3, M6)", () => {
  it("never cites CCPA when usState is null, whatever the facts", () => {
    const d = decideJurisdiction(
      [f("hq_country", "US"), f("is_us_sender", true), f("is_data_broker", true), marketing, f("relevant_countries", ["us", "all"])],
      SA,
      NOW,
    );
    expect(d.lawKeys).not.toContain("CCPA");
    expect(d.citationsText("en")).not.toMatch(/CCPA|California/);
  });

  it("always includes PDPL first", () => {
    const sets: JurisdictionFact[][] = [[], [f("hq_country", "US")], [f("eu_establishment", "FR"), f("uk_establishment", true)], [f("hq_country", "SA")]];
    for (const facts of sets) {
      const d = decideJurisdiction(facts, SA, NOW);
      expect(d.lawKeys[0]).toBe("PDPL");
      expect(d.citationsText("en")).toMatch(/^the Saudi Personal Data Protection Law/);
    }
  });

  it("low-confidence facts produce 'to the extent applicable' wording in EN and AR", () => {
    const d = decideJurisdiction([f("eu_establishment", "IE", "LOW"), f("is_us_sender", true), marketing], SA, NOW);
    expect(d.lowConfidence).toBe(true);
    expect(d.citationsText("en")).toContain("; to the extent applicable, the EU General Data Protection Regulation");
    expect(d.citationsText("en")).toContain("; and the US CAN-SPAM Act"); // HIGH fact stays unconditional
    expect(d.citationsText("ar")).toContain("بقدر ما ينطبق، اللائحة العامة لحماية البيانات");
    expect(d.extraCitationsText("en")).toMatch(/^; to the extent applicable/);
  });

  it("a LOW hq_country makes derived laws conditional; an Arabic site alone makes CST conditional", () => {
    expect(decideJurisdiction([f("hq_country", "DE", "LOW")], SA, NOW).citationsText("en")).toContain("to the extent applicable, the EU General");
    const ar = decideJurisdiction([f("ksa_presence", "arabic_site", "MEDIUM")], SA, NOW);
    expect(ar.citationsText("en")).toContain("to the extent applicable, the CST Regulations");
  });

  it("explicit false beats an hq-derived signal; the strongest truthy fact wins", () => {
    expect(decideJurisdiction([f("hq_country", "DE"), f("eu_establishment", false)], SA, NOW).lawKeys).not.toContain("GDPR");
    expect(decideJurisdiction([f("hq_country", "DE"), f("eu_establishment", "no")], SA, NOW).lawKeys).not.toContain("GDPR");
    const d = decideJurisdiction([f("eu_establishment", "IE", "LOW"), f("eu_establishment", "NL", "HIGH")], SA, NOW);
    expect(d.euCountry).toBe("NL");
    expect(d.lowConfidence).toBe(false);
  });

  it("rows are additive and keep citation order", () => {
    const d = decideJurisdiction(
      [f("ksa_presence", "tld"), f("eu_establishment", "IE"), f("uk_establishment", "GB"), f("is_us_sender", true), marketing, f("hq_country", "AE")],
      SA,
      NOW,
    );
    expect(d.lawKeys).toEqual(["PDPL", "CST_ANTISPAM", "GDPR", "UK_GDPR", "CAN_SPAM", "UAE_PDPL"]);
    expect(d.rows).toEqual([1, 2, 3, 4, 6, 7, 9]);
    expect(d.citationsText("ar").split("، و").length).toBeGreaterThan(5);
    expect(d.whyLine("ar")).toContain("الاتحاد الأوروبي");
  });
});

describe("factsFromJson", () => {
  it("reads Company.jurisdiction.facts leniently (enrich-module format)", () => {
    const facts = factsFromJson({
      facts: [
        { key: "hq_country", value: "IE", confidence: "HIGH", source: "datarequests" },
        { key: "relevant_countries", value: ["all"], confidence: "MEDIUM", source: "datarequests" },
        { key: "ksa_presence", value: "tld", confidence: "HIGH" },
        { key: "bogus", value: true, confidence: "HIGH", source: "x" },
        { key: "eu_rep", value: 3, confidence: "HIGH", source: "x" },
        { key: "uk_rep", value: true, confidence: "SURE", source: "x" },
        null,
      ],
      lawKeys: ["PDPL"],
    });
    expect(facts.map((x) => x.key)).toEqual(["hq_country", "relevant_countries", "ksa_presence", "eu_rep"]);
    expect(facts[2].source).toBe("");
    expect(facts[3].value).toBeNull();
    expect(factsFromJson(null)).toEqual([]);
    expect(factsFromJson({ facts: "nope" })).toEqual([]);
  });

  it("exposes the LawExplainer summaries (04-ux §6.3)", () => {
    expect(LAW_SUMMARIES.PDPL.deadline.en).toBe("30 days (+30 if they notify extension)");
    expect(LAW_SUMMARIES.UNKNOWN.ar).toContain("بقدر انطباقه");
  });
});
