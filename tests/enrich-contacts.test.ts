import { readFileSync } from "node:fs";
import path from "node:path";
import type { DecisionValue } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encrypt, encryptJson } from "@/lib/crypto/tokens";
import { coverageReport, enrichCompany, enrichPending, headerChannels, oneClickUrl, parsePrivacyTxt, resolveOneClickUrl } from "@/lib/enrich/contacts";
import { clearDatasetCache, refreshDatasets } from "@/lib/enrich/datasets";
import { AI_MODE_KEY } from "@/lib/llm/gate";
import { resetDb } from "./helpers";
import { dnsModule, dnsState, host, html, netState, resetNet, setRoutes, text } from "./net-mocks";

vi.mock("node:dns/promises", async () => (await import("./net-mocks")).dnsModule);
vi.mock("undici", async () => (await import("./net-mocks")).undiciModule);

const fixture = (dir: string, name: string) => readFileSync(path.join(__dirname, "fixtures", dir, name));
const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/html" } });

async function seedDatasets() {
  for (const h of ["api.github.com", "codeload.github.com", "raw.githubusercontent.com"]) host(h);
  netState.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.github.com/")) return new Response("b".repeat(40));
    if (url.startsWith("https://codeload.github.com/")) return new Response(fixture("datasets", "datarequests-master.tar.gz"));
    return new Response(fixture("datasets", "jdm-sites.json"));
  };
  const r = await refreshDatasets();
  expect(r.errors).toEqual([]);
  resetNet();
}

async function company(domain: string, decision: DecisionValue | null = null, name = domain) {
  return db.company.create({ data: { name, primaryDomain: domain, decision } });
}

async function account() {
  const { cipher, keyVersion } = encryptJson({ access_token: "AT" });
  return db.mailAccount.create({
    data: { provider: "GOOGLE", address: "owner@gmail.com", providerUserId: "u", grantedScopes: [], tokenCipher: cipher, tokenKeyVersion: keyVersion, scanFrom: new Date("2025-01-01") },
  });
}

type HeaderOver = Partial<{
  fromAddress: string;
  listUnsubHttps: string | null;
  listUnsubMailto: string | null;
  oneClick: boolean;
  dkimPass: boolean;
  dkimCoversListUnsub: boolean;
  isMarketing: boolean;
  receivedAt: Date;
  keyVersion: number;
}>;

let seq = 0;
async function senderWithHeaders(companyId: string, domain: string, headers: HeaderOver[]) {
  const acct = (await db.mailAccount.findFirst()) ?? (await account());
  const sender = await db.sender.create({ data: { registrableDomain: domain, companyId, firstSeen: new Date(), lastSeen: new Date() } });
  const ids: string[] = [];
  for (const h of headers) {
    const row = await db.messageHeader.create({
      data: {
        accountId: acct.id,
        providerMsgId: `m${seq++}`,
        receivedAt: h.receivedAt ?? new Date("2026-09-01"),
        fromAddress: h.fromAddress ?? `news@${domain}`,
        fromDomain: domain,
        dkimDomains: [domain],
        dkimPass: h.dkimPass ?? true,
        dkimCoversListUnsub: h.dkimCoversListUnsub ?? true,
        listUnsubHttpsCipher: h.listUnsubHttps ? encrypt(h.listUnsubHttps, h.keyVersion ?? 1) : null,
        listUnsubMailto: h.listUnsubMailto ?? null,
        oneClick: h.oneClick ?? false,
        isMarketing: h.isMarketing ?? true,
        senderId: sender.id,
      },
    });
    ids.push(row.id);
  }
  return ids;
}

const kinds = (cs: { kind: string; value: string; source: string; confidence: string }[]) =>
  cs.map((c) => `${c.kind} ${c.value} ${c.source} ${c.confidence}`).sort();

