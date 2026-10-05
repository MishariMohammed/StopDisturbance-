"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { ReviewData, ReviewItem } from "@/lib/review/load";
import { channelOf, planSend, secondsLeft, type ReviewChannel } from "@/lib/review/plan";
import { diffWords, hasChanges } from "@/lib/review/diff";
import { detectIdentifiers, hasPossibleIdNumber, IDENTIFIER_KEYS } from "@/lib/review/personal-data";
import { formatDate, formatNumber } from "@/lib/format";
import { Modal } from "@/components/modal";
import { UndoToast } from "@/components/undo-toast";
import { LawExplainer } from "@/components/law-explainer";
import { WebFormGuide } from "@/components/web-form-guide";
import {
  approveAction,
  cancelDraftAction,
  confirmRecipientAction,
  holdAction,
  queueAction,
  resetDraftAction,
  saveDraftAction,
  unapproveAction,
  undoAction,
  webFormSubmittedAction,
} from "./actions";

type Edit = { to?: string; subject?: string; body?: string };
type Toast = { ids: string[]; seconds: number; mailboxes: string[]; count: number };

const CHANNEL_ICON: Record<ReviewChannel, string> = { EMAIL: "✉", ONE_CLICK: "⚡", MAILTO: "✉", WEB_FORM: "⧉" };
const sep = (locale: string) => (locale === "ar" ? "، " : ", ");

export function labelKey(item: Pick<ReviewItem, "kind" | "type">): string {
  if (item.kind === "REMINDER" || item.kind === "ID_REPLY") return item.kind;
  return item.type;
}

function grantHref(item: ReviewItem, locale: string) {
  const p = item.mailbox.provider === "MICROSOFT" ? "microsoft" : "google";
  return `/api/mail/${p}/start?send=1&locale=${locale}&hint=${encodeURIComponent(item.mailbox.address)}`;
}

