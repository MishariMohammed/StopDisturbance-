"use client";
import Link from "next/link";
import { useMemo, useRef, useState, useTransition, type MouseEvent } from "react";
import { useTranslations } from "next-intl";
import type { Confidence, DecisionValue } from "@prisma/client";
import type { CompanyRow, MatchRef } from "@/lib/companies/types";
import type { SectionKey } from "@/lib/companies/filters";
import { planBulkDecision } from "@/lib/companies/bulk";
import { hasRecentAccountMail } from "@/lib/companies/evidence";
import { formatDate, formatNumber } from "@/lib/format";
import { Modal } from "@/components/modal";
import { bulkDecideAction, decideAction, mergeAction, splitAction } from "./actions";

const DECISIONS: DecisionValue[] = ["KEEP", "UNSUBSCRIBE", "REMOVE"];
const DOTS: Record<Confidence, string> = { HIGH: "●●●", MEDIUM: "●●○", LOW: "●○○" };

type Account = { id: string; address: string };
type Confirm = { ids: string[]; count: number; names: string[] };
export type Pager = {
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
  prev: string | null;
  next: string | null;
  first: string | null;
  last: string | null;
};

export function CompanyList({
  sections,
  sectionTotals,
  matches,
  pager,
  accounts,
  locale,
}: {
  /** Rows of the current page, grouped. */
  sections: { key: SectionKey; rows: CompanyRow[] }[];
  /** Rows per section across all pages. */
  sectionTotals: Partial<Record<SectionKey, number>>;
  /** Every row matching the filters (all pages): selection and bulk actions work on these. */
  matches: MatchRef[];
  pager: Pager;
  accounts: Account[];
  locale: string;
}) {
  const t = useTranslations("companies");
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const refById = useMemo(() => new Map(matches.map((r) => [r.id, r])), [matches]);
  const order = useMemo(() => rows.map((r) => r.id), [rows]);

  // Nothing is pre-selected (04-ux §1.2). The selection survives page changes (the list stays mounted);
  // ids that stop matching the filters drop out of it.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const selected = useMemo(() => new Set([...picked].filter((id) => refById.has(id))), [picked, refById]);
  const [overrides, setOverrides] = useState<Record<string, DecisionValue>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(() => new Set());
  const anchor = useRef<string | null>(null);

  const n = (v: number) => formatNumber(locale, v);
  const decisionOf = (r: CompanyRow) => overrides[r.id] ?? r.decision;
  const drawer = drawerId ? byId.get(drawerId) : undefined;
  const selectedRows = [...selected].map((id) => refById.get(id)!).filter(Boolean);
  const offPage = [...selected].filter((id) => !byId.has(id)).length;

  const toggle = (id: string, e?: MouseEvent<HTMLInputElement>) => {
    setPicked((prev) => {
      const next = new Set([...prev].filter((x) => refById.has(x)));
      const on = !next.has(id);
      // Shift-click selects the range from the last toggled row (desktop).
      if (e?.shiftKey && anchor.current && byId.has(anchor.current)) {
        const [a, b] = [order.indexOf(anchor.current), order.indexOf(id)].sort((x, y) => x - y);
        order.slice(a, b + 1).forEach((x) => (on ? next.add(x) : next.delete(x)));
      } else if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    anchor.current = id;
  };

  const decide = (r: CompanyRow, value: DecisionValue) => {
    setError("");
    setOverrides((o) => ({ ...o, [r.id]: value }));
    startTransition(async () => {
      const res = await decideAction(locale, r.id, value);
      if (!res.ok) {
        setOverrides((o) => {
          const { [r.id]: _drop, ...rest } = o;
          void _drop;
          return rest;
        });
        setError(t("errors.save"));
      }
    });
  };

  const runBulk = (ids: string[], value: DecisionValue, confirmed: boolean) => {
    setError("");
    startTransition(async () => {
      const res = await bulkDecideAction(locale, ids, value, confirmed);
      if (!res.ok) {
        setError(t("errors.save"));
        return;
      }
      const parts = [t("bulk.done", { count: n(res.applied), decision: t(`decision.${value}`) })];
      if (res.skippedLow) parts.push(t("bulk.skippedLow", { count: n(res.skippedLow) }));
      setNotice(parts.join(" "));
      setOverrides({});
      setPicked(new Set());
    });
  };

  const bulk = (value: DecisionValue) => {
    const plan = planBulkDecision(selectedRows, value);
    if (!plan.apply.length) {
      setNotice(t("bulk.noneEligible", { count: n(plan.skippedLow.length) }));
      return;
    }
    if (plan.needsConfirm) {
      setConfirm({ ids: [...selected], count: plan.apply.length, names: plan.topNames });
      return;
    }
    runBulk([...selected], value, false);
  };

  const allSelected = matches.length > 0 && selected.size === matches.length;
  const pageSelected = order.length > 0 && order.every((id) => selected.has(id));

  return (
    <div className={`mt-6 ${selected.size ? "pb-32 sm:pb-20" : ""}`}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {selected.size ? t("bulk.selected", { count: n(selected.size) }) : ""}
      </p>
      <div role="status" aria-live="polite" aria-atomic="true">
        {notice && (
          <p className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md bg-info-bg p-3 text-sm text-info">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice("")} className="min-h-6 px-2 underline underline-offset-4">
              {t("dismiss")}
            </button>
          </p>
        )}
      </div>
      {error && <p role="alert" className="mb-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap items-center gap-4 border-b border-border pb-3">
        <label className="inline-flex min-h-tap items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-6"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = selected.size > 0 && !allSelected;
            }}
            onChange={() => setPicked(allSelected ? new Set() : new Set(matches.map((m) => m.id)))}
          />
          {t("selectAll", { count: n(matches.length) })}
        </label>
        {pager.pages > 1 && !pageSelected && (
          <button
            type="button"
            onClick={() => setPicked((prev) => new Set([...prev, ...order]))}
            className="min-h-tap px-2 text-sm text-primary underline underline-offset-4"
          >
            {t("selectPage", { count: n(order.length) })}
          </button>
        )}
        {selected.size > 0 && (
          <button type="button" onClick={() => setPicked(new Set())} className="min-h-tap px-2 text-sm text-primary underline underline-offset-4">
            {t("selectNone")}
          </button>
        )}
      </div>

      {rows.length === 0 && <p className="mt-6 rounded-lg border border-border bg-surface p-6">{t("emptyFilter")}</p>}

      {sections.map((s) => {
        const open = !collapsed.has(s.key);
        return (
          <section key={s.key} aria-labelledby={`sec-${s.key}`} className="mt-8">
            <h2 id={`sec-${s.key}`} className="text-xl font-semibold">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`list-${s.key}`}
                onClick={() =>
                  setCollapsed((c) => {
                    const next = new Set(c);
                    if (open) next.add(s.key);
                    else next.delete(s.key);
                    return next;
                  })
                }
                className="inline-flex min-h-tap items-center gap-2"
              >
                <span aria-hidden="true" className={`inline-block transition-transform ${open ? "rotate-90" : "rtl:-scale-x-100"}`}>▸</span>
                {t(`sections.${s.key}`)} <span className="text-base font-normal text-muted">({n(sectionTotals[s.key] ?? s.rows.length)})</span>
              </button>
            </h2>
            <ul id={`list-${s.key}`} hidden={!open} className="mt-3 flex flex-col gap-2">
              {s.rows.map((r) => (
                <CompanyItem
                  key={r.id}
                  row={r}
                  decision={decisionOf(r)}
                  selected={selected.has(r.id)}
                  onToggle={(e) => toggle(r.id, e)}
                  onDecide={(v) => decide(r, v)}
                  onOpen={() => setDrawerId(r.id)}
                  locale={locale}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {pager.pages > 1 && <PageNav pager={pager} locale={locale} />}

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-drawer">
          <div className="mx-auto flex max-w-content flex-wrap items-center gap-2 px-4 py-3" role="toolbar" aria-label={t("bulk.label")}>
            <span className="me-2 font-semibold" aria-hidden="true">
              {t("bulk.selected", { count: n(selected.size) })}
              {offPage > 0 && <span className="ms-1 font-normal text-muted">{t("bulk.offPage", { count: n(offPage) })}</span>}
            </span>
            {(["REMOVE", "UNSUBSCRIBE", "KEEP"] as const).map((v) => (
              <button
                key={v}
                type="button"
                disabled={pending}
                onClick={() => bulk(v)}
                className={`min-h-tap rounded-md px-3 text-sm font-medium ${v === "REMOVE" ? "bg-primary text-primary-fg" : "border border-border-strong"}`}
              >
                {t(`bulk.mark.${v}`)}
              </button>
            ))}
            {selected.size >= 2 && (
              <button type="button" disabled={pending} onClick={() => setMergeOpen(true)} className="min-h-tap rounded-md border border-border-strong px-3 text-sm font-medium">
                {t("merge.open", { count: n(selected.size) })}
              </button>
            )}
            <button type="button" onClick={() => setPicked(new Set())} className="min-h-tap px-3 text-sm text-primary underline underline-offset-4 sm:ms-auto">
              {t("bulk.clear")}
            </button>
          </div>
        </div>
      )}

      <Modal open={Boolean(confirm)} onClose={() => setConfirm(null)} labelledBy="confirm-title">
        {confirm && (
          <>
            <h2 id="confirm-title" className="text-xl font-semibold">{t("confirm.title", { count: n(confirm.count) })}</h2>
            <p className="mt-3">
              {t("confirm.body", { names: confirm.names.join(locale === "ar" ? "، " : ", "), count: n(confirm.count) })}
            </p>
            <p className="mt-2 text-sm text-muted">{t("confirm.note")}</p>
            <div className="mt-6 flex flex-wrap justify-between gap-3">
              <button type="button" autoFocus onClick={() => setConfirm(null)} className="min-h-tap rounded-md border border-border-strong px-4">
                {t("confirm.cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  runBulk(c.ids, "REMOVE", true);
                }}
                className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg"
              >
                {t("confirm.ok", { count: n(confirm.count) })}
              </button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={mergeOpen} onClose={() => setMergeOpen(false)} labelledBy="merge-title">
        {mergeOpen && (
          <MergeForm
            rows={selectedRows}
            locale={locale}
            onCancel={() => setMergeOpen(false)}
            onMerge={(target) => {
              setMergeOpen(false);
              startTransition(async () => {
                const res = await mergeAction(locale, target, selectedRows.map((r) => r.id).filter((id) => id !== target));
                if (!res.ok) return setError(t("errors.merge"));
                setNotice(t("merge.done", { count: n(selectedRows.length), name: refById.get(target)?.name ?? "" }));
                setPicked(new Set());
              });
            }}
          />
        )}
      </Modal>

      <Modal open={Boolean(drawer)} onClose={() => setDrawerId(null)} labelledBy="drawer-title" side="end">
        {drawer && (
          <EvidenceDrawer
            row={drawer}
            decision={decisionOf(drawer)}
            accounts={accounts}
            locale={locale}
            pending={pending}
            onClose={() => setDrawerId(null)}
            onDecide={(v) => decide(drawer, v)}
            onSplit={(domain) =>
              startTransition(async () => {
                const res = await splitAction(locale, drawer.id, domain);
                if (!res.ok) return setError(t("errors.split"));
                setNotice(t("split.done", { domain }));
              })
            }
          />
        )}
      </Modal>
    </div>
  );
}

function PageNav({ pager, locale }: { pager: Pager; locale: string }) {
  const t = useTranslations("companies.pages");
  const n = (v: number) => formatNumber(locale, v);
  const link = "inline-flex min-h-tap items-center rounded-md border border-border-strong px-3 text-sm font-medium";
  return (
    <nav aria-label={t("label")} className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p className="text-sm text-muted">
        {t("status", { page: n(pager.page), pages: n(pager.pages), from: n(pager.from), to: n(pager.to), total: n(pager.total) })}
      </p>
      <ul className="flex flex-wrap gap-2">
        {pager.first && (
          <li><Link href={pager.first} className={link}>{t("first")}</Link></li>
        )}
        {pager.prev && (
          <li><Link href={pager.prev} rel="prev" className={link}><span aria-hidden="true" className="rtl:-scale-x-100 me-1 inline-block">‹</span>{t("prev")}</Link></li>
        )}
        {pager.next && (
          <li><Link href={pager.next} rel="next" className={link}>{t("next")}<span aria-hidden="true" className="rtl:-scale-x-100 ms-1 inline-block">›</span></Link></li>
        )}
        {pager.last && (
          <li><Link href={pager.last} className={link}>{t("last", { page: n(pager.pages) })}</Link></li>
        )}
      </ul>
    </nav>
  );
}

function ConfidenceMeter({ value }: { value: Confidence }) {
  const t = useTranslations("companies.confidence");
  return (
    <span className="inline-flex items-center gap-1 text-sm" title={t(`def.${value}`)}>
      <span aria-hidden="true" className="tracking-tight text-primary">{DOTS[value]}</span>
      <span>{t(value)}</span>
      <span className="sr-only">— {t(`def.${value}`)}</span>
    </span>
  );
}

function Badges({ row }: { row: CompanyRow }) {
  const t = useTranslations("companies.badge");
  return (
    <>
      {row.sendsAds && (
        <span className="inline-flex items-center gap-1 rounded-sm border border-cat-ads px-1.5 text-xs font-medium text-cat-ads">
          <span aria-hidden="true">✉</span>
          {t("ads")}
        </span>
      )}
      {row.holdsData && (
        <span className="inline-flex items-center gap-1 rounded-sm border border-cat-data px-1.5 text-xs font-medium text-cat-data">
          <span aria-hidden="true">◆</span>
          {t("data")}
        </span>
      )}
      {row.aiSuggested && (
        <span className="inline-flex items-center rounded-sm border border-border-strong px-1.5 text-xs text-muted">{t("ai")}</span>
      )}
    </>
  );
}

function DecisionControl({
  row,
  value,
  onChange,
  name,
}: {
  row: CompanyRow;
  value: DecisionValue | null;
  onChange: (v: DecisionValue) => void;
  name: string;
}) {
  const t = useTranslations("companies");
  return (
    <fieldset role="radiogroup" className="min-w-0">
      <legend className="sr-only">{t("decisionFor", { name: row.name })}</legend>
      <div className="flex flex-wrap gap-2">
        {DECISIONS.map((v) => (
          <label
            key={v}
            className="inline-flex min-h-tap cursor-pointer items-center gap-2 rounded-md border border-border-strong px-3 text-sm font-medium has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-primary-fg has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus"
          >
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="sr-only" />
            {value === v && <span aria-hidden="true">✓</span>}
            {t(`decision.${v}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RemoveWarning({ row, onUnsub }: { row: CompanyRow; onUnsub: () => void }) {
  const t = useTranslations("companies");
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-warning-bg p-2 text-sm text-warning">
      <span>{t("recentWarning", { name: row.name })}</span>
      <button type="button" onClick={onUnsub} className="min-h-6 font-medium underline underline-offset-4">
        {t("unsubInstead")}
      </button>
    </p>
  );
}

function CompanyItem({
  row,
  decision,
  selected,
  onToggle,
  onDecide,
  onOpen,
  locale,
}: {
  row: CompanyRow;
  decision: DecisionValue | null;
  selected: boolean;
  onToggle: (e: MouseEvent<HTMLInputElement>) => void;
  onDecide: (v: DecisionValue) => void;
  onOpen: () => void;
  locale: string;
}) {
  const t = useTranslations("companies");
  const cb = `cb-${row.id}`;
  return (
    <li
      data-company={row.primaryDomain}
      className={`rounded-lg border p-4 ${selected ? "border-primary" : "border-border"} ${decision === "KEEP" ? "bg-surface-2" : "bg-surface"}`}
    >
      <div className="flex gap-3">
        <input
          id={cb}
          type="checkbox"
          checked={selected}
          onChange={() => {}}
          onClick={onToggle}
          aria-label={t("selectRow", { name: row.name })}
          className="mt-1 size-6 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-lg font-semibold">
              <bdi>{row.name}</bdi>
            </h3>
            <span className="text-sm text-muted"><bdi dir="ltr">{row.primaryDomain}</bdi></span>
            <Badges row={row} />
            <ConfidenceMeter value={row.confidence} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {t("emails", { count: formatNumber(locale, row.emailCount) })} · {formatDate(locale, row.firstSeen, "month")} → {formatDate(locale, row.lastSeen)}
          </p>
          {row.subjects.length > 0 && (
            <p className="mt-1 truncate text-sm">
              {row.subjects.slice(0, 2).map((s, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  <bdi dir="auto">&quot;{s}&quot;</bdi>
                </span>
              ))}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <DecisionControl row={row} value={decision} onChange={onDecide} name={`d-${row.id}`} />
            <button type="button" onClick={onOpen} aria-haspopup="dialog" className="min-h-tap px-2 text-sm font-medium text-primary underline underline-offset-4">
              {t("why")}
              <span className="sr-only"> — {row.name}</span>
            </button>
          </div>
          {decision === "REMOVE" && hasRecentAccountMail(row) && <RemoveWarning row={row} onUnsub={() => onDecide("UNSUBSCRIBE")} />}
        </div>
      </div>
    </li>
  );
}

function MergeForm({
  rows,
  locale,
  onCancel,
  onMerge,
}: {
  rows: MatchRef[];
  locale: string;
  onCancel: () => void;
  onMerge: (targetId: string) => void;
}) {
  const t = useTranslations("companies.merge");
  const biggest = [...rows].sort((a, b) => b.emailCount - a.emailCount)[0];
  const [target, setTarget] = useState(biggest?.id ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (target) onMerge(target);
      }}
    >
      <h2 id="merge-title" className="text-xl font-semibold">{t("title", { count: formatNumber(locale, rows.length) })}</h2>
      <p className="mt-2 text-sm text-muted">{t("lead")}</p>
      <fieldset className="mt-4">
        <legend className="font-medium">{t("keepName")}</legend>
        {rows.map((r) => (
          <label key={r.id} className="flex min-h-tap items-center gap-2">
            <input type="radio" name="merge-target" value={r.id} checked={target === r.id} onChange={() => setTarget(r.id)} className="size-5" />
            <bdi>{r.name}</bdi> <span className="text-sm text-muted">(<bdi dir="ltr">{r.primaryDomain}</bdi>)</span>
          </label>
        ))}
      </fieldset>
      <div className="mt-6 flex flex-wrap justify-between gap-3">
        <button type="button" onClick={onCancel} className="min-h-tap rounded-md border border-border-strong px-4">
          {t("cancel")}
        </button>
        <button type="submit" className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg">
          {t("submit", { count: formatNumber(locale, rows.length) })}
        </button>
      </div>
    </form>
  );
}

function EvidenceDrawer({
  row,
  decision,
  accounts,
  locale,
  pending,
  onClose,
  onDecide,
  onSplit,
}: {
  row: CompanyRow;
  decision: DecisionValue | null;
  accounts: Account[];
  locale: string;
  pending: boolean;
  onClose: () => void;
  onDecide: (v: DecisionValue) => void;
  onSplit: (domain: string) => void;
}) {
  const t = useTranslations("companies.drawer");
  const tc = useTranslations("companies");
  const tr = useTranslations("rules");
  const n = (v: number) => formatNumber(locale, v);
  const mailboxes = accounts.filter((a) => row.accountIds.includes(a.id));
  const reason = (id: string, method: string) =>
    method === "RULES" ? (tr.has(id as "LIST_UNSUB") ? tr(id as "LIST_UNSUB") : id) : `${tr(`label.${id === "ads" ? "ads" : "holds_data"}`)} (${tc(`method.${method}`)})`;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <h2 id="drawer-title" className="text-xl font-semibold">
          <bdi>{row.name}</bdi>
        </h2>
        <button type="button" onClick={onClose} className="min-h-tap min-w-tap rounded-md border border-border-strong px-2" aria-label={t("close")}>
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <section aria-labelledby="ev-why">
        <h3 id="ev-why" className="font-semibold">{t("why")}</h3>
        <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
          {row.transactionalCount > 0 && <li>{t("accountMail", { count: n(row.transactionalCount) })}</li>}
          {row.marketingCount > 0 && <li>{t("marketingMail", { count: n(row.marketingCount) })}</li>}
          {row.reasons.map((r) => (
            <li key={`${r.method}:${r.id}`}>{reason(r.id, r.method)}</li>
          ))}
        </ul>
      </section>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="font-semibold">{t("emails")}</dt>
        <dd>{n(row.emailCount)}</dd>
        <dt className="font-semibold">{t("seen")}</dt>
        <dd>
          {formatDate(locale, row.firstSeen)} → {formatDate(locale, row.lastSeen)}
        </dd>
        <dt className="font-semibold">{t("mailboxes")}</dt>
        <dd>
          {mailboxes.map((m) => (
            <bdi key={m.id} dir="ltr" className="block">{m.address}</bdi>
          ))}
        </dd>
        <dt className="font-semibold">{t("confidence")}</dt>
        <dd>
          <ConfidenceMeter value={row.confidence} />
        </dd>
      </dl>

      <section aria-labelledby="ev-subjects">
        <h3 id="ev-subjects" className="font-semibold">{t("subjects")}</h3>
        {row.subjects.length ? (
          <ul className="mt-1 list-disc space-y-1 ps-5 text-sm">
            {row.subjects.map((s, i) => (
              <li key={i} dir="auto">{s}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted">{t("noSubjects")}</p>
        )}
      </section>

      <section aria-labelledby="ev-domains">
        <h3 id="ev-domains" className="font-semibold">{t("domains")}</h3>
        <ul className="mt-1 space-y-1 text-sm">
          {row.domains.map((d) => (
            <li key={d} className="flex flex-wrap items-center justify-between gap-2">
              <bdi dir="ltr">{d}</bdi>
              {d !== row.primaryDomain && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onSplit(d)}
                  className="min-h-tap rounded-md border border-border-strong px-3 text-sm"
                >
                  {t("split")}
                  <span className="sr-only"> {d}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-muted">{t("groupingHelp")}</p>
      </section>

      <section aria-labelledby="ev-decide">
        <h3 id="ev-decide" className="mb-2 font-semibold">{t("decision")}</h3>
        <DecisionControl row={row} value={decision} onChange={onDecide} name={`dd-${row.id}`} />
        {decision === "REMOVE" && hasRecentAccountMail(row) && <RemoveWarning row={row} onUnsub={() => onDecide("UNSUBSCRIBE")} />}
      </section>
    </div>
  );
}