describe("enrichCompany cascade", () => {
  beforeEach(async () => {
    await resetDb();
    resetNet();
    clearDatasetCache();
    await seedDatasets();
  });

  it("1. owner override wins: confirmed contact kept, no dataset email added, no network", async () => {
    const c = await company("spotify.com");
    await db.companyContact.create({
      data: { companyId: c.id, kind: "PRIVACY_EMAIL", value: "dpo@spotify.com", source: "manual", confidence: "HIGH", ownerConfirmed: true, lastVerifiedAt: new Date() },
    });
    const r = await enrichCompany(c.id);
    expect(r.settledBy).toBe("override");
    expect(r.steps).toEqual(["override", "datarequests", "justdeleteme", "headers"]);
    expect(kinds(r.contacts)).toEqual([
      "ACCOUNT_DELETE_URL https://support.spotify.com/article/close-account/ justdeleteme MEDIUM",
      "PRIVACY_EMAIL dpo@spotify.com manual HIGH",
    ]);
    expect(r.contacts.find((x) => x.kind === "PRIVACY_EMAIL")?.ownerConfirmed).toBe(true);
    expect(netState.calls).toHaveLength(0);
  });

  it("2. datarequests settles before any fetch; 3. JustDeleteMe adds the account-delete link", async () => {
    const c = await company("spotify.com", "REMOVE");
    const r = await enrichCompany(c.id);
    expect(r.settledBy).toBe("datarequests");
    expect(kinds(r.contacts)).toEqual([
      "ACCOUNT_DELETE_URL https://support.spotify.com/article/close-account/ justdeleteme MEDIUM",
      "PRIVACY_EMAIL privacy@spotify.com datarequests HIGH",
    ]);
    expect(r.facts).toEqual([
      { key: "relevant_countries", value: ["all"], confidence: "HIGH", source: "datarequests" },
      { key: "hq_country", value: "SE", confidence: "MEDIUM", source: "datarequests" },
    ]);
    expect(netState.calls).toHaveLength(0);
    const saved = await db.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.enrichedAt).not.toBeNull();
    expect((saved.jurisdiction as { facts: unknown[] }).facts).toHaveLength(2);
  });

  it("datarequests web forms carry the portal vendor", async () => {
    const c = await company("acme-shop.de");
    const r = await enrichCompany(c.id);
    const form = r.contacts.find((x) => x.kind === "WEB_FORM");
    expect(form).toMatchObject({ source: "datarequests", confidence: "HIGH", portalVendor: "onetrust" });
    expect(r.facts).toContainEqual({ key: "hq_country", value: "DE", confidence: "MEDIUM", source: "datarequests" });
  });

  it("4. /.well-known/privacy.txt is tried before the policy page", async () => {
    host("txtco.com");
    setRoutes([
      [/^https:\/\/txtco\.com\/\.well-known\/privacy\.txt$/, () => text("# privacy.txt\nContact: mailto:privacy@txtco.com\nAction-delete-personal-data: https://txtco.com/forms/delete\n")],
    ]);
    const c = await company("txtco.com");
    const r = await enrichCompany(c.id);
    expect(r.settledBy).toBe("privacy.txt");
    expect(r.steps).toEqual(["override", "datarequests", "justdeleteme", "privacy.txt", "policy", "headers"]);
    expect(kinds(r.contacts)).toEqual(["PRIVACY_EMAIL privacy@txtco.com privacy.txt HIGH", "WEB_FORM https://txtco.com/forms/delete privacy.txt HIGH"]);
    // The policy step still runs (no datarequests record) but only for jurisdiction facts.
    expect(netState.calls[0].url.pathname).toBe("/.well-known/privacy.txt");
  });

  it("5. policy page: footer link → mailto + portal (MEDIUM) + jurisdiction facts; HTML soft-404 privacy.txt ignored", async () => {
    host("shopco.com");
    host("www.shopco.com");
    setRoutes([
      [/\/\.well-known\/privacy\.txt$/, () => html("<html><body>Home</body></html>")],
      [/^https:\/\/shopco\.com\/$/, () => new Response(null, { status: 301, headers: { location: "https://www.shopco.com/" } })],
      [/^https:\/\/www\.shopco\.com\/$/, () => html(fixture("enrich", "home-en.html").toString())],
      [/^https:\/\/www\.shopco\.com\/legal\/privacy-policy$/, () => html(fixture("enrich", "policy-en.html").toString())],
    ]);
    const c = await company("shopco.com", "REMOVE");
    const r = await enrichCompany(c.id);
    expect(r.settledBy).toBe("policy");
    expect(kinds(r.contacts)).toEqual([
      "ACCOUNT_DELETE_URL https://help.shopco.com/delete-account justdeleteme MEDIUM",
      "PRIVACY_EMAIL dpo@shopco.com policy MEDIUM",
      "PRIVACY_EMAIL privacy@shopco.com policy MEDIUM",
      expect.stringMatching(/^WEB_FORM https:\/\/privacyportal\.onetrust\.com\/webform\/.* policy MEDIUM$/),
    ]);
    expect(r.contacts.find((x) => x.kind === "WEB_FORM")?.portalVendor).toBe("onetrust");
    expect(r.facts).toEqual(
      expect.arrayContaining([
        { key: "eu_establishment", value: "IE", confidence: "MEDIUM", source: "policy" },
        { key: "eu_rep", value: "DE", confidence: "MEDIUM", source: "policy" },
        { key: "is_us_sender", value: true, confidence: "MEDIUM", source: "policy" },
      ]),
    );
    expect(netState.calls.map((x) => x.url.href)).toEqual([
      "https://shopco.com/.well-known/privacy.txt",
      "https://shopco.com/",
      "https://www.shopco.com/",
      "https://www.shopco.com/legal/privacy-policy",
    ]);
    // Rules-only mode: no LLM call was logged.
    expect(await db.llmCallLog.count()).toBe(0);
  });

  it("6. guesses privacy@ then dpo@ only with MX, as LOW and not owner-confirmed (KSA site)", async () => {
    host("store.com.sa");
    dnsState.mx.set("store.com.sa", [{ exchange: "mx.store.com.sa", priority: 10 }]);
    setRoutes([
      [/\/\.well-known\/privacy\.txt$/, notFound],
      [/^https:\/\/store\.com\.sa\/$/, () => html(fixture("enrich", "home-ar.html").toString())],
      [/^https:\/\/store\.com\.sa\/ar\/%D8%B3/, () => html(fixture("enrich", "policy-ar.html").toString())],
      [/.*/, notFound],
    ]);
    const c = await company("store.com.sa", "REMOVE", "Store");
    const r = await enrichCompany(c.id);
    expect(r.settledBy).toBeNull();
    expect(r.steps).toEqual(["override", "datarequests", "justdeleteme", "privacy.txt", "policy", "guess", "headers"]);
    const guesses = r.contacts.filter((x) => x.source === "guess");
    expect(guesses.map((g) => g.value)).toEqual(["dpo@store.com.sa", "privacy@store.com.sa"]);
    for (const g of guesses) expect(g).toMatchObject({ kind: "PRIVACY_EMAIL", confidence: "LOW", mxOk: true, ownerConfirmed: false });
    expect(r.contacts.some((x) => x.value === "care@store.com.sa")).toBe(false); // not a privacy address
    expect(r.facts).toEqual(
      expect.arrayContaining([
        { key: "ksa_presence", value: "tld", confidence: "HIGH", source: "domain" },
        { key: "ksa_presence", value: "arabic_site", confidence: "MEDIUM", source: "homepage" },
        { key: "ksa_presence", value: "cr_number", confidence: "MEDIUM", source: "policy" },
      ]),
    );
    expect(dnsModule.resolveMx).toHaveBeenCalledWith("store.com.sa");
    // Network order: privacy.txt, then homepage, then the footer policy link.
    expect(netState.calls.slice(0, 3).map((x) => decodeURIComponent(x.url.pathname))).toEqual(["/.well-known/privacy.txt", "/", "/ar/سياسة-الخصوصية"]);
  });

  it("7. no MX and no site → the sender's own support address (LOW); no-reply is skipped", async () => {
    const c = await company("quiet.sa", "UNSUBSCRIBE");
    await senderWithHeaders(c.id, "quiet.sa", [
      { fromAddress: "noreply@quiet.sa" },
      { fromAddress: "noreply@quiet.sa" },
      { fromAddress: "noreply@quiet.sa" },
      { fromAddress: "care@quiet.sa", isMarketing: false },
      { fromAddress: "care@quiet.sa", isMarketing: false },
    ]);
    const r = await enrichCompany(c.id);
    expect(r.steps).toEqual(["override", "datarequests", "justdeleteme", "privacy.txt", "policy", "guess", "sender", "headers"]);
    expect(kinds(r.contacts)).toEqual(["SUPPORT_EMAIL care@quiet.sa sender LOW"]);
    expect(r.contacts[0].ownerConfirmed).toBe(false);
  });

  it("caches for 30 days; force re-runs and replaces stale non-confirmed contacts", async () => {
    host("txtco.com");
    setRoutes([[/privacy\.txt$/, () => text("Contact: privacy@txtco.com\n")], [/.*/, notFound]]);
    const c = await company("txtco.com");
    const now = new Date("2026-10-01T00:00:00Z");
    await enrichCompany(c.id, { now });
    const calls = netState.calls.length;
    const cached = await enrichCompany(c.id, { now: new Date("2026-10-20T00:00:00Z") });
    expect(cached.cached).toBe(true);
    expect(netState.calls.length).toBe(calls);
    const firstId = cached.contacts[0].id;

    setRoutes([[/privacy\.txt$/, () => text("Contact: dpo@txtco.com\nContact: privacy@txtco.com\n")], [/.*/, notFound]]);
    const later = await enrichCompany(c.id, { now: new Date("2026-11-05T00:00:00Z") });
    expect(later.cached).toBe(false);
    expect(later.contacts.map((x) => x.value).sort()).toEqual(["dpo@txtco.com", "privacy@txtco.com"]);
    expect(later.contacts.find((x) => x.value === "privacy@txtco.com")?.id).toBe(firstId); // upserted, not recreated
  });

  it("merges facts into Company.jurisdiction without touching other keys or other sources", async () => {
    const c = await db.company.create({
      data: {
        name: "Spotify",
        primaryDomain: "spotify.com",
        jurisdiction: { laws: ["PDPL"], facts: [{ key: "hq_country", value: "US", confidence: "LOW", source: "manual" }, { key: "hq_country", value: "XX", confidence: "LOW", source: "datarequests" }] },
      },
    });
    await enrichCompany(c.id);
    const j = (await db.company.findUniqueOrThrow({ where: { id: c.id } })).jurisdiction as { laws: string[]; facts: { value: unknown; source: string }[] };
    expect(j.laws).toEqual(["PDPL"]);
    expect(j.facts.map((f) => `${f.source}:${JSON.stringify(f.value)}`).sort()).toEqual(['datarequests:"SE"', 'datarequests:["all"]', 'manual:"US"']);
  });
});

