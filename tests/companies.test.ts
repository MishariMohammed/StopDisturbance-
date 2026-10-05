import { beforeEach, describe, expect, it } from "vitest";
import type { Company, Sender } from "@prisma/client";
import { db } from "@/lib/db";
import { matchesQuery, normalizeForSearch } from "@/lib/companies/normalize";
import {
  applyFilters,
  categoryCounts,
  DEFAULT_FILTERS,
  filtersToQuery,
  groupRows,
  parseFilters,
} from "@/lib/companies/filters";
import { BULK_REMOVE_CONFIRM_OVER, planBulkDecision } from "@/lib/companies/bulk";
import { buildCompanyRow, hasEvidence, hasRecentAccountMail } from "@/lib/companies/evidence";
import { loadCompanies } from "@/lib/companies/load";
import { decideBulk, decideOne, DecisionError } from "@/lib/companies/decisions";
import { GroupingError, mergeCompanies, splitDomain } from "@/lib/companies/merge";
import { overallPercent, toAccountScan } from "@/lib/companies/scan-status";
import type { CompanyRow } from "@/lib/companies/types";
import { resetDb } from "./helpers";

const row = (over: Partial<CompanyRow>): CompanyRow => ({
  id: over.id ?? over.name ?? "x",
  name: "X",
  primaryDomain: "x.com",
  domains: ["x.com"],
  sendsAds: false,
  holdsData: false,
  confidence: "HIGH",
  decision: null,
  emailCount: 1,
  marketingCount: 0,
  transactionalCount: 0,
  firstSeen: "2024-01-01T00:00:00.000Z",
  lastSeen: "2026-09-01T00:00:00.000Z",
  subjects: [],
  reasons: [{ id: "LIST_UNSUB", method: "RULES" }],
  aiSuggested: false,
  accountIds: ["a1"],
  senderDomains: [],
  senderNames: [],
  ...over,
});

describe("Arabic search normalisation", () => {
  it("folds alef, yaa, taa marbuta, hamza carriers, diacritics, tatweel and digits", () => {
    expect(normalizeForSearch("أحمد")).toBe(normalizeForSearch("احمد"));
    expect(normalizeForSearch("إسلام")).toBe("اسلام");
    expect(normalizeForSearch("آمنة")).toBe("امنه");
    expect(normalizeForSearch("مستشفى")).toBe(normalizeForSearch("مستشفي"));
    expect(normalizeForSearch("مكتبة جرير")).toBe(normalizeForSearch("مكتبه جرير"));
    expect(normalizeForSearch("مُحَمَّد")).toBe("محمد");
    expect(normalizeForSearch("نـــون")).toBe("نون");
    expect(normalizeForSearch("٢٠٢٦")).toBe("2026");
    expect(normalizeForSearch("  Café  NOON ")).toBe("cafe noon");
  });

  it("matches every term against any field", () => {
    expect(matchesQuery(["مكتبة جرير", "jarir.com"], "مكتبه")).toBe(true);
    expect(matchesQuery(["مكتبة جرير", "jarir.com"], "جرير jarir")).toBe(true);
    expect(matchesQuery(["مكتبة جرير", "jarir.com"], "noon")).toBe(false);
    expect(matchesQuery(["Noon"], "")).toBe(true);
  });
});

