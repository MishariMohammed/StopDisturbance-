import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { registrableDomain } from "@/lib/mail/headers";
import { safeFetch } from "@/lib/net/safe-fetch";
import { isBrandable } from "@/lib/scan/signals";

// Open contact datasets (01-research §2.1), refreshed into DatasetSnapshot and looked up by domain.
//
// Sources:
// - datarequests.org company + supervisory-authority records (CC0 1.0): the datenanfragen/data repo has
//   one JSON file per record and no single-file export, so we download the GitHub tarball of `master`
//   (one request) and read `companies/*.json` + `supervisory-authorities/*.json` from it. The version is
//   the commit SHA (GitHub API, falling back to the tarball's pax `comment=` header, then a content hash).
// - JustDeleteMe `_data/sites.json` (MIT), from the maintained jdm-contrib/jdm repo.
// Only the fields the cascade needs are stored.

export const DATAREQUESTS_TARBALL_URL = "https://codeload.github.com/datenanfragen/data/tar.gz/refs/heads/master";
export const DATAREQUESTS_SHA_URL = "https://api.github.com/repos/datenanfragen/data/commits/master";
export const JDM_SITES_URL = "https://raw.githubusercontent.com/jdm-contrib/jdm/master/_data/sites.json";

export const SOURCE = {
  companies: "datarequests.companies",
  authorities: "datarequests.authorities",
  jdm: "justdeleteme.sites",
} as const;

export type DrCompany = {
  slug: string;
  name: string;
  web: string | null;
  email: string | null;
  webform: string | null;
  address: string | null;
  relevantCountries: string[];
  runs: string[];
  requestLanguage: string | null;
  quality: string | null;
  /** Registrable domain of `web`. */
  domain: string | null;
  /** Registrable domain of `email` (secondary match key). */
  emailDomain: string | null;
};

export type SupervisoryAuthority = {
  slug: string;
  name: string;
  relevantCountries: string[];
  email: string | null;
  webform: string | null;
  web: string | null;
  address: string | null;
  complaintLanguage: string | null;
};

export type JdmSite = {
  name: string;
  url: string;
  difficulty: string | null;
  email: string | null;
  domains: string[];
};

// ---------- tar.gz reader (ustar + pax + GNU long names; enough for GitHub tarballs) ----------

export function readTarGz(gz: Buffer, want: (path: string) => boolean): { files: Map<string, string>; globalComment: string | null } {
  const tar = gunzipSync(gz, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map<string, string>();
  let globalComment: string | null = null;
  let nextPath: string | null = null;
  const str = (b: Buffer) => b.toString("utf8").replace(/\0.*$/s, "");
  const paxRecords = (b: Buffer) => {
    const out: Record<string, string> = {};
    let i = 0;
    while (i < b.length) {
      const sp = b.indexOf(0x20, i);
      if (sp < 0) break;
      const len = Number(b.subarray(i, sp).toString());
      if (!len) break;
      const rec = b.subarray(sp + 1, i + len - 1).toString("utf8");
      const eq = rec.indexOf("=");
      if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
      i += len;
    }
    return out;
  };
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = str(h.subarray(345, 500));
    const name = str(h.subarray(0, 100));
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") {
      globalComment = paxRecords(data).comment ?? globalComment;
      continue;
    }
    if (type === "x") {
      nextPath = paxRecords(data).path ?? null;
      continue;
    }
    if (type === "L") {
      nextPath = str(data);
      continue;
    }
    const path = nextPath ?? (prefix ? `${prefix}/${name}` : name);
    nextPath = null;
    if ((type === "0" || type === "\0" || type === "7") && want(path)) files.set(path, data.toString("utf8"));
  }
  return { files, globalComment };
}

// ---------- parsing ----------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function hostDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

export function parseDrCompany(raw: Record<string, unknown>): DrCompany | null {
  const slug = str(raw.slug);
  const name = str(raw.name);
  if (!slug || !name) return null;
  const web = str(raw.web);
  const email = str(raw.email)?.toLowerCase() ?? null;
  const emailDomain = email?.includes("@") ? registrableDomain(email) : null;
  return {
    slug,
    name,
    web,
    email,
    webform: str(raw.webform),
    address: str(raw.address),
    relevantCountries: strs(raw["relevant-countries"]),
    runs: strs(raw.runs),
    requestLanguage: str(raw["request-language"]),
    quality: str(raw.quality),
    domain: hostDomain(web),
    emailDomain: isBrandable(emailDomain) ? emailDomain : null,
  };
}

export function parseAuthority(raw: Record<string, unknown>): SupervisoryAuthority | null {
  const slug = str(raw.slug);
  const name = str(raw.name);
  if (!slug || !name) return null;
  return {
    slug,
    name,
    relevantCountries: strs(raw["relevant-countries"]),
    email: str(raw.email),
    webform: str(raw.webform),
    web: str(raw.web),
    address: str(raw.address),
    complaintLanguage: str(raw["complaint-language"]),
  };
}

