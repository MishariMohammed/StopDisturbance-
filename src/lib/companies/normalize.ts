// Search normalisation (04-ux §5.2): case, diacritics, tatweel, alef/hamza, yaa, taa marbuta, digits.

const HARAKAT = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g; // marks + superscript alef + tatweel
const LATIN_MARKS = /[̀-ͯ]/g;

export function normalizeForSearch(input: string): string {
  return input
    .normalize("NFKD")
    .replace(LATIN_MARKS, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(HARAKAT, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىئ]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every whitespace-separated term of `query` must occur in at least one of `fields`. */
export function matchesQuery(fields: readonly (string | null | undefined)[], query: string): boolean {
  const terms = normalizeForSearch(query).split(" ").filter(Boolean);
  if (!terms.length) return true;
  const hay = fields.filter(Boolean).map((f) => normalizeForSearch(f!));
  return terms.every((t) => hay.some((h) => h.includes(t)));
}
