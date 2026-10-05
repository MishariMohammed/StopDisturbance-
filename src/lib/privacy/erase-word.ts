// The word the owner types to confirm "Erase everything" (04-ux §3.6). Pure, shared by client and server.
export const ERASE_WORDS = { en: "ERASE", ar: "امسح" } as const;

export function eraseWordMatches(locale: string, input: string): boolean {
  const expected = locale === "en" ? ERASE_WORDS.en : ERASE_WORDS.ar;
  const typed = input.normalize("NFC").trim();
  return locale === "en" ? typed.toUpperCase() === expected : typed === expected;
}
