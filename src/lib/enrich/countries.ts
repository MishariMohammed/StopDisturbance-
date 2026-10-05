// Country names (English + native, as used in datarequests.org addresses and privacy policies) → ISO 3166-1 alpha-2.

export const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);
/** EEA members outside the EU: GDPR applies there too. */
export const EEA_EXTRA = new Set(["IS", "LI", "NO"]);

const NAMES: Record<string, string[]> = {
  AT: ["Austria", "Österreich"],
  BE: ["Belgium", "België", "Belgique", "Belgien"],
  BG: ["Bulgaria"],
  HR: ["Croatia", "Hrvatska"],
  CY: ["Cyprus"],
  CZ: ["Czech Republic", "Czechia", "Česko", "Česká republika"],
  DK: ["Denmark", "Danmark"],
  EE: ["Estonia", "Eesti"],
  FI: ["Finland", "Suomi"],
  FR: ["France"],
  DE: ["Germany", "Deutschland"],
  GR: ["Greece"],
  HU: ["Hungary", "Magyarország"],
  IE: ["Ireland", "Éire"],
  IT: ["Italy", "Italia"],
  LV: ["Latvia", "Latvija"],
  LT: ["Lithuania", "Lietuva"],
  LU: ["Luxembourg", "Luxemburg"],
  MT: ["Malta"],
  NL: ["Netherlands", "The Netherlands", "Nederland"],
  PL: ["Poland", "Polska"],
  PT: ["Portugal"],
  RO: ["Romania", "România"],
  SK: ["Slovakia", "Slovensko"],
  SI: ["Slovenia", "Slovenija"],
  ES: ["Spain", "España"],
  SE: ["Sweden", "Sverige"],
  IS: ["Iceland", "Ísland"],
  LI: ["Liechtenstein"],
  NO: ["Norway", "Norge"],
  CH: ["Switzerland", "Schweiz", "Suisse", "Svizzera"],
  GB: ["United Kingdom", "UK", "Great Britain", "England", "Scotland", "Wales", "Northern Ireland"],
  US: ["United States of America", "United States", "USA", "U.S.A.", "U.S."],
  CA: ["Canada"],
  AU: ["Australia"],
  NZ: ["New Zealand"],
  JP: ["Japan"],
  CN: ["China", "People's Republic of China"],
  HK: ["Hong Kong"],
  SG: ["Singapore"],
  IN: ["India"],
  IL: ["Israel"],
  KR: ["South Korea", "Republic of Korea", "Korea"],
  BR: ["Brazil", "Brasil"],
  TR: ["Turkey", "Türkiye"],
  RU: ["Russia", "Russian Federation"],
  SA: ["Saudi Arabia", "Kingdom of Saudi Arabia", "KSA", "المملكة العربية السعودية", "السعودية"],
  AE: ["United Arab Emirates", "UAE", "الإمارات العربية المتحدة"],
  BH: ["Bahrain", "البحرين"],
  QA: ["Qatar", "قطر"],
  KW: ["Kuwait", "الكويت"],
  OM: ["Oman", "عُمان"],
  EG: ["Egypt", "مصر"],
  JO: ["Jordan", "الأردن"],
};

const BY_NAME = new Map<string, string>();
for (const [code, names] of Object.entries(NAMES)) for (const n of names) BY_NAME.set(n.toLowerCase(), code);

/** ISO code for an exact country name (case-insensitive), or null. */
export function countryCode(name: string | null | undefined): string | null {
  if (!name) return null;
  return BY_NAME.get(name.trim().replace(/[.,]+$/, "").toLowerCase()) ?? null;
}

/** Country of a postal address whose last line is the country (datarequests.org convention). */
export function addressCountry(address: string | null | undefined): string | null {
  const last = address?.trim().split(/\n/).pop();
  return countryCode(last);
}

/** Names usable inside a text regex, longest first. Excludes short ambiguous tokens. */
export function countryNamePatterns(codes: Iterable<string>): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = [];
  for (const code of codes) for (const name of NAMES[code] ?? []) if (name.length > 3) out.push({ code, name });
  return out.sort((a, b) => b.name.length - a.name.length);
}

export function isEuOrEea(code: string): boolean {
  return EU_COUNTRIES.has(code) || EEA_EXTRA.has(code);
}
