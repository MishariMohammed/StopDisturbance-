import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decideJurisdiction } from "@/lib/legal/jurisdiction";
import {
  assertLetterClean,
  BANNED_PHRASES,
  findBannedPhrases,
  loadTemplate,
  parseTemplate,
  renderTemplate,
  TEMPLATE_DIR,
  TemplateError,
  type TemplateId,
  type TemplateLang,
} from "@/lib/legal/render";

const j = decideJurisdiction([{ key: "eu_establishment", value: "IE", confidence: "LOW", source: "t" }], { usState: null });

const VALUES: Record<string, string> = {
  full_name: "Sara Al-Harbi",
  email_addresses: "sara@gmail.com, sara@outlook.com",
  company: "Acme",
  company_contact: "privacy@acme.example",
  law_citations: j.citationsText("en"),
  law_citations_extra: j.extraCitationsText("ar"),
  response_days: "30",
  deadline_date: "4 November 2026",
  original_send_date: "5 October 2026",
  reference_id: "SD-7F3K",
  evidence_list: "request.eml, reply.eml",
  country_of_residence: "Saudi Arabia",
  date: "5 October 2026",
  date_hijri: "24 ربيع الآخر 1448 هـ",
  reply_state: "no response",
  regulator: "SDAIA",
  company_address_part: "",
  company_domain: "acme.example",
  user_email: "sara@gmail.com",
  first_seen_date: "1 January 2025",
  reminder_date: "8 November 2026",
  response_summary: "none",
  count: "4",
  dates: "10, 12 and 15 November 2026",
  infringement_deadline: "IR Art. 4 / GDPR Art. 12(3)",
  infringement_marketing: "PDPL Art. 25–26, IR Art. 28 / GDPR Art. 21(3)",
  infringement_deletion: "PDPL Art. 4, 18 / GDPR Art. 17",
  original_subject: "Request to delete my personal data and stop direct marketing — Ref SD-7F3K",
  optional_identifier_line: "",
};

const ALL: [TemplateId, TemplateLang][] = [
  ["6a", "en"], ["6a", "ar"], ["6b", "en"], ["6b", "ar"], ["6c", "en"], ["6c", "ar"], ["6d", "en"], ["6d", "ar"], ["6e", "en"],
  ["webform", "en"], ["webform-6d", "en"],
];