describe("header channels", () => {
  const base = { id: "h1", listUnsubMailto: null, oneClick: true, dkimPass: true, dkimCoversListUnsub: true };
  const url = "https://unsub.brand.com/u/abc123?t=token";

  it("ONE_CLICK only with https + One-Click + dkim=pass + h= coverage", () => {
    expect(oneClickUrl({ ...base, listUnsubHttpsCipher: encrypt(url) })).toBe(url);
    expect(oneClickUrl({ ...base, listUnsubHttpsCipher: encrypt(url), oneClick: false })).toBeNull();
    expect(oneClickUrl({ ...base, listUnsubHttpsCipher: encrypt(url), dkimPass: false })).toBeNull();
    expect(oneClickUrl({ ...base, listUnsubHttpsCipher: encrypt(url), dkimCoversListUnsub: false })).toBeNull();
    expect(oneClickUrl({ ...base, listUnsubHttpsCipher: encrypt("http://unsub.brand.com/u") })).toBeNull();
    expect(oneClickUrl({ ...base, listUnsubHttpsCipher: null })).toBeNull();
  });

  it("MAILTO_UNSUB from List-Unsubscribe mailto; HIGH only when DKIM covers it", () => {
    const m = "mailto:unsub@brand.com?subject=unsubscribe";
    expect(headerChannels([{ ...base, listUnsubHttpsCipher: null, listUnsubMailto: m }])).toEqual([
      { kind: "MAILTO_UNSUB", value: m, source: "headers", confidence: "HIGH" },
    ]);
    expect(headerChannels([{ ...base, listUnsubHttpsCipher: null, listUnsubMailto: m, dkimCoversListUnsub: false }])[0].confidence).toBe("MEDIUM");
  });

  beforeEach(async () => {
    await resetDb();
    resetNet();
    clearDatasetCache();
    await seedDatasets();
  });

  it("stores ONE_CLICK as a header reference (never the tokenised URL) from the newest eligible header", async () => {
    const c = await company("spotify.com", "UNSUBSCRIBE");
    const [, eligible] = await senderWithHeaders(c.id, "spotify.com", [
      { listUnsubHttps: url, oneClick: true, dkimCoversListUnsub: false, receivedAt: new Date("2026-09-20") }, // newest but not covered
      { listUnsubHttps: url, oneClick: true, receivedAt: new Date("2026-09-10") },
      { listUnsubMailto: "mailto:u@spotify.com", receivedAt: new Date("2026-09-01") },
    ]);
    const r = await enrichCompany(c.id);
    const oc = r.contacts.find((x) => x.kind === "ONE_CLICK")!;
    expect(oc).toMatchObject({ value: `msg:${eligible}`, source: "headers", confidence: "HIGH" });
    expect(JSON.stringify(r.contacts)).not.toContain("token");
    expect(await resolveOneClickUrl(oc.value)).toBe(url);
    expect(r.contacts.find((x) => x.kind === "MAILTO_UNSUB")?.value).toBe("mailto:u@spotify.com");
  });

  it("no ONE_CLICK when DKIM does not cover List-Unsubscribe", async () => {
    const c = await company("spotify.com", "UNSUBSCRIBE");
    await senderWithHeaders(c.id, "spotify.com", [{ listUnsubHttps: url, oneClick: true, dkimCoversListUnsub: false }]);
    const r = await enrichCompany(c.id);
    expect(r.contacts.some((x) => x.kind === "ONE_CLICK")).toBe(false);
  });
});

