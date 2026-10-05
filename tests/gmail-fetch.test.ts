import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getMessageMetadata, gmailFetch } from "@/lib/mail/gmail";
import { json, mockFetch } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("gmailFetch guard", () => {
  it.each(["full", "raw"])("refuses format=%s", async (format) => {
    await expect(gmailFetch("t", "/messages/1", { method: "messages.get", query: { format } })).rejects.toThrow(/not allowed/);
  });

  it("refuses attachment paths", async () => {
    await expect(gmailFetch("t", "/messages/1/attachments/2", { method: "messages.get" })).rejects.toThrow(/not allowed/);
  });

  it("requests metadata with the header allow-list only", async () => {
    const m = mockFetch([[/messages\/1/, () => json({ id: "1" })]]);
    vi.stubGlobal("fetch", m.fn);
    await getMessageMetadata("t", "1");
    const url = m.calls[0];
    expect(url.searchParams.get("format")).toBe("metadata");
    expect(url.searchParams.getAll("metadataHeaders")).toContain("List-Unsubscribe-Post");
    expect(url.searchParams.getAll("metadataHeaders")).not.toContain("Cc");
  });

  it("no scan code passes format=full anywhere in src/lib/mail", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(path.resolve(__dirname, "../src/lib/mail"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/format:\s*["'](full|raw)["']/);
      expect(src, f).not.toMatch(/format=(full|raw)(?!\|)/);
    }
  });
});

describe("throttling", () => {
  it("backs off on 429 using Retry-After, then resumes", async () => {
    let n = 0;
    const m = mockFetch([
      [/profile/, () => (n++ < 2 ? new Response("slow down", { status: 429, headers: { "retry-after": "3" } }) : json({ emailAddress: "a@b.c", historyId: "1" }))],
    ]);
    vi.stubGlobal("fetch", m.fn);
    const sleeps: number[] = [];
    const res = await gmailFetch<{ historyId: string }>("t", "/profile", {
      method: "getProfile",
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(res.historyId).toBe("1");
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("treats 403 rateLimitExceeded as throttling and gives up after maxAttempts", async () => {
    const m = mockFetch([[/profile/, () => json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403)]]);
    vi.stubGlobal("fetch", m.fn);
    await expect(
      gmailFetch("t", "/profile", { method: "getProfile", sleep: async () => {}, maxAttempts: 3 }),
    ).rejects.toThrow("gmail_http_403");
    expect(m.calls).toHaveLength(3);
  });
});
