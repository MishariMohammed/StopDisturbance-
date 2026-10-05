import { describe, expect, it } from "vitest";
import { hashAddress, parseAddress, parseHeaders, registrableDomain } from "@/lib/mail/headers";
import { marketingMsg, sentMsg } from "./fixtures/gmail";

describe("parseHeaders", () => {
  const p = parseHeaders(marketingMsg.payload!.headers!)!;

  it("extracts the sender and registrable domains", () => {
    expect(p.fromAddress).toBe("deals@em.noon.com");
    expect(p.fromName).toBe("Noon Deals");
    expect(p.fromDomain).toBe("noon.com");
    expect(p.returnPathDomain).toBe("noon.com");
    expect(p.dkimDomains).toEqual(["em.noon.com"]);
  });

  it("detects RFC 8058 one-click with DKIM coverage of both headers", () => {
    expect(p.oneClick).toBe(true);
    expect(p.dkimPass).toBe(true);
    expect(p.dkimCoversListUnsub).toBe(true);
    expect(p.listUnsubHttps).toBe("https://em.noon.com/u?t=SECRET123");
    expect(p.listUnsubMailto).toBe("mailto:unsub@em.noon.com?subject=u");
  });

  it("does not trust a DKIM signature that did not pass", () => {
    const headers = marketingMsg.payload!.headers!.map((h) =>
      h.name === "Authentication-Results" ? { ...h, value: "mx.google.com; dkim=fail header.i=@em.noon.com" } : h,
    );
    const q = parseHeaders(headers)!;
    expect(q.dkimPass).toBe(false);
    expect(q.dkimCoversListUnsub).toBe(false);
  });

  it("does not count coverage when h= omits List-Unsubscribe-Post", () => {
    const headers = marketingMsg.payload!.headers!.map((h) =>
      h.name === "DKIM-Signature" ? { ...h, value: "v=1; d=em.noon.com; h=from:list-unsubscribe; b=x" } : h,
    );
    expect(parseHeaders(headers)!.dkimCoversListUnsub).toBe(false);
  });

  it("hashes To addresses instead of keeping them", () => {
    const s = parseHeaders(sentMsg.payload!.headers!)!;
    expect(s.toHashes).toEqual([hashAddress("friend@gmail.com"), hashAddress("other@hotmail.com")]);
    expect(JSON.stringify(s)).not.toContain("friend@gmail.com");
  });

  it("returns null without a From", () => {
    expect(parseHeaders([{ name: "Subject", value: "x" }])).toBeNull();
  });
});

describe("address helpers", () => {
  it("parses bare and named addresses", () => {
    expect(parseAddress("a@B.com")).toEqual({ address: "a@b.com", name: null });
    expect(parseAddress('"Al Rajhi" <info@alrajhibank.com.sa>')).toEqual({ address: "info@alrajhibank.com.sa", name: "Al Rajhi" });
  });

  it("uses the public suffix list", () => {
    expect(registrableDomain("x@mail.alrajhibank.com.sa")).toBe("alrajhibank.com.sa");
    expect(registrableDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
  });
});
