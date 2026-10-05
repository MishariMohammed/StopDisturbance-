import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, safeFetch, SafeFetchError, USER_AGENT } from "@/lib/net/safe-fetch";
import { host, netState, PUBLIC_IP, PUBLIC_IP6, resetNet, setRoutes } from "./net-mocks";

vi.mock("node:dns/promises", async () => (await import("./net-mocks")).dnsModule);
vi.mock("undici", async () => (await import("./net-mocks")).undiciModule);

const ok = (body = "ok", init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

async function refused(url: string, code = "BLOCKED_ADDRESS", opts = {}) {
  const err = await safeFetch(url, opts).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SafeFetchError);
  expect((err as SafeFetchError).code).toBe(code);
}

describe("isPublicAddress", () => {
  it("accepts public unicast v4/v6 and rejects every private class", () => {
    expect(isPublicAddress(PUBLIC_IP)).toBe(true);
    expect(isPublicAddress(PUBLIC_IP6)).toBe(true);
    for (const a of [
      "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "255.255.255.255", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "64:ff9b::a00:1", "not-an-ip",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
  });
});

describe("safeFetch SSRF guard", () => {
  beforeEach(() => resetNet([[/.*/, () => ok()]]));

  it("refuses literal private, loopback, link-local, ULA and v4-mapped targets without connecting", async () => {
    await refused("https://127.0.0.1/");
    await refused("https://10.1.2.3/x");
    await refused("https://169.254.169.254/latest/meta-data/");
    await refused("https://[::1]/");
    await refused("https://[fc00::1]/");
    await refused("https://[fd00::abcd]/");
    await refused("https://[::ffff:127.0.0.1]/");
    await refused("https://localhost/");
    expect(netState.calls).toHaveLength(0);
  });

  it("refuses a hostname that resolves to a private IP (any record)", async () => {
    host("internal.example.com", "10.0.0.5");
    await refused("https://internal.example.com/");
    host("mixed.example.com", PUBLIC_IP, "127.0.0.1");
    await refused("https://mixed.example.com/");
    host("v6.example.com", "fe80::1");
    await refused("https://v6.example.com/");
    expect(netState.calls).toHaveLength(0);
  });

  it("re-validates every redirect hop and refuses a redirect to a private IP", async () => {
    host("public.example.com");
    host("evil.example.com", "192.168.0.10");
    setRoutes([
      [/public\.example\.com\/a/, () => redirect("https://evil.example.com/steal")],
      [/public\.example\.com\/b/, () => redirect("https://169.254.169.254/latest/meta-data/")],
      [/.*/, () => ok()],
    ]);
    await refused("https://public.example.com/a");
    await refused("https://public.example.com/b");
    expect(netState.calls.map((c) => c.url.hostname)).toEqual(["public.example.com", "public.example.com"]);
  });

  it("only allows https (http only on explicit opt-in) and standard ports", async () => {
    host("site.example.com");
    await refused("http://site.example.com/", "BAD_SCHEME");
    await refused("ftp://site.example.com/", "BAD_SCHEME");
    await refused("https://site.example.com:8443/", "BAD_URL");
    await refused("https://user:pw@site.example.com/", "BAD_URL");
    const res = await safeFetch("http://site.example.com/", { allowHttp: true });
    expect(res.status).toBe(200);
    // A redirect from https down to http is refused without the opt-in.
    setRoutes([[/.*/, () => redirect("http://site.example.com/plain")]]);
    await refused("https://site.example.com/", "BAD_SCHEME");
  });

  it("pins the connection to the vetted address", async () => {
    host("pinned.example.com", PUBLIC_IP);
    await safeFetch("https://pinned.example.com/");
    const call = netState.calls[0];
    expect(call.init?.dispatcher).toBeDefined();
    const lookup = netState.agents[0].connect.lookup;
    const single = vi.fn();
    lookup("pinned.example.com", {}, single);
    expect(single).toHaveBeenCalledWith(null, PUBLIC_IP, 4);
    const all = vi.fn();
    lookup("anything-else.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC_IP, family: 4 }]);
  });
});

describe("safeFetch limits and headers", () => {
  beforeEach(() => {
    resetNet();
    host("site.example.com");
    host("other.example.com");
  });

  it("follows at most 3 redirects", async () => {
    let n = 0;
    setRoutes([[/.*/, () => (n++ < 3 ? redirect(`/hop${n}`) : ok("done"))]]);
    const res = await safeFetch("https://site.example.com/start");
    expect(res.text()).toBe("done");
    expect(res.redirects).toBe(3);
    expect(res.url).toBe("https://site.example.com/hop3");

    n = 0;
    setRoutes([[/.*/, () => (n++ < 4 ? redirect(`https://other.example.com/hop${n}`) : ok())]]);
    await refused("https://site.example.com/start", "TOO_MANY_REDIRECTS");
  });

  it("caps the response size (declared or streamed)", async () => {
    setRoutes([[/.*/, () => new Response("x".repeat(3 * 1024 * 1024))]]);
    await refused("https://site.example.com/big", "TOO_LARGE");
    setRoutes([[/.*/, () => new Response("x".repeat(100), { headers: { "content-length": String(50 * 1024 * 1024) } })]]);
    await refused("https://site.example.com/declared", "TOO_LARGE");
    setRoutes([[/.*/, () => new Response("x".repeat(2000))]]);
    await refused("https://site.example.com/small-cap", "TOO_LARGE", { maxBytes: 1000 });
    const res = await safeFetch("https://site.example.com/fits", { maxBytes: 5000 });
    expect(res.body.length).toBe(2000);
  });

  it("times out", async () => {
    setRoutes([
      [
        /.*/,
        (_u, init) =>
          new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      ],
    ]);
    await refused("https://site.example.com/slow", "TIMEOUT", { timeoutMs: 50 });
  });

  it("sends our UA and never cookies, Referer or Authorization; POST becomes GET after 303", async () => {
    setRoutes([
      [/\/post$/, () => redirect("/done", 303)],
      [/.*/, () => ok()],
    ]);
    await safeFetch("https://site.example.com/post", {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
      headers: { "content-type": "application/x-www-form-urlencoded", Cookie: "a=b", Referer: "https://x", Authorization: "Bearer t", "User-Agent": "spoof" },
    });
    const [first, second] = netState.calls;
    const h = first.init?.headers as Record<string, string>;
    expect(h["user-agent"]).toBe(USER_AGENT);
    expect(Object.keys(h).map((k) => k.toLowerCase()).sort()).toEqual(["content-type", "user-agent"]);
    expect(first.init?.method).toBe("POST");
    expect(first.init?.body).toBe("List-Unsubscribe=One-Click");
    expect(first.init?.redirect).toBe("manual");
    expect(second.init?.method).toBe("GET");
    expect(second.init?.body).toBeUndefined();
  });

  it("reports DNS failures", async () => {
    await refused("https://nowhere.example.com/", "DNS");
  });
});
