import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzePolicyHtml, detectPortals, findPolicyLinks, isArabicPage, policyFacts, portalVendorFor, stripToText } from "@/lib/enrich/policy";
import { buildLlmPayload } from "@/lib/llm/payload";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures/enrich", name), "utf8");

// Real-world shaped portal links per vendor (01-research §2.3).
const PORTAL_FIXTURES: [string, string][] = [
  ["onetrust", "https://privacyportal.onetrust.com/webform/45e4be25-919b-483f-9f95-12809576a2b3/b49a8daf-a03f-46f5-8376-57e2abd162c4"],
  ["onetrust", "https://privacyportal-eu.onetrust.com/webform/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000"],
  ["onetrust", "https://acme-privacy.my.onetrust.com/webform/ddb2d1d5-0000-4000-8000-1234567890ab/abc"],
  ["trustarc", "https://submit-irm.trustarc.com/services/validation/1a2b3c4d-1111-2222-3333-444444444444"],
  ["transcend", "https://acme.privacy.transcend.io/"],
  ["ketch", "https://acme.ketch.com/privacy-rights"],
  ["datagrail", "https://preferences.datagrail.io/acme/privacy-request"],
  ["securiti", "https://privacy-central.securiti.ai/#/dsr/8e2f1a0c-0000-4000-8000-1234567890ab"],
  ["osano", "https://my.datasubject.com/ABcd1234/12345"],
];

describe("portal detection", () => {
  it.each(PORTAL_FIXTURES)("detects %s", (vendor, url) => {
    expect(portalVendorFor(url)?.vendor).toBe(vendor);
  });

  it("finds portal links inside a policy page and records script-only hints separately", () => {
    const html = `<html><body><p>Privacy policy</p>
      ${PORTAL_FIXTURES.map(([, u], i) => `<a href="${u}">Request ${i}</a>`).join("\n")}
      <form action="https://submit-irm.trustarc.com/services/validation/form"></form>
      <script src="https://global.ketchcdn.com/web/v2/config/acme/boot.js"></script>
      <a href="https://www.onetrust.com/products/">OneTrust marketing page</a>
      <a href="https://example.com/privacy">Our privacy</a></body></html>`;
    const a = analyzePolicyHtml(html, "https://acme.com/privacy");
    expect(new Set(a.portals.map((p) => p.vendor))).toEqual(new Set(["onetrust", "trustarc", "transcend", "ketch", "datagrail", "securiti", "osano"]));
    expect(a.portals.some((p) => p.url.startsWith("https://www.onetrust.com"))).toBe(false);
    expect(a.portalHints).toEqual(["ketch"]);
  });

  it("does not flag ordinary links", () => {
    expect(detectPortals(["https://acme.com/privacy", "https://twitter.com/acme", "https://onetrust.com/"]).portals).toEqual([]);
  });
});

describe("policy discovery helpers", () => {
  it("ranks footer privacy-policy links first and skips settings links", () => {
    const links = findPolicyLinks(fixture("home-en.html"), "https://www.shopco.com/");
    expect(links[0]).toBe("https://www.shopco.com/legal/privacy-policy");
    expect(links).not.toContain("https://www.shopco.com/privacy-settings");
  });

  it("finds the Arabic سياسة الخصوصية footer link and detects an Arabic site", () => {
    const html = fixture("home-ar.html");
    const links = findPolicyLinks(html, "https://store.com.sa/");
    expect(decodeURIComponent(links[0])).toBe("https://store.com.sa/ar/سياسة-الخصوصية");
    expect(isArabicPage(html)).toBe(true);
    expect(isArabicPage(fixture("home-en.html"))).toBe(false);
  });

  it("matches German Datenschutz links", () => {
    const links = findPolicyLinks(`<footer><a href="/datenschutz">Datenschutzerklärung</a><a href="/impressum">Impressum</a></footer>`, "https://acme.de/");
    expect(links).toEqual(["https://acme.de/datenschutz"]);
  });

  it("extracts privacy/DPO emails (mailto + text) but not support addresses or script content", () => {
    const a = analyzePolicyHtml(fixture("policy-en.html"), "https://www.shopco.com/legal/privacy-policy");
    expect(a.emails).toEqual([
      { address: "dpo@shopco.com", via: "mailto" },
      { address: "privacy@shopco.com", via: "text" },
    ]);
    expect(a.portals.map((p) => p.vendor)).toEqual(["onetrust"]);
    expect(a.text).not.toMatch(/privacy-script|color:red/);
    for (const addr of ["gdpr@x.eu", "dataprotection@x.com", "data-protection@x.com", "datenschutz@x.de"]) {
      expect(analyzePolicyHtml(`<a href="mailto:${addr}">x</a>`, "https://x.com/").emails.map((e) => e.address)).toEqual([addr]);
    }
  });

  it("strips to readable text with line breaks between blocks", () => {
    expect(stripToText("<div>One</div><div>Two<br>Three</div><script>x()</script>")).toBe("One\nTwo\nThree");
  });

  it("derives jurisdiction facts from policy text", () => {
    const facts = policyFacts(stripToText(fixture("policy-en.html")));
    expect(facts).toEqual(
      expect.arrayContaining([
        { key: "eu_establishment", value: "IE", confidence: "MEDIUM", source: "policy" },
        { key: "eu_rep", value: "DE", confidence: "MEDIUM", source: "policy" },
        { key: "is_us_sender", value: true, confidence: "MEDIUM", source: "policy" },
      ]),
    );
    expect(facts.some((f) => f.key === "eu_establishment" && f.value === "DE")).toBe(false);
    const ar = policyFacts(stripToText(fixture("policy-ar.html")));
    expect(ar).toEqual([{ key: "ksa_presence", value: "cr_number", confidence: "MEDIUM", source: "policy" }]);
    expect(policyFacts("Shopco UK Ltd is the data controller, registered in England and Wales.")).toEqual([
      { key: "uk_establishment", value: "GB", confidence: "MEDIUM", source: "policy" },
    ]);
    expect(policyFacts("Our controller is in Northern Ireland.")).toEqual([{ key: "uk_establishment", value: "GB", confidence: "MEDIUM", source: "policy" }]);
  });
});

describe("extractContact payload", () => {
  const ctx = { ownerNames: [] };
  it("emits exactly {domain, policyUrl, policyText}, ≤20k chars, no query string", () => {
    const p = buildLlmPayload(
      "extractContact",
      { domain: "shopco.com", policyUrl: "https://www.shopco.com/privacy?utm=x&uid=42#top", policyText: "Privacy   policy\n\n" + "a".repeat(30_000) },
      ctx,
    );
    expect(Object.keys(p).sort()).toEqual(["domain", "policyText", "policyUrl"]);
    expect(p.policyUrl).toBe("https://www.shopco.com/privacy");
    expect(p.policyText.length).toBe(20_000);
    expect(p.policyText.startsWith("Privacy policy a")).toBe(true);
  });

  it("rejects extra fields, non-https URLs and empty text", () => {
    const base = { domain: "shopco.com", policyUrl: "https://shopco.com/privacy", policyText: "text" };
    expect(() => buildLlmPayload("extractContact", { ...base, owner: "Sara" } as never, ctx)).toThrow();
    expect(() => buildLlmPayload("extractContact", { ...base, policyUrl: "http://shopco.com/privacy" }, ctx)).toThrow();
    expect(() => buildLlmPayload("extractContact", { ...base, policyText: "   " }, ctx)).toThrow();
    expect(() => buildLlmPayload("extractContact", { ...base, domain: "Not A Domain" }, ctx)).toThrow();
  });
});
