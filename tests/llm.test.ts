import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { classifyUnsettled } from "@/lib/llm/classify-unsettled";
import { LlmClient, prunePayloadSamples, readPayloadSample } from "@/lib/llm/client";
import { AI_MODE_KEY, LlmGateError, llmGate, OPT_OUT_KEY } from "@/lib/llm/gate";
import { buildLlmPayload, type ClassifySendersInput } from "@/lib/llm/payload";
import { ownerNameTerms } from "@/lib/llm/redact";
import { classifySenders } from "@/lib/scan/classify";
import { resolvePending } from "@/lib/scan/resolve";
import { resetDb } from "./helpers";
import { seedFixtureHeaders, seedOwnerAndAccount } from "./scan-helpers";

const llm = vi.hoisted(() => ({ ctor: vi.fn(), create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: llm.create } };
    constructor(opts: unknown) {
      llm.ctor(opts);
    }
  },
}));

const ctx = { ownerNames: ownerNameTerms("Sara Alharbi") };
const flags = {
  listUnsub: true, oneClick: true, listId: false, feedbackId: true, esp: "Braze", gmailCategory: "PROMOTIONS" as const,
  outlookFocused: null, junk: false, precedence: "bulk" as const, autoSubmitted: false,
};
const sender = (over: Record<string, unknown> = {}) =>
  ({ domain: "noon.com", displayName: "noon", flags, msgCount: 12, subjects: ["50% off"], isPersonal: false as const, ...over }) as ClassifySendersInput["senders"][number];

describe("buildLlmPayload", () => {
  it("emits exactly the §8 fields", () => {
    const p = buildLlmPayload("classifySenders", { senders: [sender()] }, ctx);
    expect(Object.keys(p.senders[0]).sort()).toEqual(["displayName", "domain", "flags", "msgCount", "subjects"]);
    expect(p.senders[0]).not.toHaveProperty("isPersonal");
  });

  it("rejects any extra field, at every level", () => {
    expect(() => buildLlmPayload("classifySenders", { senders: [sender({ fromAddress: "x@noon.com" })] }, ctx)).toThrow();
    expect(() => buildLlmPayload("classifySenders", { senders: [sender({ flags: { ...flags, toAddress: "me@gmail.com" } })] }, ctx)).toThrow();
    expect(() => buildLlmPayload("classifySenders", { senders: [sender()], owner: "Sara" } as never, ctx)).toThrow();
    expect(() => buildLlmPayload("classifySenders", { senders: [sender({ isPersonal: true })] }, ctx)).toThrow();
    expect(() => buildLlmPayload("other" as never, { senders: [sender()] } as never, ctx)).toThrow();
  });

  it("caps batches at 50 senders", () => {
    const senders = Array.from({ length: 51 }, (_, i) => sender({ domain: `brand${i}.com` }));
    expect(() => buildLlmPayload("classifySenders", { senders }, ctx)).toThrow();
  });

  it("redacts digits ≥4, emails, URLs and owner names; drops sensitive subjects; keeps ≤3", () => {
    const p = buildLlmPayload(
      "classifySenders",
      {
        senders: [
          sender({
            displayName: "Sara, your noon picks",
            subjects: [
              "Your verification code is 482913", // OTP → dropped
              "Your bank statement for September", // bank → dropped
              "موعدك في العيادة غداً", // medical (AR) → dropped
              "رمز التحقق 5521", // OTP (AR) → dropped
              "Order 40012345 shipped to sara.alharbi@gmail.com",
              "Sara Alharbi, see https://noon.com/deals?u=88 now",
              "سارة, Hi Sara: 3 items 12 left",
              "fourth safe subject",
            ],
          }),
        ],
      },
      ctx,
    );
    const s = p.senders[0];
    expect(s.displayName).toBe("[NAME], your noon picks");
    expect(s.subjects).toEqual(["Order [NUM] shipped to [EMAIL]", "[NAME], see [URL] now", "سارة, Hi [NAME]: 3 items 12 left"]);
    expect(JSON.stringify(p)).not.toMatch(/482913|40012345|sara\.alharbi|Alharbi|https?:/);
  });
});