export function ReviewClient({
  data,
  view,
  initialId,
  locale,
}: {
  data: ReviewData;
  view: "one" | "list";
  initialId: string | null;
  locale: string;
}) {
  const t = useTranslations("review");
  const router = useRouter();
  const n = (v: number) => formatNumber(locale, v);
  // Approval ticks show at once (optimistic) and settle when the server answers.
  const [optimistic, setOptimistic] = useOptimistic<Record<string, boolean>, [string, boolean]>({}, (s, [id, v]) => ({ ...s, [id]: v }));
  const items = useMemo(
    () => data.items.map((i) => (i.outboundId in optimistic ? { ...i, approved: optimistic[i.outboundId] } : i)),
    [data.items, optimistic],
  );
  const [currentId, setCurrentId] = useState<string | null>(initialId && items.some((i) => i.outboundId === initialId) ? initialId : null);
  const current = items.find((i) => i.outboundId === currentId) ?? items.find((i) => !i.approved && i.status !== "QUEUED") ?? items[0];
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; tracker?: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Focus starts on Cancel (04-ux §6.5); runs after the Modal child has called showModal().
  useEffect(() => {
    if (confirmOpen) cancelRef.current?.focus();
  }, [confirmOpen]);

  const plan = useMemo(
    () => planSend(items.map((i) => ({ ...i, mailbox: i.mailbox.address }))),
    [items],
  );
  const byId = useMemo(() => new Map(items.map((i) => [i.outboundId, i])), [items]);
  const approvedCount = items.filter((i) => i.approved).length;
  const errorText = (code: string) => (t.has(`errors.${code}` as "errors.failed") ? t(`errors.${code}` as "errors.failed") : t("errors.failed"));

  const clearEdit = (id: string) =>
    setEdits((e) => {
      const { [id]: _drop, ...rest } = e;
      void _drop;
      return rest;
    });

  const patchOf = (item: ReviewItem): Edit | undefined => {
    const e = edits[item.outboundId];
    if (!e) return undefined;
    const p: Edit = {};
    if (e.to !== undefined && e.to !== (item.to ?? "")) p.to = e.to;
    if (e.subject !== undefined && e.subject !== (item.subject ?? "")) p.subject = e.subject;
    if (e.body !== undefined && e.body !== (item.body ?? "")) p.body = e.body;
    return Object.keys(p).length ? p : undefined;
  };

  const run = (fn: () => Promise<void>) => {
    setError("");
    startTransition(fn);
  };

  const save = (item: ReviewItem) =>
    run(async () => {
      const patch = patchOf(item);
      if (!patch) return;
      const res = await saveDraftAction(locale, item.outboundId, patch);
      if (!res.ok) return setError(errorText(res.error));
      clearEdit(item.outboundId);
      setWarnings((w) => ({ ...w, [item.outboundId]: res.warnings }));
      setNotice({ text: item.approved ? t("savedCleared") : t("saved") });
    });

  const nextAfter = (id: string) => {
    const idx = items.findIndex((i) => i.outboundId === id);
    const rest = [...items.slice(idx + 1), ...items.slice(0, idx)];
    return rest.find((i) => !i.approved && i.status !== "QUEUED")?.outboundId ?? null;
  };

  const approve = (item: ReviewItem, advance: boolean) =>
    run(async () => {
      setOptimistic([item.outboundId, true]);
      const res = await approveAction(locale, item.outboundId, patchOf(item));
      if (!res.ok) return setError(errorText(res.error));
      clearEdit(item.outboundId);
      if (res.warnings.length) setWarnings((w) => ({ ...w, [item.outboundId]: res.warnings }));
      setNotice({ text: t("approvedOne", { name: item.companyName }) });
      if (advance) {
        const next = nextAfter(item.outboundId);
        if (next) setCurrentId(next);
      }
    });

  const unapprove = (item: ReviewItem) =>
    run(async () => {
      setOptimistic([item.outboundId, false]);
      const res = await unapproveAction(locale, item.outboundId);
      if (!res.ok) return setError(errorText(res.error));
      setNotice({ text: t("unapprovedOne", { name: item.companyName }) });
    });

  const send = () =>
    run(async () => {
      setConfirmOpen(false);
      const ids = plan.send.map((i) => i.outboundId);
      const res = await queueAction(locale, ids);
      if (!res.ok) return setError(errorText(res.error));
      if (res.failed.length) setError(t("errors.someNotQueued", { count: n(res.failed.length) }));
      if (res.queued.length) {
        const first = res.queued.reduce((m, q) => (q.sendAfter < m ? q.sendAfter : m), res.queued[0].sendAfter);
        const mailboxes = [...new Set(res.queued.map((q) => byId.get(q.id)?.mailbox.address ?? ""))].filter(Boolean);
        setToast({ ids: res.queued.map((q) => q.id), seconds: Math.max(1, secondsLeft(first, Date.now())), mailboxes, count: res.queued.length });
      }
    });

  const undo = (ids: string[]) =>
    run(async () => {
      const res = await undoAction(locale, ids);
      setToast(null);
      if (!res.ok) return setError(errorText(res.error));
      setNotice({ text: res.missed ? t("undoPartial", { undone: n(res.undone), missed: n(res.missed) }) : t("undone", { count: n(res.undone) }) });
    });

  const webFormDone = (item: ReviewItem, day: string) =>
    run(async () => {
      const res = await webFormSubmittedAction(locale, item.requestId, day);
      if (!res.ok) return setError(errorText(res.error));
      setNotice({ text: t("webFormRecorded", { name: item.companyName }), tracker: true });
    });

  return (
    <div className="mt-4 pb-24">
      <div role="status" aria-live="polite" aria-atomic="true">
        {notice && (
          <p className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md bg-info-bg p-3 text-sm text-info">
            <span>
              {notice.text}{" "}
              {notice.tracker && (
                <Link href={`/${locale}/tracker`} className="font-medium underline underline-offset-4">{t("goTracker")}</Link>
              )}
            </span>
            <button type="button" onClick={() => setNotice(null)} className="min-h-6 px-2 underline underline-offset-4">
              {t("dismiss")}
            </button>
          </p>
        )}
      </div>
      {error && <p role="alert" className="mb-4 rounded-md bg-danger-bg p-3 text-sm text-danger">{error}</p>}

      {view === "list" ? (
        <ListView
          items={items}
          locale={locale}
          pending={pending}
          onApprove={(i) => approve(i, false)}
          onUnapprove={unapprove}
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
          <DraftQueue items={items} currentId={current?.outboundId} onPick={setCurrentId} />
          {current && (
            <DraftEditor
              key={current.outboundId}
              item={current}
              index={items.indexOf(current)}
              total={items.length}
              data={data}
              edit={edits[current.outboundId] ?? {}}
              dirty={Boolean(patchOf(current))}
              serverWarnings={warnings[current.outboundId] ?? []}
              locale={locale}
              pending={pending}
              onEdit={(e) => setEdits((all) => ({ ...all, [current.outboundId]: { ...all[current.outboundId], ...e } }))}
              onSave={() => save(current)}
              onApprove={() => approve(current, true)}
              onUnapprove={() => unapprove(current)}
              onSkip={() => {
                const next = nextAfter(current.outboundId);
                if (next) setCurrentId(next);
              }}
              onReset={() =>
                run(async () => {
                  const res = await resetDraftAction(locale, current.outboundId);
                  if (!res.ok) return setError(errorText(res.error));
                  clearEdit(current.outboundId);
                  setWarnings((w) => ({ ...w, [current.outboundId]: res.warnings }));
                  setNotice({ text: t("resetDone") });
                })
              }
              onCancel={() =>
                run(async () => {
                  const res = await cancelDraftAction(locale, current.requestId);
                  if (!res.ok) return setError(errorText(res.error));
                  setNotice({ text: t("cancelled", { name: current.companyName }) });
                  setCurrentId(nextAfter(current.outboundId));
                })
              }
              onConfirmRecipient={(contactId) =>
                run(async () => {
                  const res = await confirmRecipientAction(locale, contactId);
                  if (!res.ok) return setError(errorText(res.error));
                  setNotice({ text: t("recipient.confirmed") });
                })
              }
              onUndo={() => undo([current.outboundId])}
              onWebForm={(day) => webFormDone(current, day)}
            />
          )}
        </div>
      )}

      {!toast && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-drawer">
          <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="font-medium">{t("approvedCount", { count: n(approvedCount) })}</span>
            <button
              type="button"
              disabled={pending || plan.send.length === 0}
              aria-haspopup="dialog"
              onClick={() => setConfirmOpen(true)}
              className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg disabled:opacity-60"
            >
              {t("sendCta", { count: n(plan.send.length) })}
            </button>
          </div>
        </div>
      )}

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} labelledBy="send-title">
        {confirmOpen && (
          <div>
            <h2 id="send-title" className="text-xl font-semibold">{t("confirm.title", { count: n(plan.send.length) })}</h2>
            {plan.byMailbox.map((g) => {
              const sample = g.items[0] ? byId.get(g.items[0].outboundId) : undefined;
              const needsGrant = g.items.some((i) => {
                const it = byId.get(i.outboundId);
                return it && channelOf(it.kind) !== "ONE_CLICK" && !it.mailbox.canSend;
              });
              return (
                <div key={g.mailbox} className="mt-4">
                  <p className="font-medium">
                    {t("confirm.from")} <bdi dir="ltr">{g.mailbox}</bdi>
                  </p>
                  {needsGrant && sample && (
                    <p className="mt-1 rounded-md bg-warning-bg p-2 text-sm text-warning">
                      {t("confirm.needsSend")}{" "}
                      <a href={grantHref(sample, locale)} className="font-medium underline underline-offset-4">{t("allowSending")}</a>
                    </p>
                  )}
                  <ul className="mt-2 list-disc space-y-1 ps-5 text-sm">
                    {g.items.map((i) => {
                      const it = byId.get(i.outboundId)!;
                      const ch = channelOf(it.kind);
                      return (
                        <li key={i.outboundId} data-recipient={it.outboundId}>
                          <bdi>{it.companyName}</bdi> — {t(`type.${labelKey(it)}`)} —{" "}
                          {ch === "ONE_CLICK" ? t("confirm.oneClick") : <bdi dir="ltr">{it.to}</bdi>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {plan.webForms.length > 0 && (
              <p className="mt-3 text-sm">
                {t("confirm.webForms", { count: n(plan.webForms.length), names: plan.webForms.map((w) => w.companyName).join(sep(locale)) })}
              </p>
            )}
            <p className="mt-3 text-sm text-muted">{t("confirm.note")}</p>
            <div className="mt-6 flex flex-wrap justify-between gap-3">
              <button type="button" ref={cancelRef} autoFocus onClick={() => setConfirmOpen(false)} className="min-h-tap rounded-md border border-border-strong px-4">
                {t("confirm.cancel")}
              </button>
              <button type="button" onClick={send} disabled={pending} className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg">
                {t("confirm.ok", { count: n(plan.send.length) })}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {toast && (
        <UndoToast
          key={toast.ids.join()}
          seconds={toast.seconds}
          pending={pending}
          undoLabel={t("toast.undo")}
          render={(left, paused) =>
            paused ? t("toast.paused", { count: n(toast.count) }) : t("toast.sending", { count: n(toast.count), seconds: n(left) })
          }
          onUndo={() => undo(toast.ids)}
          onHold={() => void holdAction(locale, toast.ids)}
          onExpire={() => {
            setToast(null);
            setNotice({ text: t("sent", { count: n(toast.count), mailbox: toast.mailboxes.join(sep(locale)) }), tracker: true });
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function stateIcon(item: ReviewItem): { icon: string; key: string } {
  if (item.status === "QUEUED") return { icon: "⧗", key: "queued" };
  if (item.approved) return { icon: "✓", key: "approved" };
  const ch = channelOf(item.kind);
  if (ch === "WEB_FORM") return { icon: "⧉", key: "webForm" };
  if (ch === "ONE_CLICK") return { icon: "⚡", key: "oneClick" };
  return { icon: "○", key: "toReview" };
}

function DraftQueue({ items, currentId, onPick }: { items: ReviewItem[]; currentId?: string; onPick: (id: string) => void }) {
  const t = useTranslations("review");
  return (
    <nav aria-label={t("queue")} className="md:sticky md:top-4 md:self-start">
      <h2 className="mb-2 font-semibold">{t("queue")}</h2>
      <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
        {items.map((i) => {
          const s = stateIcon(i);
          const active = i.outboundId === currentId;
          return (
            <li key={i.outboundId}>
              <button
                type="button"
                onClick={() => onPick(i.outboundId)}
                aria-current={active ? "true" : undefined}
                className={`flex min-h-tap w-full items-center gap-2 rounded-md px-2 text-start text-sm ${active ? "bg-primary text-primary-fg" : "hover:bg-surface-2"}`}
              >
                <span aria-hidden="true" className="w-5 shrink-0 text-center">{active && s.key === "toReview" ? "●" : s.icon}</span>
                <bdi className="min-w-0 flex-1 truncate">{i.companyName}</bdi>
                <span className="sr-only">— {t(`state.${s.key}`)}</span>
                <span aria-hidden="true" className="text-xs opacity-80">{s.key !== "toReview" ? t(`state.${s.key}`) : ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function DiffView({ before, after, label }: { before: string; after: string; label: string }) {
  const t = useTranslations("review.diff");
  const ops = diffWords(before, after);
  if (!hasChanges(ops)) return <p className="text-sm text-muted">{t("none", { field: label })}</p>;
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <p dir="auto" className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-surface p-2 text-sm">
        {ops.map((o, i) =>
          o.type === "same" ? (
            <span key={i}>{o.text}</span>
          ) : o.type === "add" ? (
            <ins key={i} className="bg-success-bg text-success underline decoration-2">
              <span className="sr-only">[{t("added")}: </span>
              <span aria-hidden="true" className="text-xs font-semibold">+</span>
              {o.text}
              <span className="sr-only">]</span>
            </ins>
          ) : (
            <del key={i} className="bg-danger-bg text-danger line-through">
              <span className="sr-only">[{t("removed")}: </span>
              <span aria-hidden="true" className="text-xs font-semibold">−</span>
              {o.text}
              <span className="sr-only">]</span>
            </del>
          ),
        )}
      </p>
      <p className="mt-1 text-xs text-muted">{t("legend")}</p>
    </div>
  );
}

function PersonalDataChips({ text, fullName, emails }: { text: string; fullName: string; emails: string[] }) {
  const t = useTranslations("review.pii");
  const found = detectIdentifiers(text, { fullName, emails });
  return (
    <section aria-labelledby="pii-title">
      <h3 id="pii-title" className="text-sm font-semibold">{t("title")}</h3>
      <ul className="mt-1 flex flex-wrap gap-2">
        {IDENTIFIER_KEYS.map((k) => {
          const on = found[k];
          const bad = k === "nationalId" && on;
          return (
            <li
              key={k}
              data-pii={k}
              data-included={on}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm ${bad ? "border-danger bg-danger-bg text-danger" : on ? "border-success bg-success-bg text-text" : "border-border-strong text-muted"}`}
            >
              <span aria-hidden="true">{on ? (bad ? "⚠" : "✓") : "✗"}</span>
              {t(k)}
              <span className="sr-only">: {on ? t("included") : t("notIncluded")}</span>
            </li>
          );
        })}
      </ul>
      {found.nationalId && <p className="mt-1 text-sm text-danger">{t("idWarning")}</p>}
    </section>
  );
}

function ChannelCard({ item, locale, edit, onTo, onConfirm, pending }: {
  item: ReviewItem;
  locale: string;
  edit: Edit;
  onTo: (v: string) => void;
  onConfirm: (contactId: string) => void;
  pending: boolean;
}) {
  const t = useTranslations("review");
  const ch = channelOf(item.kind);
  return (
    <section aria-labelledby="ch-title" className="rounded-md border border-border p-3" data-channel={ch}>
      <h3 id="ch-title" className="font-semibold">
        <span aria-hidden="true" className="me-1">{CHANNEL_ICON[ch]}</span>
        {ch === "EMAIL" || ch === "MAILTO" ? (
          <>
            {t(`channel.${ch}`)} {t("channel.from")} <bdi dir="ltr">{item.mailbox.address}</bdi>
          </>
        ) : (
          t(`channel.${ch}`)
        )}
      </h3>
      {ch === "ONE_CLICK" && (
        <>
          <p className="mt-1 text-sm">{t("channel.oneClickNote")}</p>
          <p className="mt-1 text-sm text-muted">
            {t("channel.oneClickTo")} <bdi dir="ltr">{item.companyDomain}</bdi>
          </p>
          {item.type === "ONE_CLICK" && (
            <Link href={`/${locale}/companies`} className="mt-1 inline-flex min-h-tap items-center text-sm font-medium text-primary underline underline-offset-4">
              {t("channel.alsoDelete")}
            </Link>
          )}
        </>
      )}
      {(ch === "EMAIL" || ch === "MAILTO") && (
        <div className="mt-2">
          <label htmlFor="rcpt" className="text-sm font-medium">{t("recipient.to")}</label>
          <input
            id="rcpt"
            type="email"
            dir="ltr"
            value={edit.to ?? item.to ?? ""}
            onChange={(e) => onTo(e.target.value)}
            disabled={item.status === "QUEUED"}
            aria-describedby="rcpt-src"
            className="mt-1 block min-h-tap w-full max-w-md rounded-md border border-border-strong bg-surface px-3"
          />
          <p id="rcpt-src" data-volatile className="mt-1 text-xs text-muted">
            {item.contact
              ? t("recipient.source", {
                  source: t.has(`recipient.sources.${item.contact.source}` as "recipient.sources.manual") ? t(`recipient.sources.${item.contact.source}` as "recipient.sources.manual") : item.contact.source,
                  date: item.contact.checkedAt ? formatDate(locale, item.contact.checkedAt) : "—",
                })
              : t("recipient.unknownSource")}
          </p>
          {item.contact?.needsConfirmation && item.contact.id && (
            <p className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-warning-bg p-2 text-sm text-warning">
              {t("recipient.guess")}
              <button type="button" disabled={pending} onClick={() => onConfirm(item.contact!.id!)} className="min-h-tap rounded-md border border-warning px-3 font-medium">
                {t("recipient.confirm")}
              </button>
            </p>
          )}
          {!item.mailbox.canSend && (
            <p className="mt-2 rounded-md bg-warning-bg p-2 text-sm text-warning">
              {t("confirm.needsSend")}{" "}
              <a href={grantHref(item, locale)} className="font-medium underline underline-offset-4">{t("allowSending")}</a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function DraftEditor(props: {
  item: ReviewItem;
  index: number;
  total: number;
  data: ReviewData;
  edit: Edit;
  dirty: boolean;
  serverWarnings: string[];
  locale: string;
  pending: boolean;
  onEdit: (e: Edit) => void;
  onSave: () => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onSkip: () => void;
  onReset: () => void;
  onCancel: () => void;
  onConfirmRecipient: (contactId: string) => void;
  onUndo: () => void;
  onWebForm: (day: string) => void;
}) {
  const { item, edit, locale, pending, data } = props;
  const t = useTranslations("review");
  const [showDiff, setShowDiff] = useState(false);
  const ch = channelOf(item.kind);
  const subject = edit.subject ?? item.subject ?? "";
  const body = edit.body ?? item.body ?? "";
  const editable = ch !== "ONE_CLICK" && item.status !== "QUEUED";
  const letter = ch === "EMAIL" || ch === "WEB_FORM";
  const queuedLeft = secondsLeft(item.sendAfter, Date.now());
  const original = item.original;
  const changed = original ? original.subject !== subject || original.body !== body || original.to !== (edit.to ?? item.to) : false;
  const idWarn = editable && hasPossibleIdNumber(`${subject}\n${body}`);
  const warnings = [...new Set([...props.serverWarnings, ...(idWarn ? ["possible_id_number"] : [])])];
  const n = (v: number) => formatNumber(locale, v);

  return (
    <article aria-labelledby="draft-title" className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6" data-outbound={item.outboundId}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="draft-title" className="text-xl font-semibold">
          <bdi>{item.companyName}</bdi> — {t(`type.${labelKey(item)}`)}
        </h2>
        <span className="text-sm text-muted">
          {t("position", { index: n(props.index + 1), total: n(props.total) })} · <bdi dir="ltr">{item.reference}</bdi>
        </span>
      </header>
      {item.approved && (
        <p className="rounded-md bg-success-bg p-2 text-sm text-success">
          <span aria-hidden="true">✓ </span>
          {t("approvedNote")}
        </p>
      )}
      {item.status === "QUEUED" && (
        <p className="flex flex-wrap items-center gap-2 rounded-md bg-info-bg p-2 text-sm text-info">
          {queuedLeft > 0 ? t("queuedNote", { seconds: n(queuedLeft) }) : t("queuedWaiting")}
          <button type="button" disabled={pending} onClick={props.onUndo} className="min-h-tap rounded-md border border-info px-3 font-medium">
            {t("cancelSend")}
          </button>
        </p>
      )}
      {item.error && <p className="rounded-md bg-danger-bg p-2 text-sm text-danger">{t("lastError", { error: item.error })}</p>}

      <ChannelCard item={item} locale={locale} edit={edit} onTo={(v) => props.onEdit({ to: v })} onConfirm={props.onConfirmRecipient} pending={pending} />

      {letter && (
        <LawExplainer keys={item.law.keys} summaries={data.laws} why={item.law.why} lowConfidence={item.law.lowConfidence} locale={locale} headingId="law-title" />
      )}

      {ch === "WEB_FORM" && (
        <WebFormGuide
          formUrl={item.to}
          fullName={data.owner.fullName}
          emails={data.mailboxes}
          requestText={`${subject}\n\n${body}`}
          pending={pending}
          onSubmitted={props.onWebForm}
        />
      )}

      {letter && (
        <p className="text-sm">
          {t("language")} <strong>{t(`lang.${item.language === "ar+en" ? "both" : item.language === "ar" ? "ar" : "en"}`)}</strong>
          {item.lawyer && <span className="ms-2 text-warning">{t("lawyerFlag")}</span>}
        </p>
      )}

      {ch !== "ONE_CLICK" && (
        <div className="flex flex-col gap-3">
          <div>
            <label htmlFor="subj" className="text-sm font-medium">{t("subject")}</label>
            <input
              id="subj"
              dir="auto"
              value={subject}
              disabled={!editable}
              onChange={(e) => props.onEdit({ subject: e.target.value })}
              className="mt-1 block min-h-tap w-full rounded-md border border-border-strong bg-surface px-3"
            />
          </div>
          <div>
            <label htmlFor="body" className="text-sm font-medium">{t("body")}</label>
            <textarea
              id="body"
              dir="auto"
              rows={14}
              value={body}
              disabled={!editable}
              onChange={(e) => props.onEdit({ body: e.target.value })}
              aria-describedby="body-count"
              className="mt-1 block w-full rounded-md border border-border-strong bg-surface p-3 font-sans text-sm leading-relaxed"
            />
            <p id="body-count" className="mt-1 text-xs text-muted">{t("chars", { count: n(body.length) })}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {original ? (
              <button type="button" aria-expanded={showDiff} aria-controls="diff" onClick={() => setShowDiff((s) => !s)} className="min-h-tap rounded-md border border-border-strong px-3 text-sm">
                {showDiff ? t("diff.hide") : t("diff.show")}
              </button>
            ) : (
              <span className="text-sm text-muted">{t("diff.unavailable")}</span>
            )}
            {original && changed && editable && (
              <button type="button" disabled={pending} onClick={props.onReset} className="min-h-tap rounded-md border border-border-strong px-3 text-sm">
                {t("reset")}
              </button>
            )}
          </div>
          {showDiff && original && (
            <div id="diff" className="flex flex-col gap-3">
              <DiffView before={original.subject ?? ""} after={subject} label={t("subject")} />
              <DiffView before={original.body ?? ""} after={body} label={t("body")} />
            </div>
          )}
          <PersonalDataChips text={`${subject}\n${body}`} fullName={data.owner.fullName} emails={data.mailboxes} />
        </div>
      )}

      {warnings.length > 0 && (
        <ul aria-label={t("warnings.label")} className="flex flex-col gap-1">
          {warnings.map((w) => (
            <li key={w} data-warning={w} className="rounded-md bg-warning-bg p-2 text-sm text-warning">
              <span aria-hidden="true">⚠ </span>
              {t.has(`warnings.${w}` as "warnings.banned_phrase") ? t(`warnings.${w}` as "warnings.banned_phrase") : w}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {props.dirty && (
          <button type="button" disabled={pending} onClick={props.onSave} className="min-h-tap rounded-md border border-border-strong px-4 font-medium">
            {t("save")}
          </button>
        )}
        <button type="button" onClick={props.onSkip} className="min-h-tap rounded-md border border-border-strong px-4">
          {t("skip")}
        </button>
        {item.status !== "QUEUED" && !item.followUp && (
          <button type="button" disabled={pending} onClick={props.onCancel} className="min-h-tap rounded-md border border-border-strong px-4">
            {t("dontSend")}
          </button>
        )}
        {ch !== "WEB_FORM" && item.status !== "QUEUED" && (
          item.approved && !props.dirty ? (
            <button type="button" disabled={pending} onClick={props.onUnapprove} className="min-h-tap rounded-md border border-success px-4 font-medium text-success sm:ms-auto">
              <span aria-hidden="true">✓ </span>
              {t("unapprove")}
            </button>
          ) : (
            <button type="button" disabled={pending} onClick={props.onApprove} className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg sm:ms-auto">
              {t("approve")}
              <span aria-hidden="true" className="ms-1 inline-block rtl:-scale-x-100">→</span>
            </button>
          )
        )}
      </div>
    </article>
  );
}

function ListView({
  items,
  locale,
  pending,
  onApprove,
  onUnapprove,
}: {
  items: ReviewItem[];
  locale: string;
  pending: boolean;
  onApprove: (i: ReviewItem) => void;
  onUnapprove: (i: ReviewItem) => void;
}) {
  const t = useTranslations("review");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t("list.caption")}</caption>
        <thead>
          <tr className="border-b border-border text-start">
            <th scope="col" className="p-2 text-start">{t("list.company")}</th>
            <th scope="col" className="p-2 text-start">{t("list.law")}</th>
            <th scope="col" className="p-2 text-start">{t("list.channel")}</th>
            <th scope="col" className="p-2 text-start">{t("list.recipient")}</th>
            <th scope="col" className="p-2 text-start">{t("list.language")}</th>
            <th scope="col" className="p-2 text-start">{t("list.approve")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const ch = channelOf(i.kind);
            const expanded = open.has(i.outboundId);
            return [
              <tr key={i.outboundId} data-outbound={i.outboundId} className="border-b border-border align-top">
                <th scope="row" className="p-2 text-start font-medium">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`txt-${i.outboundId}`}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (expanded) next.delete(i.outboundId);
                        else next.add(i.outboundId);
                        return next;
                      })
                    }
                    className="inline-flex min-h-tap items-center gap-1 text-start"
                  >
                    <span aria-hidden="true" className={`inline-block ${expanded ? "rotate-90" : "rtl:-scale-x-100"}`}>▸</span>
                    <bdi>{i.companyName}</bdi>
                    <span className="sr-only"> — {t("list.showText")}</span>
                  </button>
                  <span className="block text-xs font-normal text-muted">{t(`type.${labelKey(i)}`)}</span>
                </th>
                <td className="p-2">{i.law.keys.map((k) => t(`law.name.${k}`)).join(sep(locale))}</td>
                <td className="p-2">
                  <span aria-hidden="true">{CHANNEL_ICON[ch]} </span>
                  {t(`channel.${ch}`)}
                </td>
                <td className="p-2">{ch === "ONE_CLICK" ? "—" : <bdi dir="ltr" className="break-all">{i.to}</bdi>}</td>
                <td className="p-2">{ch === "ONE_CLICK" ? "—" : t(`lang.${i.language === "ar+en" ? "both" : i.language === "ar" ? "ar" : "en"}`)}</td>
                <td className="p-2">
                  {ch === "WEB_FORM" ? (
                    <Link href={`/${locale}/review?item=${i.outboundId}`} className="inline-flex min-h-tap items-center text-primary underline underline-offset-4">
                      {t("list.submitYourself")}
                    </Link>
                  ) : i.status === "QUEUED" ? (
                    <span>{t("state.queued")}</span>
                  ) : (
                    <label className="inline-flex min-h-tap items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-6"
                        checked={i.approved}
                        disabled={pending}
                        onChange={() => (i.approved ? onUnapprove(i) : onApprove(i))}
                      />
                      <span>{t("list.approveRow", { name: i.companyName })}</span>
                    </label>
                  )}
                </td>
              </tr>,
              expanded && (
                <tr key={`${i.outboundId}-text`} id={`txt-${i.outboundId}`}>
                  <td colSpan={6} className="border-b border-border bg-surface-2 p-3">
                    {i.subject && (
                      <p dir="auto" className="font-medium">{i.subject}</p>
                    )}
                    <pre dir="auto" className="mt-2 whitespace-pre-wrap font-sans text-sm">{i.body}</pre>
                    <Link href={`/${locale}/review?item=${i.outboundId}`} className="mt-2 inline-flex min-h-tap items-center text-primary underline underline-offset-4">
                      {t("list.edit")}
                    </Link>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
