import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { z } from "zod";
import { db } from "@/lib/db";
import { currentKeyVersion, decrypt, encrypt } from "@/lib/crypto/tokens";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { assertLlmAllowed } from "@/lib/llm/gate";
import { fieldNames } from "@/lib/llm/payload";

// The only way the app talks to an LLM (DeepSeek by default; 02-capabilities §6, 00-brief §8).
// Every call re-checks the gate, logs metadata only (LlmCallLog), and keeps the exact payload of
// the newest 20 calls encrypted (LlmPayloadSample) so the owner can audit them.

export const PAYLOAD_SAMPLE_LIMIT = 20;
const PAYLOAD_SAMPLE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };

export type JsonCall<T> = {
  purpose: string;
  /** Static instructions; must mention "json" (DeepSeek JSON mode) and show an example. */
  system: string;
  /** Output of buildLlmPayload(): the only data sent. */
  payload: unknown;
  schema: z.ZodType<T>;
  maxTokens?: number;
};

export class LlmClient {
  private constructor(
    private readonly openai: OpenAI,
    readonly model: string,
  ) {}

  /** Refuses (LlmGateError) unless aiMode=DEEPSEEK, the training opt-out date is set and a key exists. */
  static async create(): Promise<LlmClient> {
    await assertLlmAllowed();
    const e = env();
    const openai = new OpenAI({ apiKey: e.DEEPSEEK_API_KEY, baseURL: e.LLM_BASE_URL, maxRetries: 2, timeout: 120_000 });
    return new LlmClient(openai, e.LLM_MODEL);
  }

  /** JSON-mode completion, Zod-validated, with one retry on invalid output. */
  async completeJson<T>(call: JsonCall<T>): Promise<{ data: T; callId: string }> {
    const user = JSON.stringify(call.payload);
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: call.system },
      { role: "user", content: user },
    ];
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      await assertLlmAllowed(); // the owner may have switched to Rules only mid-run
      if (attempt === 1) {
        messages.push({ role: "user", content: "Your previous reply was not valid json for the schema. Reply with the json object only." });
      }
      const params = {
        model: this.model,
        messages,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" }, // DeepSeek: non-thinking mode for classification
        temperature: 0,
        max_tokens: call.maxTokens ?? 8000,
      } as ChatCompletionCreateParamsNonStreaming;

      let usage: Usage | undefined;
      let ok = false;
      let result: T | undefined;
      try {
        const res = await this.openai.chat.completions.create(params);
        usage = res.usage as Usage | undefined;
        const text = res.choices[0]?.message?.content ?? "";
        const parsed = call.schema.safeParse(JSON.parse(text));
        if (parsed.success) {
          ok = true;
          result = parsed.data;
        } else {
          lastError = "schema";
        }
      } catch (err) {
        if (!(err instanceof SyntaxError)) {
          await this.log(call, user, usage, false);
          throw err; // network / API error: the caller falls back to rules
        }
        lastError = "json";
      }
      const callId = await this.log(call, user, usage, ok);
      if (ok) return { data: result as T, callId };
    }
    throw new LlmOutputError(`LLM output invalid after retry (${lastError})`);
  }

  private async log(call: JsonCall<unknown>, user: string, usage: Usage | undefined, ok: boolean): Promise<string> {
    const row = await db.llmCallLog.create({
      data: {
        purpose: call.purpose,
        model: this.model,
        inTokens: usage?.prompt_tokens ?? 0,
        cacheHitTokens: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0,
        outTokens: usage?.completion_tokens ?? 0,
        payloadHash: createHash("sha256").update(user).digest("hex"),
        fieldNames: fieldNames(call.payload),
        ok,
      },
    });
    await db.llmPayloadSample.create({ data: { callId: row.id, payloadCipher: encrypt(user) } });
    await prunePayloadSamples();
    logger.info({ callId: row.id, purpose: call.purpose, ok }, "llm call");
    return row.id;
  }
}

/** Ring buffer: newest 20 payload samples, none older than 7 days. */
export async function prunePayloadSamples(now = new Date()) {
  await db.llmPayloadSample.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - PAYLOAD_SAMPLE_MAX_AGE_MS) } } });
  const keep = await db.llmPayloadSample.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAYLOAD_SAMPLE_LIMIT,
    select: { id: true },
  });
  await db.llmPayloadSample.deleteMany({ where: { id: { notIn: keep.map((k) => k.id) } } });
}

/** Decrypts a stored payload sample for the owner's audit view (rows don't record the key version). */
export function readPayloadSample(cipher: Uint8Array): string {
  for (let v = currentKeyVersion(); v >= 1; v--) {
    try {
      return decrypt(cipher, v);
    } catch {
      /* older key */
    }
  }
  throw new Error("Payload sample cannot be decrypted with any configured key");
}
