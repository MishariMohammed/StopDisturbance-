// PersonalDataChips (04-ux §6.2): which identifiers a letter includes. Pure; safe in client components.
// National ID / Iqama is never included by default; when the owner adds one we warn (non-blocking).

export type IdentifierKey = "name" | "email" | "phone" | "account" | "nationalId";
export const IDENTIFIER_KEYS: readonly IdentifierKey[] = ["name", "email", "phone", "account", "nationalId"];

const normalizeDigits = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** Saudi national ID (starts with 1) or Iqama (starts with 2): 10 digits. */
const NATIONAL_ID = /(?<![\d+])[12]\d{9}(?!\d)/;
/** Saudi mobile (05xxxxxxxx / +9665xxxxxxxx / 009665…) or any international number with a + prefix. */
const PHONE = /(?<!\d)(?:(?:\+|00)966[\s-]?5\d(?:[\s-]?\d){7}|05\d(?:[\s-]?\d){7}|\+\d{1,3}[\s-]?\d(?:[\s-]?\d){6,12})(?!\d)/;
const ACCOUNT =
  /\b(?:order|account|customer|membership|loyalty|member)\s*(?:no\.?|number|num|#|id)?\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{3,}\b|(?:رقم\s+(?:الطلب|الحساب|العضوية|العميل))\s*[:#]?\s*[A-Za-z0-9-]{4,}/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function detectIdentifiers(text: string, known: { fullName?: string; emails?: string[] } = {}): Record<IdentifierKey, boolean> {
  const t = normalizeDigits(text);
  const lower = t.toLowerCase();
  const name = known.fullName?.trim();
  const emails = (known.emails ?? []).map((e) => e.toLowerCase()).filter(Boolean);
  return {
    name: name ? lower.includes(name.toLowerCase()) : false,
    email: emails.length ? emails.some((e) => lower.includes(e)) : EMAIL.test(t),
    phone: PHONE.test(t),
    account: ACCOUNT.test(t),
    nationalId: NATIONAL_ID.test(t),
  };
}

/** Same rule as the server-side `possible_id_number` guardrail in updateDraft, plus Arabic-Indic digits. */
export function hasPossibleIdNumber(text: string): boolean {
  return /(?<!\d)\d{10}(?!\d)/.test(normalizeDigits(text));
}
