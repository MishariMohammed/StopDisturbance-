import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getAiMode, getOptOutConfirmedAt } from "@/lib/llm/gate";
import { resetEnvCache } from "@/lib/env";
import { connectionTestPassed, getReplyAiEnabled, parseOptOutDate, setAiMode, setReplyAiEnabled, testLlmConnection } from "@/lib/settings/ai";
import { saveSetup } from "@/lib/settings/setup";
import { json, mockFetch, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEEPSEEK_API_KEY;
  resetEnvCache();
});

function withKey(key = "sk-test-key-123456") {
  process.env.DEEPSEEK_API_KEY = key;
  resetEnvCache();
}

function modelsEndpoint(status = 200) {
  const m = mockFetch([[/api\.deepseek\.com\/models$/, () => (status === 200 ? json({ data: [{ id: "deepseek-flash" }] }) : json({ error: "unauthorized" }, status))]]);
  vi.stubGlobal("fetch", m.fn);
  return m;
}

describe("AI assist setting", () => {
  const now = new Date("2026-10-05T12:00:00Z");

  it("refuses DeepSeek without the training opt-out confirmation and date", async () => {
    expect(await setAiMode("DEEPSEEK", { confirmed: false, date: "2026-10-01" }, now)).toEqual({ ok: false, reason: "opt_out_required" });
    expect(await setAiMode("DEEPSEEK", { confirmed: true, date: "" }, now)).toEqual({ ok: false, reason: "bad_date" });
    expect(await setAiMode("DEEPSEEK", { confirmed: true, date: "2026-12-01" }, now)).toEqual({ ok: false, reason: "bad_date" });
    expect(await getAiMode()).toBe("RULES");
    expect(await getOptOutConfirmedAt()).toBeNull();
  });

  it("enables DeepSeek with a confirmed date and switches back to Rules only", async () => {
    withKey();
    modelsEndpoint();
    expect((await testLlmConnection()).ok).toBe(true);
    expect(await setAiMode("DEEPSEEK", { confirmed: true, date: "2026-10-01" }, now)).toEqual({ ok: true, mode: "DEEPSEEK" });
    expect(await getAiMode()).toBe("DEEPSEEK");
    expect((await getOptOutConfirmedAt())?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(await setAiMode("RULES")).toEqual({ ok: true, mode: "RULES" });
    expect(await getAiMode()).toBe("RULES");
    expect(await db.auditLog.count({ where: { action: "settings.ai_mode" } })).toBe(2);
  });

  it("requires a passing Test connection (GET /models with the key) before DeepSeek", async () => {
    withKey();
    expect(await setAiMode("DEEPSEEK", { confirmed: true, date: "2026-10-01" }, now)).toEqual({ ok: false, reason: "connection_test_required" });

    const bad = modelsEndpoint(401);
    expect(await testLlmConnection()).toMatchObject({ ok: false, status: 401 });
    expect(bad.calls[0].href).toBe("https://api.deepseek.com/models");
    expect(await setAiMode("DEEPSEEK", { confirmed: true, date: "2026-10-01" }, now)).toEqual({ ok: false, reason: "connection_test_required" });

    const good = modelsEndpoint(200);
    const t = await testLlmConnection();
    expect(t).toMatchObject({ ok: true, status: 200, modelListed: true });
    expect(good.calls).toHaveLength(1);
    // The stored result never contains the key itself.
    const row = await db.setting.findUniqueOrThrow({ where: { key: "llmConnectionTest" } });
    expect(JSON.stringify(row.value)).not.toContain("sk-test-key");
    expect(await setAiMode("DEEPSEEK", { confirmed: true, date: "2026-10-01" }, now)).toEqual({ ok: true, mode: "DEEPSEEK" });

    // A different key invalidates the earlier test.
    withKey("sk-other-key-999999");
    expect(await connectionTestPassed()).toBe(false);
  });

  it("without a key the test fails without any network call", async () => {
    const m = modelsEndpoint();
    expect(await testLlmConnection()).toMatchObject({ ok: false, status: null });
    expect(m.calls).toHaveLength(0);
  });

  it("reply-AI is a separate opt-in, off by default, and needs the warning acknowledged", async () => {
    expect(await getReplyAiEnabled()).toBe(false);
    expect(await setReplyAiEnabled(true, false)).toEqual({ ok: false, reason: "ack_required" });
    expect(await getReplyAiEnabled()).toBe(false);
    expect(await setReplyAiEnabled(true, true)).toEqual({ ok: true });
    expect(await getReplyAiEnabled()).toBe(true);
    expect(await setReplyAiEnabled(false, false)).toEqual({ ok: true });
    expect(await getReplyAiEnabled()).toBe(false);
  });

  it("validates opt-out dates", () => {
    expect(parseOptOutDate("2026-02-30", now)).toBeNull();
    expect(parseOptOutDate("05/10/2026", now)).toBeNull();
    expect(parseOptOutDate("2026-10-05", now)?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });
});

describe("first-run setup", () => {
  it("stores owner details and defaults AI to Rules only", async () => {
    await saveSetup({ locale: "en", fullName: " Mishari ", country: "SA" }, "Owner@Gmail.com");
    const owner = await db.owner.findUniqueOrThrow({ where: { id: "owner" } });
    expect(owner).toMatchObject({ fullName: "Mishari", country: "SA", locale: "en", loginEmails: ["owner@gmail.com"] });
    expect(owner.setupDoneAt).toBeInstanceOf(Date);
    expect(await getAiMode()).toBe("RULES");
    await expect(saveSetup({ locale: "en", fullName: "", country: "SA" })).rejects.toThrow();
  });
});
