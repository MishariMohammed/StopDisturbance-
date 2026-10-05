import sensitive from "../../../data/sensitive-subject-patterns.json";

// Text minimisation shared by stored example subjects and LLM payloads (00-brief §8, 03-legal §9).

const SENSITIVE = sensitive.patterns.map((p) => ({ id: p.id, re: new RegExp(p.pattern, "iu") }));

/** Id of the first sensitive pattern (medical, bank, password/OTP, legal; EN+AR) the text matches, or null. */
export function sensitiveMatch(text: string): string | null {
  for (const p of SENSITIVE) if (p.re.test(text)) return p.id;
  return null;
}

export function isSensitiveSubject(text: string): boolean {
  return sensitiveMatch(text) !== null;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu;
const EMAIL_RE = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z]{2,}/giu;
// A run of 4+ digits (Latin, Arabic-Indic or Eastern Arabic-Indic).
const DIGITS_RE = /[0-9٠-٩۰-۹]{4,}/gu;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Owner name variants worth redacting: the full name and each part of 3+ letters. */
export function ownerNameTerms(fullName: string): string[] {
  const full = fullName.trim().replace(/\s+/g, " ");
  if (!full) return [];
  const parts = full.split(/[\s,]+/).filter((p) => [...p].length >= 3);
  // Longest first so the full name wins over its parts.
  return [...new Set([full, ...parts])].sort((a, b) => b.length - a.length);
}

export type RedactContext = { ownerNames: string[] };

/** Emails, URLs, digit runs ≥4 and owner names → placeholders. Idempotent. */
export function redactText(text: string, ctx: RedactContext): string {
  let out = text.replace(URL_RE, "[URL]").replace(EMAIL_RE, "[EMAIL]").replace(DIGITS_RE, "[NUM]");
  for (const term of ctx.ownerNames) {
    if (!term) continue;
    // Letter boundaries that also work for Arabic script.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, "[NAME]");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** A subject safe to keep or send: sensitive → null, otherwise redacted. */
export function safeSubject(subject: string | null | undefined, ctx: RedactContext, maxLen = 200): string | null {
  if (!subject) return null;
  if (isSensitiveSubject(subject)) return null;
  const r = redactText(subject, ctx);
  return r ? [...r].slice(0, maxLen).join("") : null;
}
