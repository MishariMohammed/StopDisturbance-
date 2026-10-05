import * as cheerio from "cheerio";
import { z } from "zod";
import portalData from "../../../data/portal-patterns.json";
import { logger } from "@/lib/logger";
import { LlmClient } from "@/lib/llm/client";
import { llmGate } from "@/lib/llm/gate";
import { buildLlmPayload } from "@/lib/llm/payload";
import { registrableDomain } from "@/lib/mail/headers";
import { safeFetch, type SafeResponse } from "@/lib/net/safe-fetch";
import { EU_COUNTRIES, EEA_EXTRA, countryNamePatterns } from "@/lib/enrich/countries";
import type { Fact } from "@/lib/enrich/facts";

// Privacy-policy discovery and parsing (00-brief §5 stage 4, 01-research §2.3–2.4).

type CheerioRoot = ReturnType<typeof cheerio.load>;

// ---------- portal vendors ----------

type Vendor = { id: string; name: string; links: RegExp[]; scripts: RegExp[] };
const VENDORS: Vendor[] = portalData.vendors.map((v) => ({
  id: v.id,
  name: v.name,
  links: v.links.map((p) => new RegExp(p, "i")),
  scripts: v.scripts.map((p) => new RegExp(p, "i")),
}));

export type PortalMatch = { vendor: string; name: string; url: string };

/** The portal vendor a request-form URL belongs to, or null. */
export function portalVendorFor(url: string): PortalMatch | null {
  for (const v of VENDORS) if (v.links.some((re) => re.test(url))) return { vendor: v.id, name: v.name, url };
  return null;
}

/** Vendor link matches (WEB_FORM candidates) and script-only hints, from absolute URLs on a page. */
export function detectPortals(links: string[], scripts: string[] = []): { portals: PortalMatch[]; hints: string[] } {
  const portals: PortalMatch[] = [];
  const seen = new Set<string>();
  for (const url of links) {
    const m = portalVendorFor(url);
    if (m && !seen.has(m.url)) {
      seen.add(m.url);
      portals.push(m);
    }
  }
  const hints = VENDORS.filter((v) => scripts.some((s) => v.scripts.some((re) => re.test(s)))).map((v) => v.id);
  return { portals, hints };
}

// ---------- links ----------

const PRIVACY_LINK_TEXT =
  /privacy|privacidad|privacidade|confidentialit|datenschutz|privatsph(ä|ae)re|gegevensbescherming|protezione dei dati|tietosuoja|integritetspolicy|personvern|سياسة الخصوصية|الخصوصية|حماية البيانات/iu;
const PRIVACY_LINK_HREF = /privacy|datenschutz|privacidad|confidentialit|data-?protection|privacybeleid|الخصوصية|%d8%a7%d9%84%d8%ae%d8%b5%d9%88%d8%b5%d9%8a%d8%a9/i;
const POLICY_WORD = /policy|notice|statement|erkl(ä|ae)rung|politique|pol[ií]tica|سياسة|إشعار/iu;
const NOT_POLICY = /settings|choices|preferences|do not sell|opt[- ]?out|manage|ad ?choices|إعدادات|تفضيلات/i;

function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function inFooter($: CheerioRoot, el: Parameters<CheerioRoot>[0]): boolean {
  return $(el)
    .parents()
    .toArray()
    .some((p) => {
      const node = $(p);
      const tag = (p as { tagName?: string }).tagName?.toLowerCase();
      return tag === "footer" || node.attr("role") === "contentinfo" || /footer/i.test(`${node.attr("id") ?? ""} ${node.attr("class") ?? ""}`);
    });
}

/** Ranked privacy-policy link candidates from a homepage (footer links first). */
export function findPolicyLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const baseDomain = registrableDomain(new URL(baseUrl).hostname);
  const scored = new Map<string, number>();
  $("a[href]").each((_, el) => {
    const url = absolute($(el).attr("href"), baseUrl);
    if (!url) return;
    const text = `${$(el).text()} ${$(el).attr("title") ?? ""} ${$(el).attr("aria-label") ?? ""}`.replace(/\s+/g, " ").trim();
    const textHit = PRIVACY_LINK_TEXT.test(text);
    const hrefHit = PRIVACY_LINK_HREF.test(new URL(url).pathname + new URL(url).hostname);
    if (!textHit && !hrefHit) return;
    let score = (textHit ? 2 : 0) + (hrefHit ? 1 : 0);
    if (inFooter($, el)) score += 3;
    if (POLICY_WORD.test(text)) score += 2;
    if (NOT_POLICY.test(text)) score -= 4;
    if (registrableDomain(new URL(url).hostname) === baseDomain) score += 1;
    const key = url.replace(/#.*$/, "");
    scored.set(key, Math.max(scored.get(key) ?? -Infinity, score));
  });
  return [...scored.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([u]) => u);
}

