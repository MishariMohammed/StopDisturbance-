import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_URL_DIRECT: z.string().url().optional(),
  APP_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  OWNER_EMAILS: z.string().min(3),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_PUBLISHING_MODE: z.enum(["production", "testing"]).default("production"),
  MS_CLIENT_ID: z.string().default(""),
  MS_CLIENT_SECRET: z.string().default(""),
  MS_ALLOWED_TENANTS: z.string().default(""),
  TOKEN_ENC_KEYS: z.string().min(2),
  TOKEN_ENC_KEY_CURRENT: z.coerce.number().int().positive(),
  DEEPSEEK_API_KEY: z.string().default(""),
  LLM_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  LLM_MODEL: z.string().default("deepseek-flash"),
  MESSAGE_ID_DOMAIN: z.string().default("localhost"),
  TZ_DEFAULT: z.string().default("Asia/Riyadh"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

/** Test helper: drop the cached env after mutating process.env. */
export function resetEnvCache() {
  cached = undefined;
}

export function ownerEmails(): string[] {
  return env()
    .OWNER_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