describe("privacy.txt parser", () => {
  it("reads Contact and Action-* fields, ignores comments and other fields", () => {
    expect(
      parsePrivacyTxt(
        "# comment\nContact: mailto:Privacy@Example.com\nAction-opt-out-marketing: https://example.com/optout\nPolicy: https://example.com/privacy\nAction-delete-personal-data: dpo@example.com\nbogus line",
      ),
    ).toEqual({ emails: ["privacy@example.com", "dpo@example.com"], urls: ["https://example.com/optout"] });
  });
});

describe("enrichPending and coverageReport", () => {
  beforeEach(async () => {
    await resetDb();
    resetNet();
    clearDatasetCache();
    await seedDatasets();
    setRoutes([[/.*/, notFound]]);
  });

  it("enriches decided companies first and skips KEEP", async () => {
    const undecided = await company("github.com");
    const keep = await company("acme-shop.de", "KEEP");
    const remove = await company("spotify.com", "REMOVE");
    const r = await enrichPending({ limit: 1 });
    expect(r.ids).toEqual([remove.id]);
    const r2 = await enrichPending({ limit: 10 });
    expect(r2.ids).toEqual([undecided.id]);
    expect((await db.company.findUniqueOrThrow({ where: { id: keep.id } })).enrichedAt).toBeNull();
  });

  it("reports coverage of decided companies and KSA companies that fell back to guesses", async () => {
    dnsState.mx.set("store.com.sa", [{ exchange: "mx.store.com.sa", priority: 10 }]);
    const a = await company("spotify.com", "REMOVE"); // datarequests HIGH
    const b = await company("store.com.sa", "REMOVE", "Store"); // MX guess LOW
    const u = await company("quiet.sa", "UNSUBSCRIBE", "Quiet"); // mailto unsubscribe only
    await senderWithHeaders(u.id, "quiet.sa", [{ listUnsubMailto: "mailto:u@quiet.sa", fromAddress: "help@quiet.sa" }]);
    const confirmed = await company("owner-fixed.sa", "REMOVE", "Owner fixed");
    await db.companyContact.create({
      data: { companyId: confirmed.id, kind: "PRIVACY_EMAIL", value: "privacy@owner-fixed.sa", source: "guess", confidence: "LOW", ownerConfirmed: true, lastVerifiedAt: new Date() },
    });
    await company("kept.com", "KEEP");
    for (const c of [a, b, u, confirmed]) await enrichCompany(c.id);

    const rep = await coverageReport();
    expect(rep).toMatchObject({ decided: 4, covered: 3, notEnriched: 0, byDecision: { REMOVE: { decided: 3, covered: 2 }, UNSUBSCRIBE: { decided: 1, covered: 1 } } });
    expect(rep.share).toBeCloseTo(0.75);
    expect(rep.ksaGuessFallbacks.map((k) => [k.domain, k.contacts.sort()])).toEqual([
      ["store.com.sa", ["dpo@store.com.sa", "privacy@store.com.sa"]],
      ["quiet.sa", ["help@quiet.sa"]],
    ]);
  });

  it("does not call the LLM in Rules-only mode even when the policy has no email", async () => {
    await db.setting.create({ data: { key: AI_MODE_KEY, value: "RULES" } });
    host("bare.com");
    setRoutes([
      [/^https:\/\/bare\.com\/$/, () => html(`<footer><a href="/privacy">Privacy Policy</a></footer>`)],
      [/^https:\/\/bare\.com\/privacy$/, () => html(`<h1>Privacy policy</h1><p>Contact us via the app.</p>`)],
      [/.*/, notFound],
    ]);
    const c = await company("bare.com");
    const r = await enrichCompany(c.id);
    expect(r.steps).toContain("guess");
    expect(await db.llmCallLog.count()).toBe(0);
  });
});