async function setSetting(key: string, value: string) {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

function setKey(key: string | undefined) {
  if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = key;
  resetEnvCache();
}

describe("LLM gate", () => {
  beforeEach(async () => {
    await resetDb();
    llm.ctor.mockClear();
    llm.create.mockReset();
  });
  afterEach(() => setKey(undefined));

  it("defaults to Rules only", async () => {
    setKey("sk-test");
    expect(await llmGate()).toEqual({ ok: false, reason: "rules_mode" });
    await expect(LlmClient.create()).rejects.toBeInstanceOf(LlmGateError);
  });

  it("refuses DEEPSEEK mode without a training opt-out date", async () => {
    setKey("sk-test");
    await setSetting(AI_MODE_KEY, "DEEPSEEK");
    expect(await llmGate()).toEqual({ ok: false, reason: "no_training_opt_out" });
    await expect(LlmClient.create()).rejects.toThrow("no_training_opt_out");
    expect(llm.ctor).not.toHaveBeenCalled();
  });

  it("refuses without an API key", async () => {
    setKey(undefined);
    await setSetting(AI_MODE_KEY, "DEEPSEEK");
    await setSetting(OPT_OUT_KEY, "2026-10-01");
    expect(await llmGate()).toEqual({ ok: false, reason: "no_api_key" });
  });

  it("passes when all three hold", async () => {
    setKey("sk-test");
    await setSetting(AI_MODE_KEY, "DEEPSEEK");
    await setSetting(OPT_OUT_KEY, "2026-10-01");
    expect((await llmGate()).ok).toBe(true);
    await LlmClient.create();
    expect(llm.ctor).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://api.deepseek.com", apiKey: "sk-test" }));
  });
});

async function scan() {
  const acc = await seedOwnerAndAccount();
  await seedFixtureHeaders(acc.id);
  await resolvePending();
  await classifySenders();
}

describe("Rules-only mode makes zero LLM network calls", () => {
  beforeEach(async () => {
    await resetDb();
    llm.ctor.mockClear();
    llm.create.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setKey(undefined);
  });

  it.each([
    ["default settings", async () => {}],
    ["DEEPSEEK selected but gate not met", async () => setSetting(AI_MODE_KEY, "DEEPSEEK")],
  ])("%s", async (_name, arrange) => {
    setKey("sk-test");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input));
      throw new Error("network disabled in test");
    }));
    await arrange();
    await scan();
    const r = await classifyUnsettled();
    expect(r.classified).toBe(0);
    expect(r.skipped).not.toBeNull();
    expect(llm.ctor).not.toHaveBeenCalled();
    expect(llm.create).not.toHaveBeenCalled();
    expect(calls.filter((u) => u.startsWith("https://api.deepseek.com"))).toEqual([]);
    expect(calls).toEqual([]);
    expect(await db.llmCallLog.count()).toBe(0);
    expect(await db.classification.count({ where: { method: "LLM" } })).toBe(0);
  });
});