describe("templates directory", () => {
  it("has exactly the expected template files, each with a version string", () => {
    const files = readdirSync(TEMPLATE_DIR).filter((x) => x.endsWith(".md")).sort();
    expect(files).toEqual(ALL.map(([id, lang]) => `${id}.${lang}.md`).sort());
    for (const [id, lang] of ALL) expect(loadTemplate(id, lang).version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("flags Arabic templates [LAWYER] in front matter, never in the letter text", () => {
    for (const [id, lang] of ALL) {
      const t = loadTemplate(id, lang);
      if (lang === "ar") {
        expect(t.lawyer, `${id}.${lang}`).toBe(true);
        expect(t.lawyerNote).toBeTruthy();
      }
      expect(t.body).not.toMatch(/LAWYER|VERIFY/);
    }
    expect(loadTemplate("6a", "en").lawyer).toBe(false);
  });

  it("6a-AR keeps the PDPL article text from 03-legal and exposes {{law_citations_extra}}", () => {
    const t = loadTemplate("6a", "ar");
    expect(t.subject).toBe("طلب إتلاف بياناتي الشخصية وإيقاف الرسائل التسويقية — المرجع {{reference_id}}");
    expect(t.body).toContain("والمادتين (4) و(28) من اللائحة التنفيذية{{law_citations_extra}}.");
    expect(t.placeholders).toEqual(expect.arrayContaining(["full_name", "date_hijri", "law_citations_extra", "deadline_date"]));
  });

  it("6d-AR keeps only paragraphs 1 and 4 of 6a-AR", () => {
    const body = loadTemplate("6d", "ar").body;
    expect(body).toContain("الرجوع عن الموافقة والاعتراض على التسويق");
    expect(body).toContain("أرجو تأكيد التنفيذ كتابياً");
    expect(body).not.toContain("الإتلاف: أطلب إتلاف");
    expect(body).not.toContain("الأطراف الأخرى");
  });
});

describe("renderTemplate", () => {
  it.each(ALL)("renders %s.%s with every placeholder filled and no banned phrase", (id, lang) => {
    const r = renderTemplate(id, lang, VALUES);
    const all = `${r.subject ?? ""}\n${r.body}`;
    expect(all).not.toContain("{{");
    expect(all).not.toContain("}}");
    expect(findBannedPhrases(all)).toEqual([]);
    if (r.subject !== null) expect(r.subject).toContain("SD-7F3K");
    expect(r.templateVersion).toBe(loadTemplate(id, lang).version);
  });

  it("6a subject carries 'Ref SD-XXXX' and the body has the citations and both addresses", () => {
    const r = renderTemplate("6a", "en", VALUES);
    expect(r.subject).toBe("Request to delete my personal data and stop direct marketing — Ref SD-7F3K");
    expect(r.body).toContain("make this request under the Saudi Personal Data Protection Law");
    expect(r.body).toContain("to the extent applicable, the EU General Data Protection Regulation");
    expect(r.body).toContain("Email addresses this request covers: sara@gmail.com, sara@outlook.com");
    expect(r.body).not.toMatch(/\*\*|^>/m);
  });

  it("6e drops an empty optional identifier line cleanly", () => {
    const r = renderTemplate("6e", "en", VALUES);
    expect(r.body).toMatch(/clicking a confirmation link\.\n/);
  });

  it("throws when a placeholder is left unfilled", () => {
    const { reference_id: _, ...rest } = VALUES;
    void _;
    expect(() => renderTemplate("6a", "en", rest)).toThrow(/Unfilled placeholders: reference_id/);
  });

  it("throws when a value introduces a banned phrase (EN and AR)", () => {
    expect(() => renderTemplate("6a", "en", { ...VALUES, full_name: "Sara, on behalf of my family" })).toThrow(TemplateError);
    expect(() => renderTemplate("6a", "ar", { ...VALUES, company: "Acme نيابة عن" })).toThrow(/Banned/);
    expect(() => renderTemplate("6d", "en", { ...VALUES, company: "Acme via StopDisturbance" })).toThrow(/Banned/);
    expect(() => renderTemplate("6d", "en", { ...VALUES, company: "Authorized Agent Co" })).toThrow(/Banned/);
  });

  it("throws when the subject lacks a SD- reference", () => {
    expect(() => renderTemplate("6a", "en", { ...VALUES, reference_id: "1234" })).toThrow(/reference/);
  });

  it("the banned-phrase list covers the 03-legal §8 / M5 phrases", () => {
    expect(BANNED_PHRASES).toEqual(expect.arrayContaining(["on behalf of", "via stopdisturbance", "authorized agent", "نيابة عن"]));
    expect(findBannedPhrases("Sent ON BEHALF OF x")).toEqual(["on behalf of"]);
  });
});

describe("parseTemplate", () => {
  it("rejects files without front matter or required keys", () => {
    expect(() => parseTemplate("Subject: x\n\nbody")).toThrow(/front matter/);
    expect(() => parseTemplate("---\nid: x\n---\nbody")).toThrow(/lacks lang/);
    expect(() => loadTemplate("nope" as TemplateId, "en")).toThrow(/No template/);
  });

  it("parses a template without a subject (6c)", () => {
    const raw = readFileSync(path.join(TEMPLATE_DIR, "6c.en.md"), "utf8");
    const t = parseTemplate(raw);
    expect(t.subject).toBeNull();
    expect(t.body.startsWith("Complaint against: {{company}}")).toBe(true);
  });

  it("assertLetterClean reports stray braces", () => {
    expect(() => assertLetterClean({ subject: null, body: "x }} y" })).toThrow(/Unfilled/);
  });
});