export function parseJdmSites(raw: unknown): JdmSite[] {
  if (!Array.isArray(raw)) throw new Error("JustDeleteMe sites.json: array expected");
  const out: JdmSite[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const name = str(r?.name);
    const url = str(r?.url);
    if (!name || !url || !/^https?:\/\//i.test(url)) continue;
    const domains = new Set<string>();
    for (const d of strs(r.domains)) domains.add(registrableDomain(d));
    const own = hostDomain(url);
    if (own) domains.add(own);
    out.push({ name, url, difficulty: str(r.difficulty), email: str(r.email)?.toLowerCase() ?? null, domains: [...domains].filter(isBrandable) });
  }
  return out;
}

// ---------- refresh ----------

export type RefreshResult = { source: string; version: string; count: number; skipped: boolean };

async function saveSnapshot(source: string, version: string, data: unknown) {
  const json = data as Prisma.InputJsonValue;
  const fetchedAt = new Date();
  await db.datasetSnapshot.upsert({
    where: { source },
    create: { source, version, fetchedAt, data: json },
    update: { version, fetchedAt, data: json },
  });
  cache.delete(source);
}

async function touchSnapshot(source: string) {
  await db.datasetSnapshot.update({ where: { source }, data: { fetchedAt: new Date() } });
}

async function isFresh(source: string, maxAgeMs: number): Promise<boolean> {
  const row = await db.datasetSnapshot.findUnique({ where: { source }, select: { fetchedAt: true } });
  return Boolean(row && Date.now() - row.fetchedAt.getTime() < maxAgeMs);
}

async function remoteSha(): Promise<string | null> {
  try {
    const res = await safeFetch(DATAREQUESTS_SHA_URL, { headers: { accept: "application/vnd.github.sha" }, maxBytes: 4096 });
    const sha = res.ok ? res.text().trim() : "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

const shortHash = (b: Buffer | string) => `sha256:${createHash("sha256").update(b).digest("hex").slice(0, 16)}`;

async function refreshDatarequests(force: boolean): Promise<RefreshResult[]> {
  const sha = await remoteSha();
  const current = await db.datasetSnapshot.findMany({ where: { source: { in: [SOURCE.companies, SOURCE.authorities] } } });
  if (!force && sha && current.length === 2 && current.every((c) => c.version === sha)) {
    for (const c of current) await touchSnapshot(c.source);
    return current.map((c) => ({ source: c.source, version: c.version, count: (c.data as { records?: unknown[] }).records?.length ?? 0, skipped: true }));
  }
  const res = await safeFetch(DATAREQUESTS_TARBALL_URL, { maxBytes: 64 * 1024 * 1024, timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`datarequests tarball: HTTP ${res.status}`);
  const { files, globalComment } = readTarGz(res.body, (p) => /^[^/]+\/(companies|supervisory-authorities)\/[^/]+\.json$/.test(p));
  const version = sha ?? (globalComment && /^[0-9a-f]{40}$/.test(globalComment) ? globalComment : shortHash(res.body));

  const companies: DrCompany[] = [];
  const authorities: SupervisoryAuthority[] = [];
  let bad = 0;
  for (const [path, text] of files) {
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      const rec = path.includes("/companies/") ? parseDrCompany(raw) : parseAuthority(raw);
      if (!rec) bad++;
      else if (path.includes("/companies/")) companies.push(rec as DrCompany);
      else authorities.push(rec as SupervisoryAuthority);
    } catch {
      bad++;
    }
  }
  if (!companies.length) throw new Error("datarequests tarball: no company records found");
  if (bad) logger.warn({ bad }, "datarequests: skipped invalid records");
  companies.sort((a, b) => a.slug.localeCompare(b.slug));
  authorities.sort((a, b) => a.slug.localeCompare(b.slug));
  await saveSnapshot(SOURCE.companies, version, { records: companies });
  await saveSnapshot(SOURCE.authorities, version, { records: authorities });
  return [
    { source: SOURCE.companies, version, count: companies.length, skipped: false },
    { source: SOURCE.authorities, version, count: authorities.length, skipped: false },
  ];
}

async function refreshJdm(): Promise<RefreshResult> {
  const res = await safeFetch(JDM_SITES_URL, { maxBytes: 16 * 1024 * 1024, timeoutMs: 60_000 });
  if (!res.ok) throw new Error(`JustDeleteMe sites.json: HTTP ${res.status}`);
  const sites = parseJdmSites(res.json());
  if (!sites.length) throw new Error("JustDeleteMe sites.json: no sites");
  const version = shortHash(res.body);
  await saveSnapshot(SOURCE.jdm, version, { sites });
  return { source: SOURCE.jdm, version, count: sites.length, skipped: false };
}

/**
 * Refresh job (`datasets.refresh`, weekly is plenty). Sources fresher than `maxAgeDays` are skipped
 * unless `force`. One failing source doesn't block the other; its old snapshot stays in use.
 */
export async function refreshDatasets(opts: { force?: boolean; maxAgeDays?: number } = {}): Promise<{ results: RefreshResult[]; errors: { source: string; error: string }[] }> {
  const maxAgeMs = (opts.maxAgeDays ?? 7) * 24 * 3600 * 1000;
  const results: RefreshResult[] = [];
  const errors: { source: string; error: string }[] = [];
  const run = async (source: string, fn: () => Promise<RefreshResult | RefreshResult[]>) => {
    if (!opts.force && (await isFresh(source, maxAgeMs))) {
      const row = await db.datasetSnapshot.findUnique({ where: { source }, select: { version: true } });
      results.push({ source, version: row!.version, count: -1, skipped: true });
      return;
    }
    try {
      const r = await fn();
      results.push(...(Array.isArray(r) ? r : [r]));
    } catch (err) {
      errors.push({ source, error: (err as Error).message });
      logger.warn({ source, err: (err as Error).name }, "dataset refresh failed");
    }
  };
  await run(SOURCE.companies, () => refreshDatarequests(Boolean(opts.force)));
  await run(SOURCE.jdm, refreshJdm);
  return { results, errors };
}

// ---------- lookup ----------

type Loaded<T> = { fetchedAt: number; version: string; value: T };
const cache = new Map<string, Loaded<unknown>>();

async function load<T>(source: string, build: (data: unknown) => T): Promise<T | null> {
  const meta = await db.datasetSnapshot.findUnique({ where: { source }, select: { fetchedAt: true, version: true } });
  if (!meta) return null;
  const hit = cache.get(source) as Loaded<T> | undefined;
  if (hit && hit.version === meta.version && hit.fetchedAt <= meta.fetchedAt.getTime()) return hit.value;
  const row = await db.datasetSnapshot.findUnique({ where: { source } });
  if (!row) return null;
  const value = build(row.data);
  cache.set(source, { fetchedAt: row.fetchedAt.getTime(), version: row.version, value });
  return value;
}

type DrIndex = { byDomain: Map<string, DrCompany[]>; byEmailDomain: Map<string, DrCompany[]> };

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

const rank = (c: DrCompany) => (c.relevantCountries.includes("all") ? 0 : 2) + (c.quality === "verified" ? 0 : 1);

/** Datarequests record for a registrable domain (by website, then by privacy-email domain). */
export async function lookupDatarequests(domain: string): Promise<DrCompany | null> {
  const idx = await load<DrIndex>(SOURCE.companies, (data) => {
    const byDomain = new Map<string, DrCompany[]>();
    const byEmailDomain = new Map<string, DrCompany[]>();
    for (const c of (data as { records: DrCompany[] }).records ?? []) {
      if (c.domain) push(byDomain, c.domain, c);
      if (c.emailDomain) push(byEmailDomain, c.emailDomain, c);
    }
    return { byDomain, byEmailDomain };
  });
  if (!idx) return null;
  const d = registrableDomain(domain);
  const hits = idx.byDomain.get(d) ?? idx.byEmailDomain.get(d);
  if (!hits?.length) return null;
  return [...hits].sort((a, b) => rank(a) - rank(b) || a.slug.length - b.slug.length || a.slug.localeCompare(b.slug))[0];
}

/** JustDeleteMe entry for a registrable domain. */
export async function lookupJdm(domain: string): Promise<JdmSite | null> {
  const idx = await load<Map<string, JdmSite>>(SOURCE.jdm, (data) => {
    const m = new Map<string, JdmSite>();
    for (const s of (data as { sites: JdmSite[] }).sites ?? []) for (const d of s.domains) if (!m.has(d)) m.set(d, s);
    return m;
  });
  return idx?.get(registrableDomain(domain)) ?? null;
}

/** Supervisory authorities, optionally only those relevant for an ISO country code (e.g. "ie"). */
export async function supervisoryAuthorities(country?: string): Promise<SupervisoryAuthority[]> {
  const list = await load<SupervisoryAuthority[]>(SOURCE.authorities, (data) => (data as { records: SupervisoryAuthority[] }).records ?? []);
  if (!list) return [];
  if (!country) return list;
  const c = country.toLowerCase();
  return list.filter((a) => a.relevantCountries.includes(c));
}

/** For tests: forget parsed indexes. */
export function clearDatasetCache() {
  cache.clear();
}