describe("classifyUnsettled with the gate open", () => {
  beforeEach(async () => {
    await resetDb();
    llm.ctor.mockClear();
    llm.create.mockReset();
    setKey("sk-test");
    await setSetting(AI_MODE_KEY, "DEEPSEEK");
    await setSetting(OPT_OUT_KEY, "2026-10-01");
  });
  afterEach(() => setKey(undefined));

  const reply = (content: string) => ({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 900, completion_tokens: 40, prompt_cache_hit_tokens: 600 },
  });

  it("sends only unsettled, non-personal senders; labels results LLM; logs no content", async () => {
    await scan();
    llm.create.mockImplementation(async (params: { messages: { content: string }[] }) => {
      const payload = JSON.parse(params.messages[1].content) as { senders: { domain: string }[] };
      return reply(JSON.stringify({ results: payload.senders.map((s) => ({ domain: s.domain, labels: ["ads"], confidence: "HIGH" })) }));
    });
    const r = await classifyUnsettled();
    expect(r).toMatchObject({ skipped: null, failedBatches: 0 });
    expect(r.classified).toBeGreaterThanOrEqual(1);

    const params = llm.create.mock.calls[0][0];
    expect(params).toMatchObject({ response_format: { type: "json_object" }, thinking: { type: "disabled" } });
    expect(params.messages[0].content).toMatch(/json/);
    const sent = params.messages[1].content as string;
    expect(sent).toContain("albaik.com");
    expect(sent).not.toMatch(/gmail\.com|familyclinic|acme-energy|Alharbi|sara\./i);

    const albaik = await db.sender.findUniqueOrThrow({ where: { registrableDomain: "albaik.com" } });
    const c = await db.classification.findFirstOrThrow({ where: { senderId: albaik.id, method: "LLM" } });
    expect(c).toMatchObject({ labels: ["ads"], confidence: "MEDIUM" }); // AI suggestion capped at Medium
    expect(await db.company.findUniqueOrThrow({ where: { primaryDomain: "albaik.com" } })).toMatchObject({ sendsAds: true });

    const log = await db.llmCallLog.findFirstOrThrow();
    expect(log).toMatchObject({ purpose: "classifySenders", model: "deepseek-flash", inTokens: 900, cacheHitTokens: 600, outTokens: 40, ok: true });
    expect(log.fieldNames).toContain("senders[].flags.oneClick");
    expect(JSON.stringify(log)).not.toContain("albaik");
    const sample = await db.llmPayloadSample.findFirstOrThrow();
    expect(sample.callId).toBe(log.id);
    expect(Buffer.from(sample.payloadCipher).toString("latin1")).not.toContain("albaik");
    expect(readPayloadSample(sample.payloadCipher)).toBe(sent);

    // Already suggested: a second run sends nothing.
    llm.create.mockClear();
    await classifyUnsettled();
    expect(llm.create).not.toHaveBeenCalled();
  });

  it("retries once on invalid output, then falls back to rules", async () => {
    await scan();
    llm.create.mockResolvedValueOnce(reply("not json")).mockResolvedValueOnce(reply('{"results":[{"domain":"albaik.com","labels":["holds_data"],"confidence":"LOW"}]}'));
    const ok = await classifyUnsettled();
    expect(llm.create).toHaveBeenCalledTimes(2);
    expect(ok).toMatchObject({ classified: 1, failedBatches: 0 });
    expect((await db.llmCallLog.findMany({ orderBy: { at: "asc" } })).map((l) => l.ok)).toEqual([false, true]);

    await db.classification.deleteMany({ where: { method: "LLM" } });
    llm.create.mockReset().mockResolvedValue(reply('{"results":"nope"}'));
    const failed = await classifyUnsettled();
    expect(llm.create).toHaveBeenCalledTimes(2);
    expect(failed).toMatchObject({ classified: 0, failedBatches: 1 });
  });

  it("never touches manually classified senders", async () => {
    await scan();
    const albaik = await db.sender.findUniqueOrThrow({ where: { registrableDomain: "albaik.com" } });
    await db.classification.create({ data: { senderId: albaik.id, companyId: albaik.companyId, method: "MANUAL", labels: ["holds_data"], ruleIds: ["OWNER"], confidence: "HIGH" } });
    llm.create.mockResolvedValue(reply('{"results":[]}'));
    await classifyUnsettled();
    for (const call of llm.create.mock.calls) expect(call[0].messages[1].content).not.toContain("albaik.com");
  });

  it("keeps only the newest 20 payload samples", async () => {
    const at = Date.now();
    await db.llmPayloadSample.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({ callId: `c${i}`, payloadCipher: new Uint8Array([1]), createdAt: new Date(at - i * 1000) })),
    });
    await db.llmPayloadSample.create({ data: { callId: "old", payloadCipher: new Uint8Array([1]), createdAt: new Date(at - 8 * 86400_000) } });
    await prunePayloadSamples();
    const left = await db.llmPayloadSample.findMany();
    expect(left).toHaveLength(20);
    expect(left.map((s) => s.callId)).not.toContain("c24");
    expect(left.map((s) => s.callId)).not.toContain("old");
  });
});
