import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  clearDatasetCache,
  DATAREQUESTS_SHA_URL,
  lookupDatarequests,
  lookupJdm,
  readTarGz,
  refreshDatasets,
  SOURCE,
  supervisoryAuthorities,
} from "@/lib/enrich/datasets";
import { resetDb } from "./helpers";
import { host, netState, resetNet } from "./net-mocks";

vi.mock("node:dns/promises", async () => (await import("./net-mocks")).dnsModule);
vi.mock("undici", async () => (await import("./net-mocks")).undiciModule);

const FIX = path.join(__dirname, "fixtures/datasets");
const TARBALL = readFileSync(path.join(FIX, "datarequests-master.tar.gz"));
const JDM = readFileSync(path.join(FIX, "jdm-sites.json"));
const SHA = "a".repeat(40);

function routes(opts: { sha?: string | null } = {}) {
  host("api.github.com");
  host("codeload.github.com");
  host("raw.githubusercontent.com");
  resetNetRoutes(opts);
}

function resetNetRoutes(opts: { sha?: string | null }) {
  netState.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === DATAREQUESTS_SHA_URL) return opts.sha ? new Response(opts.sha) : new Response("rate limited", { status: 403 });
    if (url.startsWith("https://codeload.github.com/datenanfragen/data/")) return new Response(TARBALL);
    if (url.startsWith("https://raw.githubusercontent.com/jdm-contrib/jdm/")) return new Response(JDM, { headers: { "content-type": "text/plain" } });
    throw new Error(`Unmocked fetch: ${url}`);
  };
}

describe("dataset tarball reader", () => {
  it("reads ustar + pax long names and the global comment", () => {
    const { files, globalComment } = readTarGz(TARBALL, (p) => p.endsWith(".json"));
    expect(globalComment).toBe("0123456789abcdef0123456789abcdef01234567");
    expect([...files.keys()]).toContain(
      "data-master/companies/a-company-with-a-very-long-slug-that-exceeds-the-one-hundred-character-ustar-name-field-limit-x.json",
    );
    expect(files.has("data-master/templates/custom.txt")).toBe(false);
  });
});

describe("refreshDatasets", () => {
  beforeEach(async () => {
    await resetDb();
    resetNet();
    clearDatasetCache();
  });

  it("stores datarequests companies, authorities and JustDeleteMe with version + fetchedAt", async () => {
    routes({ sha: SHA });
    const { results, errors } = await refreshDatasets();
    expect(errors).toEqual([]);
    expect(results).toEqual([
      { source: SOURCE.companies, version: SHA, count: 5, skipped: false },
      { source: SOURCE.authorities, version: SHA, count: 2, skipped: false },
      { source: SOURCE.jdm, version: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), count: 4, skipped: false },
    ]);
    const snaps = await db.datasetSnapshot.findMany({ orderBy: { source: "asc" } });
    expect(snaps.map((s) => s.source)).toEqual([SOURCE.authorities, SOURCE.companies, SOURCE.jdm]);
    for (const s of snaps) expect(s.fetchedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // All dataset traffic went through the guarded fetch with our UA.
    expect(netState.calls.map((c) => c.url.hostname)).toEqual(["api.github.com", "codeload.github.com", "raw.githubusercontent.com"]);
  });

  it("falls back to the tarball's commit comment when the API is unavailable", async () => {
    routes({ sha: null });
    await refreshDatasets();
    const snap = await db.datasetSnapshot.findUniqueOrThrow({ where: { source: SOURCE.companies } });
    expect(snap.version).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("skips fresh snapshots, and an unchanged commit when forced", async () => {
    routes({ sha: SHA });
    await refreshDatasets();
    netState.calls.length = 0;
    const again = await refreshDatasets();
    expect(again.results.every((r) => r.skipped)).toBe(true);
    expect(netState.calls).toHaveLength(0);

    const forced = await refreshDatasets({ force: true });
    // Forced: the SHA is checked, and the tarball is downloaded again regardless.
    expect(forced.results.find((r) => r.source === SOURCE.companies)?.skipped).toBe(false);

    netState.calls.length = 0;
    const stale = await refreshDatasets({ maxAgeDays: 0 });
    expect(stale.results.find((r) => r.source === SOURCE.companies)?.skipped).toBe(true);
    expect(netState.calls.map((c) => c.url.hostname)).toEqual(["api.github.com", "raw.githubusercontent.com"]);
  });

  it("keeps the old snapshot when a source fails", async () => {
    routes({ sha: SHA });
    await refreshDatasets();
    netState.fetch = async () => new Response("down", { status: 503 });
    const { errors } = await refreshDatasets({ force: true });
    expect(errors.map((e) => e.source).sort()).toEqual([SOURCE.companies, SOURCE.jdm]);
    expect(await db.datasetSnapshot.count()).toBe(3);
  });
});

describe("dataset lookups", () => {
  beforeEach(async () => {
    await resetDb();
    resetNet();
    clearDatasetCache();
    routes({ sha: SHA });
    await refreshDatasets();
  });

  it("finds datarequests records by website domain, preferring the global verified record", async () => {
    const s = await lookupDatarequests("open.spotify.com");
    expect(s).toMatchObject({ slug: "spotify", email: "privacy@spotify.com", relevantCountries: ["all"], domain: "spotify.com" });
    expect(await lookupDatarequests("acme-shop.de")).toMatchObject({ slug: "acme-shop", webform: expect.stringContaining("onetrust.com"), email: null });
    expect(await lookupDatarequests("unknown.com")).toBeNull();
  });

  it("finds JustDeleteMe entries by domains[] or URL host; never free-mail domains", async () => {
    expect(await lookupJdm("spotify.com")).toMatchObject({ url: "https://support.spotify.com/article/close-account/" });
    expect(await lookupJdm("shopco.com")).toMatchObject({ name: "Shopco", email: "support@shopco.com" });
    expect(await lookupJdm("gmail.com")).toBeNull();
  });

  it("lists supervisory authorities by country", async () => {
    expect((await supervisoryAuthorities("IE")).map((a) => a.slug)).toEqual(["ie-dpc"]);
    expect(await supervisoryAuthorities()).toHaveLength(2);
  });
});
