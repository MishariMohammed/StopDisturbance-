import { afterEach, describe, expect, it, vi } from "vitest";
import { gmailFetch } from "@/lib/mail/gmail";
import { graphFetch } from "@/lib/mail/graph";
import { gmailFetchReplyBody, graphFetchReplyBody, ReplyBodyGuardError } from "@/lib/track/reply-body";
import { json } from "./helpers";
import { gmailFake } from "./m5-helpers";

afterEach(() => vi.unstubAllGlobals());

const RAW = "From: a@b.example\r\nSubject: x\r\n\r\nbody text\r\n";

describe("guarded reply-body fetch (00-brief §8)", () => {
  const messages = {
    reply: { threadId: "t-ours", headers: [], raw: RAW },
    split: { threadId: "t-ticket", headers: [{ name: "In-Reply-To", value: "<orig@localhost>" }], raw: RAW },
    dsn: { threadId: "t-dsn", headers: [{ name: "References", value: "<x@y> <ORIG@localhost>" }], raw: RAW },
    personal: { threadId: "t-personal", headers: [{ name: "In-Reply-To", value: "<someone-else@x>" }], raw: "PRIVATE" },
  };

  it("Gmail: allows our threads and messages/DSNs referencing our Message-ID; refuses everything else before any body request", async () => {
    const g = gmailFake({ messages });
    vi.stubGlobal("fetch", g.fn);
    expect((await gmailFetchReplyBody("AT", "reply", ["t-ours"])).toString()).toContain("body text");
    expect((await gmailFetchReplyBody("AT", "split", ["t-ours"], ["<orig@localhost>"])).toString()).toContain("body text");
    expect((await gmailFetchReplyBody("AT", "dsn", [], ["orig@localhost"])).toString()).toContain("body text");

    g.calls.length = 0;
    await expect(gmailFetchReplyBody("AT", "personal", ["t-ours"], ["<orig@localhost>"])).rejects.toBeInstanceOf(ReplyBodyGuardError);
    await expect(gmailFetchReplyBody("AT", "reply", [], [])).rejects.toBeInstanceOf(ReplyBodyGuardError);
    // Only metadata was requested for the refused messages.
    expect(g.calls.every((c) => c.url.searchParams.get("format") === "metadata")).toBe(true);
    expect(g.calls.some((c) => c.url.searchParams.get("format") === "raw")).toBe(false);
  });

  it("Graph: same guard on conversationId / In-Reply-To before GET $value", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      const id = decodeURIComponent(url.pathname.split("/messages/")[1].split("/")[0]);
      if (url.pathname.endsWith("/$value")) return new Response(RAW);
      if (id === "ours") return json({ conversationId: "c-ours", internetMessageHeaders: [] });
      if (id === "split") return json({ conversationId: "c-x", internetMessageHeaders: [{ name: "References", value: "<orig@localhost>" }] });
      return json({ conversationId: "c-personal", internetMessageHeaders: [] });
    });
    expect((await graphFetchReplyBody("AT", "ours", ["c-ours"])).toString()).toContain("body text");
    expect((await graphFetchReplyBody("AT", "split", [], ["<orig@localhost>"])).toString()).toContain("body text");
    calls.length = 0;
    await expect(graphFetchReplyBody("AT", "personal", ["c-ours"], ["<orig@localhost>"])).rejects.toBeInstanceOf(ReplyBodyGuardError);
    expect(calls.some((c) => c.includes("$value"))).toBe(false);
    expect(calls[0]).toContain("%24select=conversationId%2CinternetMessageHeaders");
  });

  it("the scan wrappers still refuse body access", async () => {
    await expect(gmailFetch("AT", "/messages/x", { method: "messages.get", query: { format: "raw" } })).rejects.toThrow(/not allowed/);
    await expect(graphFetch("AT", "/messages/x/$value")).rejects.toThrow(/not allowed/);
  });
});