describe("filters", () => {
  const rows = [
    row({ id: "ads", name: "Shein", sendsAds: true, emailCount: 50, lastSeen: "2026-10-01T00:00:00.000Z" }),
    row({ id: "data", name: "Bank", holdsData: true, emailCount: 5, confidence: "LOW", decision: "KEEP", firstSeen: "2019-01-01T00:00:00.000Z" }),
    row({ id: "both", name: "نون", sendsAds: true, holdsData: true, emailCount: 400, decision: "REMOVE", accountIds: ["a2"], domains: ["noon.com", "noon.ae"] }),
  ];
  const now = new Date("2026-10-05T00:00:00Z");

  it("round-trips through the URL, omitting defaults and rejecting junk", () => {
    const f = { ...DEFAULT_FILTERS, cat: "data" as const, sort: "recent" as const, q: "نون" };
    const qs = filtersToQuery(f);
    expect(qs).toBe(`cat=data&sort=recent&q=${encodeURIComponent("نون")}`);
    expect(parseFilters(new URLSearchParams(qs))).toEqual(f);
    expect(filtersToQuery(DEFAULT_FILTERS)).toBe("");
    expect(parseFilters({ cat: "brokers", sort: "x", decision: ["keep", "remove"] })).toEqual({ ...DEFAULT_FILTERS, decision: "keep" });
  });

  it("filters by category, decision, confidence, mailbox, search and last seen", () => {
    const ids = (f: Partial<typeof DEFAULT_FILTERS>) =>
      applyFilters(rows, { ...DEFAULT_FILTERS, ...f }, { locale: "en", now }).map((r) => r.id);
    expect(ids({})).toEqual(["both", "ads", "data"]);
    expect(ids({ cat: "ads" })).toEqual(["both", "ads"]);
    expect(ids({ cat: "data" })).toEqual(["both", "data"]);
    expect(ids({ cat: "both" })).toEqual(["both"]);
    expect(ids({ decision: "undecided" })).toEqual(["ads"]);
    expect(ids({ decision: "keep" })).toEqual(["data"]);
    expect(ids({ confidence: "low" })).toEqual(["data"]);
    expect(ids({ mailbox: "a2" })).toEqual(["both"]);
    expect(ids({ q: "noon.ae" })).toEqual(["both"]);
    expect(ids({ seen: "30d" })).toEqual(["ads"]);
    expect(ids({ sort: "oldest" })[0]).toBe("data");
    expect(ids({ sort: "az" })).toEqual(["data", "ads", "both"]);
  });

  it("counts chips under the other filters", () => {
    expect(categoryCounts(rows, DEFAULT_FILTERS, now)).toEqual({ all: 3, ads: 2, data: 2, both: 1 });
    expect(categoryCounts(rows, { ...DEFAULT_FILTERS, decision: "undecided" }, now)).toEqual({ all: 1, ads: 1, data: 0, both: 0 });
  });

  it("groups into data / marketing / kept sections", () => {
    expect(groupRows(rows).map((s) => [s.key, s.rows.map((r) => r.id)])).toEqual([
      ["data", ["both"]],
      ["marketing", ["ads"]],
      ["kept", ["data"]],
    ]);
  });
});