// ---------- page analysis ----------

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export const PRIVACY_EMAIL_RE = /privacy|dpo|gdpr|dataprotection|data[-._]protection|datenschutz|dsgvo/i;

/** Visible text: scripts/styles removed, block elements on their own lines, whitespace collapsed. */
export function stripToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, template, iframe, head").remove();
  $("br, p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, footer, header, address, dd, dt").each((_, el) => {
    $(el).append("\n");
  });
  return $.root()
    .text()
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export type PolicyAnalysis = {
  text: string;
  emails: { address: string; via: "mailto" | "text" }[];
  portals: PortalMatch[];
  portalHints: string[];
  links: string[];
};

export function analyzePolicyHtml(html: string, url: string): PolicyAnalysis {
  const $ = cheerio.load(html);
  const links: string[] = [];
  const scripts: string[] = [];
  const emails = new Map<string, "mailto" | "text">();
  $("a[href], area[href]").each((_, el) => {
    const href = $(el).attr("href")?.trim() ?? "";
    if (/^mailto:/i.test(href)) {
      const addr = decodeURIComponent(href.slice(7).split("?")[0]).trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(addr) && PRIVACY_EMAIL_RE.test(addr)) emails.set(addr, "mailto");
      return;
    }
    const abs = absolute(href, url);
    if (abs) links.push(abs);
  });
  $("form[action]").each((_, el) => {
    const abs = absolute($(el).attr("action"), url);
    if (abs) links.push(abs);
  });
  $("iframe[src]").each((_, el) => {
    const abs = absolute($(el).attr("src"), url);
    if (abs) links.push(abs);
  });
  $("script[src]").each((_, el) => {
    const abs = absolute($(el).attr("src"), url);
    if (abs) scripts.push(abs);
  });
  const text = stripToText(html);
  for (const m of text.matchAll(EMAIL_RE)) {
    const addr = m[0].replace(/\.$/, "").toLowerCase();
    if (PRIVACY_EMAIL_RE.test(addr) && !emails.has(addr)) emails.set(addr, "text");
  }
  const { portals, hints } = detectPortals(links, scripts);
  return { text, emails: [...emails].map(([address, via]) => ({ address, via })), portals, portalHints: hints, links };
}

// ---------- jurisdiction facts from text ----------

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const US_ADDRESS = new RegExp(`(?:,\\s*|\\s)(?:${US_STATES})\\s+\\d{5}(?:-\\d{4})?\\b`);
const REP_RE = /representative|article\s*27|art\.\s*27|vertreter|ممثل/i;
const CONTROLLER_RE =
  /controller|responsible for (?:the )?process|verantwortlich|registered (?:office|address|in)|established in|incorporated in|headquarter|principal place of business|main establishment|المسؤول عن|مقرها|مقره/i;
