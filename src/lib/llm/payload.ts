import { z } from "zod";
import { redactText, safeSubject, type RedactContext } from "@/lib/llm/redact";

// Exactly what may be sent to the LLM (00-brief §8, 03-legal §9). Every schema is `.strict()`:
// an unknown field anywhere throws, so new data can't leak into a payload without a code change here.

const domainSchema = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z0-9-]{2,}$/, "registrable domain expected");

const flagsSchema = z
  .object({
    listUnsub: z.boolean(),
    oneClick: z.boolean(),
    listId: z.boolean(),
    feedbackId: z.boolean(),
    esp: z.string().max(60).nullable(),
    gmailCategory: z.enum(["PROMOTIONS", "UPDATES", "SOCIAL", "FORUMS", "PERSONAL"]).nullable(),
    outlookFocused: z.boolean().nullable(),
    junk: z.boolean(),
    precedence: z.enum(["bulk", "list", "junk"]).nullable(),
    autoSubmitted: z.boolean(),
  })
  .strict();

/** Caller input for one sender (before redaction). */
const classifySenderInput = z
  .object({
    domain: domainSchema,
    displayName: z.string().max(200).nullable(),
    flags: flagsSchema,
    msgCount: z.number().int().nonnegative(),
    subjects: z.array(z.string().max(1000)).max(50),
    isPersonal: z.literal(false), // personal correspondents never reach the LLM
  })
  .strict();

const classifySendersInput = z.object({ senders: z.array(classifySenderInput).min(1).max(50) }).strict();

/** What actually leaves the box. */
export const classifySendersPayload = z
  .object({
    senders: z
      .array(
        z
          .object({
            domain: domainSchema,
            displayName: z.string().max(100).nullable(),
            flags: flagsSchema,
            msgCount: z.number().int().nonnegative(),
            subjects: z.array(z.string().max(200)).max(3),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type ClassifySendersInput = z.input<typeof classifySendersInput>;
export type ClassifySendersPayload = z.infer<typeof classifySendersPayload>;

type Kinds = { classifySenders: { input: ClassifySendersInput; payload: ClassifySendersPayload } };
export type PayloadKind = keyof Kinds;

export type PayloadContext = RedactContext;

/**
 * Builds the minimised payload for an LLM call. Throws on any field not listed in 00-brief §8.
 * Redaction: digits ≥4, emails, URLs, owner names → placeholders; sensitive subjects dropped.
 */
export function buildLlmPayload<K extends PayloadKind>(kind: K, input: Kinds[K]["input"], ctx: PayloadContext): Kinds[K]["payload"] {
  switch (kind) {
    case "classifySenders": {
      const parsed = classifySendersInput.parse(input);
      const payload = {
        senders: parsed.senders.map((s) => {
          const name = s.displayName ? redactText(s.displayName, ctx) : "";
          const subjects: string[] = [];
          for (const raw of s.subjects) {
            const safe = safeSubject(raw, ctx);
            if (safe && !subjects.includes(safe)) subjects.push(safe);
            if (subjects.length === 3) break;
          }
          return {
            domain: s.domain,
            displayName: name ? [...name].slice(0, 100).join("") : null,
            flags: s.flags,
            msgCount: s.msgCount,
            subjects,
          };
        }),
      };
      return classifySendersPayload.parse(payload);
    }
    default:
      throw new Error(`Unknown LLM payload kind: ${String(kind)}`);
  }
}

/** Dotted field paths of a payload (for LlmCallLog.fieldNames: names only, no values). */
export function fieldNames(value: unknown, prefix = ""): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, `${p}[]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    else if (p) out.add(p);
  };
  walk(value, prefix);
  return [...out].sort();
}
