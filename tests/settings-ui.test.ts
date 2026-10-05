import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/tokens";
import { eraseWordMatches } from "@/lib/privacy/erase-word";
import { recentAiCalls, dataCounts } from "@/lib/settings/overview";
import { getNotificationSettings, setNotificationSettings } from "@/lib/notify/settings";
import { getRetentionYears, setRetentionYears } from "@/lib/jobs/retention";
import { resetDb } from "./helpers";

beforeEach(resetDb);

describe("erase confirmation word", () => {
  it("needs ERASE in English and امسح in Arabic (paste-friendly: trims whitespace)", () => {
    expect(eraseWordMatches("en", "ERASE")).toBe(true);
    expect(eraseWordMatches("en", "  erase ")).toBe(true);
    expect(eraseWordMatches("en", "امسح")).toBe(false);
    expect(eraseWordMatches("en", "")).toBe(false);
    expect(eraseWordMatches("en", "ERASE NOW")).toBe(false);
    expect(eraseWordMatches("ar", "امسح")).toBe(true);
    expect(eraseWordMatches("ar", " امسح\n")).toBe(true);
    expect(eraseWordMatches("ar", "مسح")).toBe(false);
    expect(eraseWordMatches("ar", "ERASE")).toBe(false);
  });
});

describe("last 20 AI calls", () => {
  async function call(i: number, withSample: boolean) {
    const row = await db.llmCallLog.create({
      data: { at: new Date(Date.UTC(2026, 9, 1, 0, i)), purpose: "classify", model: "deepseek-flash", inTokens: 10, cacheHitTokens: 0, outTokens: 5, payloadHash: `h${i}`, fieldNames: ["displayName", "domain"], ok: true },
    });
    if (withSample) await db.llmPayloadSample.create({ data: { callId: row.id, payloadCipher: encrypt(`{"domain":"brand${i}.com"}`) } });
    return row;
  }

  it("keeps payload values hidden until revealed, newest first, at most 20", async () => {
    for (let i = 0; i < 23; i++) await call(i, i >= 20);
    const hidden = await recentAiCalls(false);
    expect(hidden).toHaveLength(20);
    expect(hidden[0].at.getTime()).toBeGreaterThan(hidden[19].at.getTime());
    expect(hidden.every((c) => c.payload === null)).toBe(true);
    expect(hidden[0]).toMatchObject({ hasSample: true, tokens: 15, fieldNames: ["displayName", "domain"] });
    expect(JSON.stringify(hidden)).not.toContain("brand22.com");

    const shown = await recentAiCalls(true);
    expect(shown[0].payload).toBe('{"domain":"brand22.com"}');
    expect(shown[5].payload).toBeNull();
    expect(shown[5].hasSample).toBe(false);
  });

  it("counts stored data for the erase dialog", async () => {
    expect(await dataCounts()).toEqual({ mailboxes: 0, companies: 0, requests: 0, openRequests: 0, subjects: 0 });
  });
});

describe("notification and retention settings", () => {
  it("stores notification toggles in the shape src/lib/notify/settings.ts reads", async () => {
    await setNotificationSettings({ digest: false, replyReceived: true, needsAction: false, overdue: true, deadlineSoon: false, sendFailed: true, mailboxDisconnected: true });
    expect(await getNotificationSettings()).toMatchObject({ digest: false, needsAction: false, deadlineSoon: false, overdue: true });
  });

  it("retention years: default 1, accepts 1–3 only, audited", async () => {
    expect(await getRetentionYears()).toBe(1);
    await setRetentionYears(3);
    expect(await getRetentionYears()).toBe(3);
    await expect(setRetentionYears(4)).rejects.toThrow();
    await expect(setRetentionYears(0)).rejects.toThrow();
    expect(await getRetentionYears()).toBe(3);
    expect(await db.auditLog.count({ where: { action: "settings.retention_years" } })).toBe(1);
  });
});