const CR_RE = /(?:commercial registration|\bC\.?R\.?\s*(?:No\.?|Number|#)|السجل التجاري|سجل تجاري)\D{0,20}[0-9٠-٩]{10}/i;
const KSA_NAMES = countryNamePatterns(["SA"]);
const EU_UK_NAMES = countryNamePatterns([...EU_COUNTRIES, ...EEA_EXTRA, "GB"]);

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Country codes named in a sentence (longest names first; "Northern Ireland" doesn't also count as Ireland). */
function countriesIn(sentence: string, names: { code: string; name: string }[]): string[] {
  let s = sentence;
  const found: string[] = [];
  for (const { code, name } of names) {
    const re = new RegExp(`(?<![\\p{L}])${escapeRe(name)}(?![\\p{L}])`, "giu");
    if (re.test(s)) {
      found.push(code);
      s = s.replace(re, " ");
    }
  }
  return [...new Set(found)];
}

/** Heuristic jurisdiction facts from privacy-policy text (MEDIUM at best: regex, not a reading). */
export function policyFacts(text: string): Fact[] {
  const facts: Fact[] = [];
  const sentences = text.split(/(?<=[.!?؟])\s+|\n+/);
  for (const s of sentences) {
    if (s.length > 600) continue;
    const isRep = REP_RE.test(s);
    const isController = CONTROLLER_RE.test(s);
    if (!isRep && !isController) continue;
    for (const code of countriesIn(s, EU_UK_NAMES)) {
      const uk = code === "GB";
      if (isRep) facts.push({ key: uk ? "uk_rep" : "eu_rep", value: code, confidence: "MEDIUM", source: "policy" });
      else facts.push({ key: uk ? "uk_establishment" : "eu_establishment", value: code, confidence: "MEDIUM", source: "policy" });
    }
    if (isController && !isRep && countriesIn(s, KSA_NAMES).length) facts.push({ key: "ksa_presence", value: "address", confidence: "MEDIUM", source: "policy" });
  }
  if (US_ADDRESS.test(text)) facts.push({ key: "is_us_sender", value: true, confidence: "MEDIUM", source: "policy" });
  if (CR_RE.test(text)) facts.push({ key: "ksa_presence", value: "cr_number", confidence: "MEDIUM", source: "policy" });
  return facts;
}

/** Arabic site: `<html lang="ar…">` or mostly Arabic letters. */
export function isArabicPage(html: string, text = stripToText(html)): boolean {
  const lang = cheerio.load(html)("html").attr("lang") ?? "";
  if (/^ar\b/i.test(lang)) return true;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0;
  return letters > 200 && arabic / letters > 0.3;
}

// ---------- optional LLM extraction (AI mode only) ----------

export const EXTRACT_SYSTEM_PROMPT = `You read a company's public privacy policy and extract how a person can send a privacy request (deletion, objection to marketing).
Return only contacts that appear verbatim in the text: email addresses meant for privacy/data-protection/DPO requests, and URLs of request web forms.
Also give the ISO 3166-1 alpha-2 country of the data controller's postal address if the text states it, else null.
Reply with a json object only, exactly in this shape:
{"privacyEmails":["privacy@example.com"],"webFormUrls":["https://example.com/privacy-request"],"controllerCountry":"IE"}`;

export const extractOutputSchema = z.object({
  privacyEmails: z.array(z.string().max(254)).max(5),
  webFormUrls: z.array(z.string().max(2048)).max(3),
  controllerCountry: z.string().length(2).nullable(),
});

export type LlmExtract = { emails: string[]; webForms: string[]; controllerCountry: string | null; callId: string };

/** Runs only when the LLM gate passes; returns null otherwise or on failure. Results are checked against the page. */
export async function llmExtractContacts(domain: string, policyUrl: string, analysis: PolicyAnalysis): Promise<LlmExtract | null> {
  const gate = await llmGate();
  if (!gate.ok || !analysis.text || !policyUrl.startsWith("https://")) return null;
  try {
    const payload = buildLlmPayload("extractContact", { domain, policyUrl, policyText: analysis.text }, { ownerNames: [] });
    const client = await LlmClient.create();
    const { data, callId } = await client.completeJson({
      purpose: "extractContact",
      system: EXTRACT_SYSTEM_PROMPT,
      payload,
      schema: extractOutputSchema,
      maxTokens: 400,
    });
    const lower = payload.policyText.toLowerCase();
    // Anti-hallucination: keep only what is really on the page.
    const emails = data.privacyEmails.map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) && lower.includes(e));
    const links = new Set(analysis.links.map((l) => l.replace(/#.*$/, "")));
    const webForms = data.webFormUrls.filter((u) => u.startsWith("https://") && (links.has(u.replace(/#.*$/, "")) || lower.includes(u.toLowerCase())));
    const cc = data.controllerCountry?.toUpperCase() ?? null;
    return { emails, webForms, controllerCountry: cc && /^[A-Z]{2}$/.test(cc) ? cc : null, callId };
  } catch (err) {
    logger.warn({ err: (err as Error).name, domain }, "llm extractContact failed");
    return null;
  }
}

// ---------- discovery ----------

const FALLBACK_PATHS = ["/privacy", "/privacy-policy", "/legal/privacy", "/privacy-notice", "/ar/privacy"];

async function fetchHtml(url: string): Promise<SafeResponse | null> {
  try {
    const res = await safeFetch(url, { headers: { accept: "text/html,application/xhtml+xml" } });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || (type && !/html/i.test(type))) return null;
    return res;
  } catch (err) {
    logger.info({ err: (err as Error).name, code: (err as { code?: string }).code }, "policy fetch failed");
    return null;
  }
}

export type PolicyDiscovery = {
  homepageUrl: string | null;
  arabicSite: boolean;
  policyUrl: string | null;
  analysis: PolicyAnalysis | null;
};

/** Homepage → footer privacy link (or well-known paths) → parsed policy page. */
export async function discoverPolicy(domain: string): Promise<PolicyDiscovery> {
  let home: SafeResponse | null = null;
  for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
    home = await fetchHtml(u);
    if (home) break;
  }
  const homeHtml = home?.text() ?? "";
  const arabicSite = home ? isArabicPage(homeHtml) : false;
  const base = home?.url ?? `https://${domain}/`;
  const candidates = home ? findPolicyLinks(homeHtml, base).slice(0, 3) : [];
  for (const p of FALLBACK_PATHS) {
    const u = new URL(p, base).href;
    if (!candidates.includes(u)) candidates.push(u);
  }
  for (const url of candidates) {
    if (!url.startsWith("https://")) continue;
    const res = await fetchHtml(url);
    if (!res) continue;
    const analysis = analyzePolicyHtml(res.text(), res.url);
    // A soft-404 or a page without privacy wording is not the policy.
    if (!PRIVACY_LINK_TEXT.test(analysis.text.slice(0, 20_000))) continue;
    return { homepageUrl: home?.url ?? null, arabicSite, policyUrl: res.url, analysis };
  }
  return { homepageUrl: home?.url ?? null, arabicSite, policyUrl: null, analysis: null };
}

