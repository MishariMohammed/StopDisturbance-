import type { DecisionValue } from "@prisma/client";
import { matchesQuery } from "./normalize";
import type { CompanyRow } from "./types";

// URL-synced filters for /companies (04-ux §5.2). Defaults are omitted from the query string.

export const CATEGORIES = ["all", "ads", "data", "both"] as const;
export const DECISION_FILTERS = ["all", "undecided", "remove", "unsubscribe", "keep"] as const;
export const CONFIDENCE_FILTERS = ["all", "high", "medium", "low"] as const;
export const SEEN_FILTERS = ["all", "30d", "1y", "older"] as const;
export const SORTS = ["emails", "recent", "oldest", "az"] as const;

export type Category = (typeof CATEGORIES)[number];
export type DecisionFilter = (typeof DECISION_FILTERS)[number];
export type ConfidenceFilter = (typeof CONFIDENCE_FILTERS)[number];
export type SeenFilter = (typeof SEEN_FILTERS)[number];
export type Sort = (typeof SORTS)[number];

export type Filters = {
  cat: Category;
  decision: DecisionFilter;
  confidence: ConfidenceFilter;
  seen: SeenFilter;
  mailbox: string;
  sort: Sort;
  q: string;
};

export const DEFAULT_FILTERS: Filters = {
  cat: "all",
  decision: "all",
  confidence: "all",
  seen: "all",
  mailbox: "",
  sort: "emails",
  q: "",
};

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function get(sp: Params, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

function oneOf<T extends string>(allowed: readonly T[], v: string | undefined, fallback: T): T {
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function parseFilters(sp: Params): Filters {
  return {
    cat: oneOf(CATEGORIES, get(sp, "cat"), "all"),
    decision: oneOf(DECISION_FILTERS, get(sp, "decision"), "all"),
    confidence: oneOf(CONFIDENCE_FILTERS, get(sp, "confidence"), "all"),
    seen: oneOf(SEEN_FILTERS, get(sp, "seen"), "all"),
    mailbox: (get(sp, "mailbox") ?? "").slice(0, 64),
    sort: oneOf(SORTS, get(sp, "sort"), "emails"),
    q: (get(sp, "q") ?? "").slice(0, 100),
  };
}

/** Query string for `f` (without "?"), omitting defaults so URLs stay short and stable. */
export function filtersToQuery(f: Partial<Filters>): string {
  const out = new URLSearchParams();
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]) {
    const v = f[key];
    if (v !== undefined && v !== DEFAULT_FILTERS[key] && v !== "") out.set(key, v);
  }
  return out.toString();
}

export function inCategory(r: Pick<CompanyRow, "sendsAds" | "holdsData">, cat: Category): boolean {
  if (cat === "ads") return r.sendsAds;
  if (cat === "data") return r.holdsData;
  if (cat === "both") return r.sendsAds && r.holdsData;
  return true;
}

const DECISION_OF: Record<Exclude<DecisionFilter, "all" | "undecided">, DecisionValue> = {
  remove: "REMOVE",
  unsubscribe: "UNSUBSCRIBE",
  keep: "KEEP",
};

const DAY = 24 * 3600 * 1000;

function matchesSecondary(r: CompanyRow, f: Filters, now: Date): boolean {
  if (f.decision === "undecided" && r.decision !== null) return false;
  if (f.decision !== "all" && f.decision !== "undecided" && r.decision !== DECISION_OF[f.decision]) return false;
  if (f.confidence !== "all" && r.confidence !== f.confidence.toUpperCase()) return false;
  if (f.mailbox && !r.accountIds.includes(f.mailbox)) return false;
  if (f.seen !== "all") {
    const age = r.lastSeen ? now.getTime() - new Date(r.lastSeen).getTime() : Infinity;
    if (f.seen === "30d" && age > 30 * DAY) return false;
    if (f.seen === "1y" && age > 365 * DAY) return false;
    if (f.seen === "older" && age <= 365 * DAY) return false;
  }
  if (f.q && !matchesQuery([r.name, ...r.domains, ...r.senderDomains, ...r.senderNames], f.q)) return false;
  return true;
}

