import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getAiMode, getOptOutConfirmedAt } from "@/lib/llm/gate";
import { parseOptOutDate, setAiMode } from "@/lib/settings/ai";
import { saveSetup } from "@/lib/settings/setup";
import { resetDb } from "./helpers";

beforeEach(resetDb);

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
    expect(await setAiMode("DEEPSEEK", { confirmed: true, date: "2026-10-01" }, now)).toEqual({ ok: true, mode: "DEEPSEEK" });
    expect(await getAiMode()).toBe("DEEPSEEK");
    expect((await getOptOutConfirmedAt())?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(await setAiMode("RULES")).toEqual({ ok: true, mode: "RULES" });
    expect(await getAiMode()).toBe("RULES");
    expect(await db.auditLog.count({ where: { action: "settings.ai_mode" } })).toBe(2);
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
