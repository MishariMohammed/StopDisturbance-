import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { toHeaderRow } from "@/lib/mail/gmail-sync";
import {
  cleanDisplayName,
  personalReason,
  resolveBatch,
  resolveHeader,
  resolvePending,
} from "@/lib/scan/resolve";
import { detectEsp, ESP_DOMAINS, type HeaderSignals } from "@/lib/scan/signals";
import { RESOLVE_FIXTURES } from "./fixtures/resolve-headers";
import { CTX, seedFixtureHeaders, seedOwnerAndAccount, toSignals } from "./scan-helpers";
import { resetDb } from "./helpers";

const outcome = (r: ReturnType<typeof resolveHeader>) =>
  r.kind === "personal" ? "personal" : r.kind === "brand" ? r.domain : null;

describe("resolve (pure) on fixtures", () => {
  const results = resolveBatch(RESOLVE_FIXTURES.map(toSignals), CTX, new Map());

  it("has at least 50 realistic samples", () => {
    expect(RESOLVE_FIXTURES.length).toBeGreaterThanOrEqual(50);
  });

  it("maps ≥95% of samples to the expected company / personal", () => {
    const wrong = RESOLVE_FIXTURES.map((f, i) => ({ name: f.name, expected: f.expected, got: outcome(results[i]) })).filter(
      (x) => x.expected !== x.got,
    );
    const accuracy = 1 - wrong.length / RESOLVE_FIXTURES.length;
    expect(wrong, `accuracy ${(accuracy * 100).toFixed(1)}%`).toEqual([]);
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it("never turns an ESP domain into a company", () => {
    for (const r of results) if (r.kind === "brand") expect(ESP_DOMAINS.has(r.domain), r.domain).toBe(false);
  });

  it("detects ESPs from Return-Path, DKIM, List-Unsubscribe and Feedback-ID", () => {
    const by = (name: string) => detectEsp(toSignals(RESOLVE_FIXTURES.find((f) => f.name === name)!))?.name;
    expect(by("Mailchimp shared From, brand DKIM")).toBe("Mailchimp");
    expect(by("Saudia via SFMC")).toBe("Salesforce Marketing Cloud");
    expect(by("Namshi via Klaviyo")).toBe("Klaviyo");
    expect(by("Spotify via SparkPost")).toBe("SparkPost");
    expect(by("Brand signed only by ESP")).toBe("SendGrid");
    expect(by("Careem receipt")).toBeUndefined();
  });

  it("uses the display-name fallback only for brands already seen", () => {
    const f = RESOLVE_FIXTURES.find((x) => x.name.startsWith("Klaviyo-only shop"))!;
    expect(resolveHeader(toSignals(f), CTX).kind).toBe("unresolved");
    expect(resolveHeader(toSignals(f), CTX, new Map([["namshi", "namshi.com"]]))).toMatchObject({
      kind: "brand", domain: "namshi.com", via: "display_name",
    });
  });

  it("cleans display names", () => {
    expect(cleanDisplayName("Noon Deals")).toBe("Noon");
    expect(cleanDisplayName("Medium Daily Digest via Substack")).toBe("Medium Daily Digest");
    expect(cleanDisplayName("🔥 SHEIN Team")).toBe("SHEIN");
  });
});

describe("personal filter", () => {
  const base = toSignals(RESOLVE_FIXTURES.find((f) => f.name === "Gmail friend")!);
  const withFrom = (fromAddress: string, extra: Partial<HeaderSignals> = {}): HeaderSignals => ({
    ...base,
    fromAddress,
    fromDomain: fromAddress.split("@")[1].split(".").slice(-2).join("."),
    ...extra,
  });

  it("free-mail individual with no list/ESP signal is personal", () => {
    expect(personalReason(withFrom("someone@gmail.com"), CTX, null)).toBe("freemail");
  });
  it("free-mail sender with List-Unsubscribe is not personal", () => {
    const h = withFrom("shop@gmail.com", { hasListUnsub: true, listUnsubMailto: "mailto:u@gmail.com" });
    expect(personalReason(h, CTX, detectEsp(h))).toBeNull();
  });
  it("sent-to correspondent on a business domain is personal", () => {
    expect(personalReason(withFrom("dr.lina@familyclinic-riyadh.com"), CTX, null)).toBe("sent_to");
  });
  it("the owner's own address and employer domain are personal, even with list headers", () => {
    expect(personalReason(withFrom("sara.alharbi@gmail.com"), CTX, null)).toBe("owner");
    const hr = withFrom("hr@acme-energy.com.sa", { fromDomain: "acme-energy.com.sa", hasListUnsub: true });
    expect(personalReason(hr, CTX, null)).toBe("owner_domain");
  });
  it("runs before brand resolution", () => {
    const h = withFrom("fahad@acme-energy.com.sa", { fromDomain: "acme-energy.com.sa", dkimDomains: ["acme-energy.com.sa"] });
    expect(resolveHeader(h, CTX).kind).toBe("personal");
  });
});

// ---------- DB step ----------

describe("resolvePending (DB)", () => {
  beforeEach(resetDb);

  it("aggregates headers into senders and companies", async () => {
    const acc = await seedOwnerAndAccount();
    await seedFixtureHeaders(acc.id);
    const stats = await resolvePending();
    expect(stats.headers).toBe(RESOLVE_FIXTURES.length);
    expect(await db.messageHeader.count({ where: { senderId: null } })).toBe(0);

    const companies = await db.company.findMany({ orderBy: { primaryDomain: "asc" } });
    const domains = companies.map((c) => c.primaryDomain);
    const expectedBrands = [...new Set(RESOLVE_FIXTURES.map((f) => f.expected).filter((e): e is string => !!e && e !== "personal"))];
    expect(domains.sort()).toEqual(expectedBrands.sort());
    for (const d of domains) expect(ESP_DOMAINS.has(d)).toBe(false);
    expect(domains).not.toContain("gmail.com");
    expect(domains).not.toContain("acme-energy.com.sa");

    const noon = await db.sender.findUniqueOrThrow({ where: { registrableDomain: "noon.com" } });
    expect(noon).toMatchObject({ msgCount: 3, hasOneClick: true, isPersonal: false, accountIds: [acc.id] });
    expect(noon.marketingCount).toBeGreaterThanOrEqual(2);
    expect(noon.transactionalCount).toBe(1);
    expect(noon.exampleSubjects.length).toBeLessThanOrEqual(3);
    expect(noon.exampleSubjects.join(" ")).toContain("[NUM]"); // order number redacted
    expect(noon.firstSeen < noon.lastSeen).toBe(true);
    const noonCo = companies.find((c) => c.primaryDomain === "noon.com")!;
    expect(noon.companyId).toBe(noonCo.id);
    expect(noonCo.name).toBe("noon");
    expect(await db.companyDomain.findUnique({ where: { domain: "noon.com" } })).toMatchObject({ source: "psl", companyId: noonCo.id });

    const gmail = await db.sender.findUniqueOrThrow({ where: { registrableDomain: "gmail.com" } });
    expect(gmail.companyId).toBeNull();
    const personalRows = await db.messageHeader.findMany({ where: { isPersonal: true } });
    expect(personalRows.length).toBe(RESOLVE_FIXTURES.filter((f) => f.expected === "personal").length);
    expect(personalRows.every((r) => !r.isMarketing && !r.isTransactional)).toBe(true);

    const mc = await db.messageHeader.findFirstOrThrow({ where: { fromAddress: "riyadhroasters@mail.mcsv.net" } });
    expect(mc).toMatchObject({ esp: "Mailchimp", isMarketing: true });
  });

  it("is incremental and never overwrites a manual CompanyDomain", async () => {
    const acc = await seedOwnerAndAccount();
    const merged = await db.company.create({ data: { name: "Noon Group", primaryDomain: "noon.ae" } });
    await db.companyDomain.create({ data: { domain: "noon.com", companyId: merged.id, source: "manual" } });
    await seedFixtureHeaders(acc.id, RESOLVE_FIXTURES.slice(0, 2));
    await resolvePending();
    expect(await db.companyDomain.findUnique({ where: { domain: "noon.com" } })).toMatchObject({ source: "manual", companyId: merged.id });
    expect((await db.sender.findUniqueOrThrow({ where: { registrableDomain: "noon.com" } })).companyId).toBe(merged.id);
    expect(await db.company.count({ where: { primaryDomain: "noon.com" } })).toBe(0);

    // A second run only processes new rows and adds to the counts.
    const extra = RESOLVE_FIXTURES.find((f) => f.name === "noon alias 2")!;
    const r = toHeaderRow(acc.id, { id: "late", threadId: "tl", labelIds: extra.labels, internalDate: String(Date.UTC(2026, 5, 1)), payload: { headers: extra.headers } });
    if (r.kind === "header") await db.messageHeader.create({ data: r.row });
    const stats = await resolvePending({ accountId: acc.id });
    expect(stats.headers).toBe(1);
    expect((await db.sender.findUniqueOrThrow({ where: { registrableDomain: "noon.com" } })).msgCount).toBe(3);
  });

  it("decrypts the List-Unsubscribe URL host for brand fallback", async () => {
    const acc = await seedOwnerAndAccount();
    await seedFixtureHeaders(acc.id, RESOLVE_FIXTURES.filter((f) => f.name === "SendGrid From + brand LU host"));
    await resolvePending();
    expect(await db.company.findUnique({ where: { primaryDomain: "bloomflowers.ae" } })).not.toBeNull();
  });
});