export function sortRows(rows: CompanyRow[], sort: Sort, locale: string): CompanyRow[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const byName = (a: CompanyRow, b: CompanyRow) => collator.compare(a.name, b.name);
  const time = (s: string | null) => (s ? new Date(s).getTime() : 0);
  const cmp: Record<Sort, (a: CompanyRow, b: CompanyRow) => number> = {
    emails: (a, b) => b.emailCount - a.emailCount || byName(a, b),
    recent: (a, b) => time(b.lastSeen) - time(a.lastSeen) || byName(a, b),
    oldest: (a, b) => time(a.firstSeen) - time(b.firstSeen) || byName(a, b),
    az: byName,
  };
  return [...rows].sort(cmp[sort]);
}

/** Rows matching every filter, sorted. */
export function applyFilters(rows: CompanyRow[], f: Filters, opts: { locale: string; now?: Date }): CompanyRow[] {
  const now = opts.now ?? new Date();
  return sortRows(
    rows.filter((r) => inCategory(r, f.cat) && matchesSecondary(r, f, now)),
    f.sort,
    opts.locale,
  );
}

/** Chip counts: each category under the current secondary filters and search. */
export function categoryCounts(rows: CompanyRow[], f: Filters, now = new Date()): Record<Category, number> {
  const base = rows.filter((r) => matchesSecondary(r, f, now));
  return {
    all: base.length,
    ads: base.filter((r) => inCategory(r, "ads")).length,
    data: base.filter((r) => inCategory(r, "data")).length,
    both: base.filter((r) => inCategory(r, "both")).length,
  };
}

export type SectionKey = "data" | "marketing" | "kept";

/** 04-ux §5.1: Likely hold your data · Marketing only · Kept (decision KEEP). Order within is kept. */
export function groupRows(rows: CompanyRow[]): { key: SectionKey; rows: CompanyRow[] }[] {
  const sections: Record<SectionKey, CompanyRow[]> = { data: [], marketing: [], kept: [] };
  for (const r of rows) {
    if (r.decision === "KEEP") sections.kept.push(r);
    else if (r.holdsData) sections.data.push(r);
    else sections.marketing.push(r);
  }
  return (["data", "marketing", "kept"] as const).map((key) => ({ key, rows: sections[key] })).filter((s) => s.rows.length);
}

// Pagination (04-ux §3.3/§5.3). Pages split the list for rendering only: selection, "Select all N matching",
// bulk actions and the >25 confirmation always work on every matching row, across pages.

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

export type Paging = { page: number; per: number };

export function parsePaging(sp: Params): Paging {
  const per = Number(get(sp, "per"));
  const page = Number(get(sp, "page"));
  return {
    per: (PAGE_SIZES as readonly number[]).includes(per) ? per : DEFAULT_PAGE_SIZE,
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, 10_000) : 1,
  };
}

/** Query string for filters plus paging, omitting defaults (page 1, 50 per page). */
export function companiesQuery(f: Partial<Filters>, p: Partial<Paging> = {}): string {
  const out = new URLSearchParams(filtersToQuery(f));
  if (p.per && p.per !== DEFAULT_PAGE_SIZE) out.set("per", String(p.per));
  if (p.page && p.page > 1) out.set("page", String(p.page));
  return out.toString();
}

export type PageSlice<T> = {
  rows: T[];
  /** Current page, clamped to 1..pages. */
  page: number;
  pages: number;
  per: number;
  total: number;
  /** 1-based index of the first and last row shown (0 when empty). */
  from: number;
  to: number;
};

export function paginate<T>(rows: T[], p: Paging): PageSlice<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / p.per));
  const page = Math.min(Math.max(1, p.page), pages);
  const start = (page - 1) * p.per;
  const slice = rows.slice(start, start + p.per);
  return { rows: slice, page, pages, per: p.per, total, from: slice.length ? start + 1 : 0, to: start + slice.length };
}

/** Rows in display order (sections data → marketing → kept), so pages continue a section rather than restart it. */
export function displayOrder(rows: CompanyRow[]): CompanyRow[] {
  return groupRows(rows).flatMap((s) => s.rows);
}
