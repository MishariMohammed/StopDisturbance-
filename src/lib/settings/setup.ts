import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { AI_MODE_KEY } from "@/lib/llm/gate";

// First-run setup card (04-ux §3.1, §4.1 step 5). AI assist always starts as Rules only.

export const COUNTRIES = ["SA", "AE", "KW", "QA", "BH", "OM", "EG", "JO", "GB", "IE", "DE", "FR", "US", "OTHER"] as const;

export const setupSchema = z.object({
  locale: z.enum(["ar", "en"]),
  fullName: z.string().trim().min(1).max(120),
  country: z.enum(COUNTRIES),
});

export type SetupInput = z.infer<typeof setupSchema>;

export async function saveSetup(input: SetupInput, loginEmail?: string | null) {
  const data = setupSchema.parse(input);
  const now = new Date();
  await db.owner.upsert({
    where: { id: "owner" },
    create: { id: "owner", ...data, loginEmails: loginEmail ? [loginEmail.toLowerCase()] : [], setupDoneAt: now },
    update: { ...data, setupDoneAt: now },
  });
  // Default is Rules only; DeepSeek can be enabled later in Settings behind the opt-out gate.
  await db.setting.upsert({ where: { key: AI_MODE_KEY }, create: { key: AI_MODE_KEY, value: "RULES" }, update: {} });
  await audit("owner.setup", "owner", "owner", { locale: data.locale, country: data.country });
  await db.appEvent.create({ data: { name: "setup_completed", props: { locale: data.locale } } });
}