describe("bulk Remove eligibility", () => {
  const c = (i: number, confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH") => ({ id: `c${i}`, name: `C${i}`, confidence, emailCount: i });

  it("skips low-confidence companies for Remove only", () => {
    const list = [c(1), c(2, "LOW"), c(3, "MEDIUM")];
    expect(planBulkDecision(list, "REMOVE")).toMatchObject({ apply: ["c1", "c3"], skippedLow: ["c2"], needsConfirm: false });
    expect(planBulkDecision(list, "KEEP")).toMatchObject({ apply: ["c1", "c2", "c3"], skippedLow: [] });
  });

  it("requires confirmation above 25 eligible and names the 3 biggest", () => {
    const many = Array.from({ length: BULK_REMOVE_CONFIRM_OVER + 1 }, (_, i) => c(i + 1));
    const plan = planBulkDecision([...many, c(999, "LOW")], "REMOVE");
    expect(plan.needsConfirm).toBe(true);
    expect(plan.topNames).toEqual(["C26", "C25", "C24"]);
    expect(planBulkDecision(many.slice(0, 25), "REMOVE").needsConfirm).toBe(false);
    expect(planBulkDecision(many, "UNSUBSCRIBE").needsConfirm).toBe(false);
  });
});

const company = (over: Partial<Company> = {}): Company => ({
  id: "co", name: "Noon", primaryDomain: "noon.com", holdsData: true, sendsAds: true, isBroker: false, confidence: "HIGH",
  sector: null, jurisdiction: null, decision: null, logoPath: null, enrichedAt: null, createdAt: new Date(), updatedAt: new Date(), ...over,
});
const sender = (over: Partial<Sender> = {}): Sender => ({
  id: "s1", registrableDomain: "noon.com", displayName: "noon", companyId: "co", isEsp: false, isPersonal: false, msgCount: 10,
  marketingCount: 8, transactionalCount: 2, firstSeen: new Date("2020-01-01"), lastSeen: new Date("2026-09-01"), hasOneClick: true,
  exampleSubjects: ["Your order has shipped", "Up to 70% off", "Verify your device", "Fourth"], accountIds: ["a1"], updatedAt: new Date(), ...over,
});
const cls = (over: object = {}) => ({
  senderId: "s1", companyId: "co", method: "RULES", labels: ["ads", "holds_data"], ruleIds: ["ONE_CLICK", "TXN_SUBJECT"], createdAt: new Date(), ...over,
});

describe("evidence", () => {
  it("builds counts, seen range, ≤3 subjects and rule reasons", () => {
    const r = buildCompanyRow({ company: company(), domains: [{ domain: "noon.ae" }], senders: [sender()], classifications: [cls()] });
    expect(r).toMatchObject({ emailCount: 10, marketingCount: 8, transactionalCount: 2, domains: ["noon.com", "noon.ae"] });
    expect(r.subjects).toHaveLength(3);
    expect(r.reasons.map((x) => x.id)).toEqual(["ONE_CLICK", "TXN_SUBJECT"]);
    expect(r.firstSeen).toBe("2020-01-01T00:00:00.000Z");
    expect(hasEvidence(r)).toBe(true);
  });

  it("has no evidence without senders, messages or a settled reason", () => {
    expect(hasEvidence(buildCompanyRow({ company: company(), domains: [], senders: [], classifications: [] }))).toBe(false);
    expect(hasEvidence(buildCompanyRow({ company: company(), domains: [], senders: [sender({ msgCount: 0 })], classifications: [cls()] }))).toBe(false);
    const unsettled = cls({ labels: [], ruleIds: ["UNSETTLED"] });
    expect(hasEvidence(buildCompanyRow({ company: company(), domains: [], senders: [sender()], classifications: [unsettled] }))).toBe(false);
    const withLlm = buildCompanyRow({ company: company(), domains: [], senders: [sender()], classifications: [unsettled, cls({ method: "LLM", labels: ["ads"], ruleIds: [] })] });
    expect(withLlm.aiSuggested).toBe(true);
    expect(hasEvidence(withLlm)).toBe(true);
  });

  it("flags recent account mail for the Remove warning", () => {
    const now = new Date("2026-10-05");
    expect(hasRecentAccountMail({ holdsData: true, lastSeen: "2026-09-26T00:00:00Z" }, now)).toBe(true);
    expect(hasRecentAccountMail({ holdsData: false, lastSeen: "2026-09-26T00:00:00Z" }, now)).toBe(false);
    expect(hasRecentAccountMail({ holdsData: true, lastSeen: "2026-01-01T00:00:00Z" }, now)).toBe(false);
  });
});

describe("scan status", () => {
  it("computes per-account and overall percent", () => {
    const a = toAccountScan({ id: "1", address: "x", provider: "GOOGLE", status: "ACTIVE", scanProgress: { phase: "fetching", listed: 200, fetched: 50 } });
    const b = toAccountScan({ id: "2", address: "y", provider: "MICROSOFT", status: "ACTIVE", scanProgress: { phase: "done", listed: 10, fetched: 10 } });
    const c = toAccountScan({ id: "3", address: "z", provider: "GOOGLE", status: "ACTIVE", scanProgress: null });
    expect([a.percent, b.percent, c.percent, c.phase]).toEqual([25, 100, null, "pending"]);
    expect(overallPercent([a, b])).toBe(25);
    expect(overallPercent([b])).toBe(100);
  });
});

// ---------- DB ----------

async function seedCompany(name: string, domain: string, opts: { msgs?: number; confidence?: "HIGH" | "MEDIUM" | "LOW"; extraDomains?: string[]; evidence?: boolean } = {}) {
  const co = await db.company.create({
    data: { name, primaryDomain: domain, sendsAds: true, confidence: opts.confidence ?? "HIGH" },
  });
  await db.companyDomain.create({ data: { domain, companyId: co.id, source: "psl" } });
  for (const d of opts.extraDomains ?? []) await db.companyDomain.create({ data: { domain: d, companyId: co.id, source: "psl" } });
  if (opts.evidence === false) return co;
  for (const d of [domain, ...(opts.extraDomains ?? [])]) {
    const s = await db.sender.create({
      data: {
        registrableDomain: d, displayName: name, companyId: co.id, msgCount: opts.msgs ?? 5, marketingCount: opts.msgs ?? 5,
        firstSeen: new Date("2024-01-01"), lastSeen: new Date("2026-09-01"), exampleSubjects: [`${name} sale`], accountIds: ["acc"],
      },
    });
    await db.classification.create({
      data: { senderId: s.id, companyId: co.id, method: "RULES", labels: ["ads"], ruleIds: ["LIST_UNSUB", "ONE_CLICK"], confidence: opts.confidence ?? "HIGH" },
    });
  }
  return co;
}

describe("loadCompanies (DB)", () => {
  beforeEach(resetDb);

  it("does not return a company with zero evidence", async () => {
    await seedCompany("Noon", "noon.com");
    await seedCompany("Ghost", "ghost.com", { evidence: false });
    const rows = await loadCompanies();
    expect(rows.map((r) => r.name)).toEqual(["Noon"]);
    expect(rows[0].reasons.length).toBeGreaterThan(0);
  });
});

describe("decisions (DB)", () => {
  beforeEach(resetDb);

  it("records history rows, Company.decision and an audit entry", async () => {
    const a = await seedCompany("A", "a.com");
    await decideOne(a.id, "KEEP");
    await decideOne(a.id, "REMOVE");
    expect((await db.company.findUniqueOrThrow({ where: { id: a.id } })).decision).toBe("REMOVE");
    expect((await db.decision.findMany({ where: { companyId: a.id }, orderBy: { createdAt: "asc" } })).map((d) => [d.value, d.viaBulk])).toEqual([
      ["KEEP", false],
      ["REMOVE", false],
    ]);
    expect(await db.auditLog.count({ where: { action: "decision.set" } })).toBe(2);
  });

  it("bulk Remove skips low confidence and needs confirmation above 25", async () => {
    const hi = await seedCompany("Hi", "hi.com");
    const lo = await seedCompany("Lo", "lo.com", { confidence: "LOW" });
    const plan = await decideBulk([hi.id, lo.id], "REMOVE", false);
    expect(plan.skippedLow).toEqual([lo.id]);
    expect((await db.company.findUniqueOrThrow({ where: { id: lo.id } })).decision).toBeNull();
    expect(await db.decision.count({ where: { viaBulk: true } })).toBe(1);

    const many = [];
    for (let i = 0; i < 26; i++) many.push((await seedCompany(`M${i}`, `m${i}.com`)).id);
    await expect(decideBulk(many, "REMOVE", false)).rejects.toBeInstanceOf(DecisionError);
    expect((await decideBulk(many, "REMOVE", true)).apply).toHaveLength(26);
  });
});

describe("merge / split (DB)", () => {
  beforeEach(resetDb);

  it("merges companies with manual domain mappings and splits a domain back out", async () => {
    const noon = await seedCompany("Noon", "noon.com", { msgs: 10 });
    const noonAe = await seedCompany("Noon UAE", "noon.ae", { msgs: 3 });
    await decideOne(noonAe.id, "KEEP");
    await mergeCompanies(noon.id, [noonAe.id]);

    expect(await db.company.findUnique({ where: { id: noonAe.id } })).toBeNull();
    expect(await db.companyDomain.findUniqueOrThrow({ where: { domain: "noon.ae" } })).toMatchObject({ companyId: noon.id, source: "manual" });
    expect(await db.decision.count({ where: { companyId: noon.id } })).toBe(1);
    const [merged] = await loadCompanies();
    expect(merged).toMatchObject({ id: noon.id, emailCount: 13, domains: ["noon.com", "noon.ae"] });
    expect(await db.auditLog.count({ where: { action: "company.merge" } })).toBe(1);

    await expect(splitDomain(noon.id, "noon.com")).rejects.toBeInstanceOf(GroupingError);
    const newId = await splitDomain(noon.id, "noon.ae");
    expect(await db.companyDomain.findUniqueOrThrow({ where: { domain: "noon.ae" } })).toMatchObject({ companyId: newId, source: "manual" });
    const rows = await loadCompanies();
    expect(rows.map((r) => [r.primaryDomain, r.emailCount]).sort()).toEqual([["noon.ae", 3], ["noon.com", 10]]);
    await expect(mergeCompanies(noon.id, [noon.id])).rejects.toBeInstanceOf(GroupingError);
  });
});
