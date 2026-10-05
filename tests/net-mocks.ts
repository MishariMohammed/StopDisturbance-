import { vi } from "vitest";
import { mockFetch } from "./helpers";

// Shared DNS + undici mocks for safeFetch users. In a test file:
//   vi.mock("node:dns/promises", async () => (await import("./net-mocks")).dnsModule);
//   vi.mock("undici", async () => (await import("./net-mocks")).undiciModule);

type Route = Parameters<typeof mockFetch>[0][number];

export const dnsState = {
  hosts: new Map<string, string[]>(),
  mx: new Map<string, { exchange: string; priority: number }[]>(),
};

const dnsError = (code: string) => Object.assign(new Error(code), { code });

export const dnsModule = {
  lookup: vi.fn(async (host: string) => {
    const ips = dnsState.hosts.get(host.toLowerCase());
    if (!ips) throw dnsError("ENOTFOUND");
    return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
  resolveMx: vi.fn(async (domain: string) => {
    const mx = dnsState.mx.get(domain.toLowerCase());
    if (!mx) throw dnsError("ENODATA");
    return mx;
  }),
};

export type Captured = { url: URL; init?: RequestInit & { dispatcher?: unknown } };

export const netState = {
  fetch: mockFetch([]).fn,
  calls: [] as Captured[],
  agents: [] as { connect: { lookup: (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void } }[],
};

export const undiciModule = {
  fetch: async (input: string | URL, init?: RequestInit) => {
    netState.calls.push({ url: new URL(String(input)), init });
    return netState.fetch(input, init);
  },
  Agent: class {
    constructor(opts: (typeof netState.agents)[number]) {
      netState.agents.push(opts);
    }
    close() {
      return Promise.resolve();
    }
  },
};

/** Public test IPs (TEST-NET would be "reserved"; these are ordinary unicast). */
export const PUBLIC_IP = "93.184.216.34";
export const PUBLIC_IP6 = "2606:2800:220:1:248:1893:25c8:1946";

export function resetNet(routes: Route[] = []) {
  dnsState.hosts.clear();
  dnsState.mx.clear();
  netState.calls.length = 0;
  netState.agents.length = 0;
  netState.fetch = mockFetch(routes).fn;
  dnsModule.lookup.mockClear();
  dnsModule.resolveMx.mockClear();
}

export function setRoutes(routes: Route[]) {
  netState.fetch = mockFetch(routes).fn;
}

export function host(name: string, ...ips: string[]) {
  dnsState.hosts.set(name.toLowerCase(), ips.length ? ips : [PUBLIC_IP]);
}

export const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

export const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
