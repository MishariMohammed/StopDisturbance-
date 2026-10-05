import type { Regulator } from "@/lib/legal/jurisdiction";
import { supervisoryAuthorities } from "@/lib/enrich/datasets";

// Escalation targets (04-ux §7.4 step 1; URLs from 03-legal §§1–3). We never file anything:
// the owner opens the portal and files personally (SDAIA needs a Nafath login).

export interface RegulatorInfo {
  key: Regulator;
  name: { en: string; ar: string };
  url: string;
}

export const REGULATORS: Partial<Record<Regulator, RegulatorInfo>> = {
  SDAIA: {
    key: "SDAIA",
    name: { en: "Saudi Data & AI Authority (SDAIA)", ar: "الهيئة السعودية للبيانات والذكاء الاصطناعي (سدايا)" },
    url: "https://dgp.sdaia.gov.sa",
  },
  CST: {
    key: "CST",
    name: { en: "Communications, Space & Technology Commission (CST)", ar: "هيئة الاتصالات والفضاء والتقنية" },
    url: "https://www.cst.gov.sa",
  },
  EU_SA: {
    key: "EU_SA",
    name: { en: "EU data protection authority (lead supervisory authority)", ar: "سلطة حماية البيانات الأوروبية (السلطة الرقابية الرئيسية)" },
    url: "https://www.edpb.europa.eu/about-edpb/about-edpb/members_en",
  },
  ICO: {
    key: "ICO",
    name: { en: "UK Information Commissioner's Office (ICO)", ar: "مكتب مفوض المعلومات في المملكة المتحدة (ICO)" },
    url: "https://ico.org.uk/make-a-complaint/",
  },
  FTC: {
    key: "FTC",
    name: { en: "US Federal Trade Commission (FTC)", ar: "لجنة التجارة الفيدرالية الأمريكية (FTC)" },
    url: "https://reportfraud.ftc.gov",
  },
};

/** Regulator for the packet; the EU lead SA comes from the datarequests.org authorities snapshot when known. */
export async function regulatorInfo(key: Regulator, euCountry: string | null): Promise<RegulatorInfo> {
  if (key === "EU_SA" && euCountry) {
    const sa = (await supervisoryAuthorities(euCountry))[0];
    const url = sa?.webform ?? sa?.web;
    if (sa && url) return { key, name: { en: sa.name, ar: sa.name }, url };
  }
  return REGULATORS[key] ?? REGULATORS.SDAIA!;
}
