import type { AccountStatus, Provider } from "@prisma/client";
import { db } from "@/lib/db";
import type { ScanProgress } from "@/lib/mail/gmail-sync";
import { rangeOf, type ScanRange } from "@/lib/mail/scan-range";
import { loadCompanies } from "./load";

export type AccountScan = {
  id: string;
  address: string;
  provider: Provider;
  status: AccountStatus;
  phase: ScanProgress["phase"] | "pending";
  listed: number;
  fetched: number;
  /** 0–100, or null when the total isn't known yet. */
  percent: number | null;
  /** ScanRangeSelector value (04-ux §3.2); null when scanFrom wasn't loaded. */
  range: ScanRange | null;
};

export type ScanStatus = {
  accounts: AccountScan[];
  running: boolean;
  /** Overall percent across running accounts (null when unknown). */
  percent: number | null;
  companies: number;
  ads: number;
  data: number;
  /** Most recently seen companies (names only). */
  recent: string[];
};

export function toAccountScan(a: {
  id: string;
  address: string;
  provider: Provider;
  status: AccountStatus;
  scanProgress: unknown;
  scanFrom?: Date;
}, now = new Date()): AccountScan {
  const p = (a.scanProgress ?? null) as Partial<ScanProgress> | null;
  const phase = p?.phase ?? "pending";
  const listed = Math.max(0, Number(p?.listed ?? 0));
  const fetched = Math.max(0, Number(p?.fetched ?? 0));
  const percent = phase === "done" ? 100 : listed > 0 ? Math.min(100, Math.floor((fetched / listed) * 100)) : null;
  const range = a.scanFrom ? rangeOf(a.scanFrom, now) : null;
  return { id: a.id, address: a.address, provider: a.provider, status: a.status, phase, listed, fetched, percent, range };
}

export function overallPercent(accounts: AccountScan[]): number | null {
  const running = accounts.filter((a) => a.phase !== "done" && a.status === "ACTIVE");
  if (!running.length) return 100;
  const listed = running.reduce((n, a) => n + a.listed, 0);
  if (!listed) return null;
  return Math.min(100, Math.floor((running.reduce((n, a) => n + a.fetched, 0) / listed) * 100));
}

export async function loadScanStatus(): Promise<ScanStatus> {
  const [rows, companies] = await Promise.all([
    db.mailAccount.findMany({
      where: { status: { not: "DISCONNECTED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, address: true, provider: true, status: true, scanProgress: true, scanFrom: true },
    }),
    loadCompanies(),
  ]);
  const accounts = rows.map((r) => toAccountScan(r));
  const running = accounts.some((a) => a.phase !== "done" && a.status === "ACTIVE");
  return {
    accounts,
    running,
    percent: overallPercent(accounts),
    companies: companies.length,
    ads: companies.filter((c) => c.sendsAds).length,
    data: companies.filter((c) => c.holdsData).length,
    recent: [...companies]
      .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
      .slice(0, 5)
      .map((c) => c.name),
  };
}
