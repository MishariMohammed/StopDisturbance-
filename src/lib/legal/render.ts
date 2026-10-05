import { readFileSync } from "node:fs";
import path from "node:path";

// Local template rendering (00-brief §5 stage 6, §7 M5; 00-review D12: no LLM in letters).
// Templates live in templates/{id}.{lang}.md with a front-matter version string.

export type TemplateLang = "en" | "ar";
export type TemplateId = "6a" | "6b" | "6c" | "6d" | "6e" | "webform" | "webform-6d";

export interface LetterTemplate {
  id: TemplateId;
  lang: TemplateLang;
  version: string;
  source: string;
  /** [LAWYER] flag from 03-legal, kept out of the rendered text. */
  lawyer: boolean;
  lawyerNote: string | null;
  /** Subject line template, or null for templates without one (6c complaint). */
  subject: string | null;
  body: string;
  placeholders: string[];
}

export const TEMPLATE_DIR = path.join(process.cwd(), "templates");

/** Phrases that would make a letter look like an agent's (03-legal §8, M5). Checked case-insensitively. */
export const BANNED_PHRASES = [
  "on behalf of",
  "via stopdisturbance",
  "authorized agent",
  "authorised agent",
  "stopdisturbance",
  "نيابة عن",
  "بالنيابة",
  "وكيل معتمد",
] as const;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const cache = new Map<string, LetterTemplate>();

export function parseTemplate(raw: string, file = "template"): LetterTemplate {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!m) throw new TemplateError(`${file}: missing front matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  for (const k of ["id", "lang", "version"]) if (!meta[k]) throw new TemplateError(`${file}: front matter lacks ${k}`);
  let text = m[2].replace(/\s+$/, "") + "\n";
  let subject: string | null = null;
  const s = /^Subject:\s*(.*)\r?\n(\r?\n)?/.exec(text);
  if (s) {
    subject = s[1].trim();
    text = text.slice(s[0].length);
  }
  const placeholders = [...new Set([...`${subject ?? ""}\n${text}`.matchAll(/\{\{([a-z_]+)\}\}/g)].map((x) => x[1]))];
  return {
    id: meta.id as TemplateId,
    lang: meta.lang as TemplateLang,
    version: meta.version,
    source: meta.source ?? "",
    lawyer: meta.lawyer === "true",
    lawyerNote: meta.lawyerNote ?? null,
    subject,
    body: text,
    placeholders,
  };
}

export function loadTemplate(id: TemplateId, lang: TemplateLang): LetterTemplate {
  const key = `${id}.${lang}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const file = path.join(TEMPLATE_DIR, `${key}.md`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new TemplateError(`No template ${key}`);
  }
  const t = parseTemplate(raw, key);
  if (t.id !== id || t.lang !== lang) throw new TemplateError(`${key}: front matter id/lang mismatch`);
  cache.set(key, t);
  return t;
}

export function findBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((p) => lower.includes(p));
}

const REF_RE = /SD-[0-9A-HJKMNP-TV-Z]{4}/;

export interface RenderedLetter {
  templateId: TemplateId;
  templateVersion: string;
  language: TemplateLang;
  lawyer: boolean;
  subject: string | null;
  body: string;
}

function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (whole, name: string) => (name in values ? values[name] : whole));
}

/**
 * Fill {{placeholders}} locally. Throws when any `{{`/`}}` remains, when a banned phrase appears,
 * or when the subject does not carry the request reference (SD-XXXX).
 */
export function renderTemplate(id: TemplateId, lang: TemplateLang, values: Readonly<Record<string, string>>): RenderedLetter {
  const t = loadTemplate(id, lang);
  const subject = t.subject === null ? null : fill(t.subject, values).replace(/\s+/g, " ").trim();
  const body = fill(t.body, values)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  const letter: RenderedLetter = { templateId: id, templateVersion: t.version, language: lang, lawyer: t.lawyer, subject, body };
  assertLetterClean(letter);
  return letter;
}

export function assertLetterClean(letter: { subject: string | null; body: string }): void {
  const all = `${letter.subject ?? ""}\n${letter.body}`;
  if (all.includes("{{") || all.includes("}}")) {
    const left = [...new Set([...all.matchAll(/\{\{([^}]*)\}\}/g)].map((x) => x[1]))];
    throw new TemplateError(`Unfilled placeholders: ${left.join(", ") || "{{"}`);
  }
  const banned = findBannedPhrases(all);
  if (banned.length) throw new TemplateError(`Banned phrase(s) in letter: ${banned.join(", ")}`);
  if (letter.subject !== null && !REF_RE.test(letter.subject)) throw new TemplateError("Subject must carry the reference SD-XXXX");
}
