"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { EscalationPacket, TrackerDetail, TrackerReply } from "@/lib/track/actions";
import type { Plain } from "@/lib/tracker-view/plain";
import { formatDate, formatDateTime, riyadhDay } from "@/lib/format";
import { StatusPill } from "@/components/status-pill";
import { DeadlineCountdown } from "@/components/deadline-countdown";
import { CopyButton } from "@/components/copy-button";
import { Modal } from "@/components/modal";
import { WebFormGuide } from "@/components/web-form-guide";
import { NextActionView } from "../next-action";
import {
  closeRequestAction,
  confirmReplyAction,
  escalationPacketAction,
  markEscalatedAction,
  recordExtensionAction,
  replyTextAction,
  webFormSubmittedAction,
} from "../actions";

type Detail = Plain<TrackerDetail>;
const CLOSED = ["COMPLETED", "REFUSED", "CANCELLED", "FAILED"];
const TRACKED = ["SENT", "ACKNOWLEDGED", "NEEDS_ACTION", "OVERDUE", "ESCALATED"];
const CLASSES = ["ACKNOWLEDGED", "COMPLETED", "REFUSED", "NEEDS_ID", "EXTENSION"] as const;

export function DetailClient({
  detail: d,
  locale,
  provider,
  ownerName,
  emails,
  openWizard,
  now,
}: {
  detail: Detail;
  locale: string;
  provider: "GOOGLE" | "MICROSOFT" | null;
  ownerName: string;
  emails: string[];
  openWizard: boolean;
  now: number;
}) {
  const t = useTranslations("tracker");
  const [wizard, setWizard] = useState(openWizard && (d.canEscalate || d.nextAction.kind === "ADD_COMPLAINT_REF"));
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const err = (code: string) => setError(t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.failed"));
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError("");
      setNotice("");
      const res = await fn();
      if (!res.ok) err(res.error ?? "failed");
      else setNotice(t("detail.done"));
    });
  const closed = CLOSED.includes(d.status);
  const letter = d.outbound.find((o) => o.kind === "INITIAL" || o.kind === "WEB_FORM_COPY" || o.kind === "UNSUB_MAILTO");
  const webFormOpen = d.type === "WEB_FORM" ? ["DRAFT", "APPROVED", "NEEDS_ACTION", "FAILED"].includes(d.status) : d.status === "NEEDS_ACTION" && d.needsActionReason === "WEB_FORM";
  const lawNames = d.lawKeys.join(", ") || "PDPL";

  return (
    <article aria-labelledby="req-title" className="mt-2 flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="req-title" className="text-2xl font-semibold">
            <bdi>{d.companyName}</bdi>
          </h1>
          <StatusPill status={d.status} label={t(`status.${d.status}`)} />
          {d.extensionClaimed && <span className="rounded-sm border border-border-strong px-1.5 text-xs">{t("flags.extension")}</span>}
          {d.stillEmailing && <span className="rounded-sm border border-warning px-1.5 text-xs text-warning">{t("flags.stillEmailing")}</span>}
          {d.bounced && <span className="rounded-sm border border-danger px-1.5 text-xs text-danger">{t("flags.bounced")}</span>}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="font-semibold">{t("detail.reference")}</dt>
          <dd><bdi dir="ltr">{d.reference}</bdi> · {t(`type.${d.type}`)}</dd>
          <dt className="font-semibold">{t("detail.law")}</dt>
          <dd><bdi dir="ltr">{lawNames}</bdi></dd>
          {d.mailbox && (
            <>
              <dt className="font-semibold">{t("detail.mailbox")}</dt>
              <dd><bdi dir="ltr">{d.mailbox}</bdi></dd>
            </>
          )}
          <dt className="font-semibold">{t("detail.deadline")}</dt>
          <dd>
            {d.dueAt && TRACKED.includes(d.status) ? (
              <DeadlineCountdown
                dueAt={d.dueAt}
                clockStart={d.clockStart}
                now={now}
                locale={locale}
                hijri
                businessDays={d.lawKeys.length === 1 && d.lawKeys[0] === "CAN_SPAM"}
              />
            ) : d.dueAt ? (
              formatDate(locale, d.dueAt)
            ) : (
              t("deadline.none")
            )}
          </dd>
        </dl>
        {d.complaintWindowEndsAt && !closed && <p className="text-sm text-muted">{t("detail.complaintWindow", { date: formatDate(locale, d.complaintWindowEndsAt) })}</p>}
      </header>

      <div role="status" aria-live="polite">
        {notice && <p className="rounded-md bg-info-bg p-3 text-sm text-info">{notice}</p>}
      </div>
      {error && <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">{error}</p>}

      <section aria-labelledby="next-title" className="rounded-lg border border-primary bg-surface p-4">
        <h2 id="next-title" className="font-semibold">{t("next")}</h2>
        {d.status === "NEEDS_ACTION" && d.needsActionReason && (
          <p className="mt-1 text-sm text-warning">
            {t.has(`reasons.${d.needsActionReason}`) ? t(`reasons.${d.needsActionReason}`, { mailbox: d.mailbox ?? "" }) : t("reasons.OTHER")}
          </p>
        )}
        <div className="mt-2">
          <NextActionView
            action={d.nextAction}
            locale={locale}
            ctx={{
              requestId: d.requestId,
              companyName: d.companyName,
              mailbox: d.mailbox,
              provider,
              regulator: t("sdaia"),
              onDetail: true,
              closed,
              onEscalate: () => setWizard(true),
            }}
          />
        </div>
        {d.canEscalate && d.nextAction.kind !== "ESCALATE" && d.nextAction.kind !== "ADD_COMPLAINT_REF" && (
          <button type="button" aria-haspopup="dialog" onClick={() => setWizard(true)} className="mt-3 min-h-tap rounded-md border border-border-strong px-3 text-sm">
            {t("action.ESCALATE", { regulator: t("sdaia") })}
          </button>
        )}
      </section>

      {webFormOpen && (
        <div id="web-form">
          <WebFormGuide
            formUrl={d.webFormUrl}
            fullName={ownerName}
            emails={emails}
            requestText={letter ? `${letter.subject ?? ""}\n\n${letter.bodyText ?? ""}` : ""}
            pending={pending}
            onSubmitted={(day) => run(() => webFormSubmittedAction(locale, d.requestId, day))}
          />
        </div>
      )}

      <section id="replies" aria-labelledby="replies-title">
        <h2 id="replies-title" className="text-xl font-semibold">{t("detail.replies")}</h2>
        {d.replies.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t("detail.noReplies")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {d.replies.map((r) => (
              <ReplyCard key={r.id} reply={r} locale={locale} pending={pending} onConfirm={(cls, day) => run(() => confirmReplyAction(locale, d.requestId, r.id, cls, day))} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="tl-title">
        <h2 id="tl-title" className="text-xl font-semibold">{t("detail.timeline")}</h2>
        <ol className="mt-2 flex flex-col gap-2 border-s-2 border-border ps-4">
          {d.timeline.map((e) => (
            <li key={e.id} className="text-sm">
              <span className="font-medium">{t.has(`events.${e.type}`) ? t(`events.${e.type}`) : e.type}</span>{" "}
              <span className="text-muted">
                · {formatDateTime(locale, e.at)} · {t.has(`actor.${e.actor}`) ? t(`actor.${e.actor}`) : e.actor}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="ev-title">
        <h2 id="ev-title" className="text-xl font-semibold">{t("detail.evidence")}</h2>
        <p className="mt-1 text-sm text-muted">{t("detail.evidenceHelp")}</p>
        <a href={`/api/requests/${d.requestId}/evidence`} download className="mt-2 inline-flex min-h-tap items-center rounded-md border border-border-strong px-4 text-sm font-medium">
          <span aria-hidden="true" className="me-1">⤓</span>
          {t("detail.evidence")}
        </a>
      </section>

      {!closed && (
        <details className="rounded-lg border border-border bg-surface p-4">
          <summary className="min-h-tap cursor-pointer font-semibold">{t("detail.more")}</summary>
          <div className="mt-3 flex flex-col gap-4">
            {TRACKED.includes(d.status) && <ExtensionForm pending={pending} onSave={(day) => run(() => recordExtensionAction(locale, d.requestId, day))} />}
            <CloseButtons pending={pending} status={d.status} onClose={(outcome) => run(() => closeRequestAction(locale, d.requestId, outcome))} />
          </div>
        </details>
      )}

      <Modal open={wizard} onClose={() => setWizard(false)} labelledBy="wiz-title">
        {wizard && (
          <EscalationWizard
            detail={d}
            locale={locale}
            onClose={() => setWizard(false)}
            onFiled={(ref) =>
              run(async () => {
                const res = await markEscalatedAction(locale, d.requestId, ref);
                if (res.ok) setWizard(false);
                return res;
              })
            }
            pending={pending}
          />
        )}
      </Modal>
    </article>
  );
}

function ReplyCard({
  reply: r,
  locale,
  pending,
  onConfirm,
}: {
  reply: Plain<TrackerReply>;
  locale: string;
  pending: boolean;
  onConfirm: (cls: string, day?: string) => void;
}) {
  const t = useTranslations("tracker");
  const [other, setOther] = useState<string>("");
  const [day, setDay] = useState(riyadhDay());
  const [full, setFull] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const suggested = r.suggestedClass && t.has(`cls.${r.suggestedClass}`) ? r.suggestedClass : null;
  const needsDate = (cls: string | null) => cls === "EXTENSION";
  const confirm = (cls: string) => onConfirm(cls, needsDate(cls) ? day : undefined);
  return (
    <li data-reply={r.id} className="rounded-lg border border-border bg-surface p-4">
      <p className="font-medium" dir="auto">{r.subject}</p>
      <p className="text-sm text-muted">
        {t("detail.from")} <bdi dir="ltr">{r.fromAddress}</bdi> · {formatDateTime(locale, r.receivedAt)} ·{" "}
        {t("detail.matched", { method: t.has(`method.${r.matchMethod}`) ? t(`method.${r.matchMethod}`) : r.matchMethod })}
      </p>
      {r.preview && <p dir="auto" className="mt-2 text-sm">{r.preview}</p>}
      <div className="mt-2">
        {full === null ? (
          <button
            type="button"
            disabled={loading}
            onClick={() =>
              startLoad(async () => {
                const res = await replyTextAction(locale, r.id);
                setFull(res.ok ? res.text : t("errors.failed"));
              })
            }
            className="min-h-tap text-sm font-medium text-primary underline underline-offset-4"
          >
            {t("detail.showFull")}
          </button>
        ) : (
          <pre dir="auto" className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-sans text-sm">{full}</pre>
        )}
      </div>
      {suggested && (
        <p className="mt-2 inline-flex items-center gap-1 rounded-sm border border-border-strong px-1.5 text-xs">
          {t("detail.suggested", { cls: t(`cls.${suggested}`) })}
          {r.ownerConfirmed && <span aria-hidden="true">✓</span>}
        </p>
      )}
      {r.ownerConfirmed === null && (
        <div className="mt-3 rounded-md bg-surface-2 p-3">
          <p className="text-sm font-medium">{t("detail.confirmQ")}</p>
          {needsDate(suggested) || needsDate(other) ? (
            <div className="mt-2">
              <label htmlFor={`ext-${r.id}`} className="text-sm font-medium">{t("detail.extensionDate")}</label>
              <input id={`ext-${r.id}`} type="date" dir="ltr" max={riyadhDay()} value={day} onChange={(e) => setDay(e.target.value)} className="ms-2 min-h-tap rounded-md border border-border-strong bg-surface px-2" />
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {suggested && (
              <button type="button" disabled={pending} onClick={() => confirm(suggested)} className="min-h-tap rounded-md bg-primary px-3 text-sm font-medium text-primary-fg">
                {t("detail.yes")}
              </button>
            )}
            <button type="button" disabled={pending} onClick={() => onConfirm("NOT_RELATED")} className="min-h-tap rounded-md border border-border-strong px-3 text-sm">
              {t("detail.no")}
            </button>
            <label htmlFor={`cls-${r.id}`} className="text-sm">{t("detail.other")}</label>
            <select id={`cls-${r.id}`} value={other} onChange={(e) => setOther(e.target.value)} className="min-h-tap rounded-md border border-border-strong bg-surface px-2 text-sm">
              <option value="">—</option>
              {CLASSES.map((c) => (
                <option key={c} value={c}>{t(`cls.${c}`)}</option>
              ))}
            </select>
            {other && (
              <button type="button" disabled={pending} onClick={() => confirm(other)} className="min-h-tap rounded-md border border-primary px-3 text-sm font-medium text-primary">
                {t("detail.yes")}
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function ExtensionForm({ pending, onSave }: { pending: boolean; onSave: (day: string) => void }) {
  const t = useTranslations("tracker.detail");
  const [day, setDay] = useState(riyadhDay());
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(day);
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <fieldset className="flex flex-wrap items-end gap-2">
        <legend className="mb-1 font-medium">{t("extensionTitle")}</legend>
        <span className="flex flex-col">
          <label htmlFor="ext-day" className="text-sm">{t("extensionDate")}</label>
          <input id="ext-day" type="date" dir="ltr" required max={riyadhDay()} value={day} onChange={(e) => setDay(e.target.value)} className="mt-1 min-h-tap rounded-md border border-border-strong bg-surface px-2" />
        </span>
        <button type="submit" disabled={pending} className="min-h-tap rounded-md border border-border-strong px-3 text-sm">{t("extensionSave")}</button>
      </fieldset>
    </form>
  );
}

function CloseButtons({ pending, status, onClose }: { pending: boolean; status: string; onClose: (o: "COMPLETED" | "REFUSED" | "CANCELLED") => void }) {
  const t = useTranslations("tracker.detail");
  const [armed, setArmed] = useState<"COMPLETED" | "REFUSED" | "CANCELLED" | null>(null);
  const label = { COMPLETED: t("markCompleted"), REFUSED: t("markRefused"), CANCELLED: t("stop") };
  const options = (["COMPLETED", "REFUSED", "CANCELLED"] as const).filter((o) => !(status === "QUEUED" && o !== "CANCELLED"));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button key={o} type="button" disabled={pending} aria-pressed={armed === o} onClick={() => setArmed(o)} className="min-h-tap rounded-md border border-border-strong px-3 text-sm">
            {label[o]}
          </button>
        ))}
      </div>
      {armed && (
        <p className="flex flex-wrap items-center gap-2 rounded-md bg-warning-bg p-2 text-sm text-warning">
          {t("closeConfirm")}
          <button type="button" disabled={pending} onClick={() => onClose(armed)} className="min-h-tap rounded-md border border-warning px-3 font-medium">
            {label[armed]}
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * EscalationWizard (04-ux §7.4): regulator, complaint text to copy, evidence, then "I filed it" + reference.
 * We never file on the owner's behalf — there is deliberately no submit-to-regulator control here.
 */
function EscalationWizard({
  detail: d,
  locale,
  onClose,
  onFiled,
  pending,
}: {
  detail: Detail;
  locale: string;
  onClose: () => void;
  onFiled: (ref: string) => void;
  pending: boolean;
}) {
  const t = useTranslations("tracker.wizard");
  const te = useTranslations("tracker");
  const [lang, setLang] = useState<"en" | "ar">(locale === "ar" ? "ar" : "en");
  const [packet, setPacket] = useState<EscalationPacket | null>(null);
  const [loadedLang, setLoadedLang] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, startLoad] = useTransition();
  const [ref, setRef] = useState(d.complaintRef ?? "");

  if (loadedLang !== lang && !loading) {
    setLoadedLang(lang);
    startLoad(async () => {
      const res = await escalationPacketAction(locale, d.requestId, lang);
      if (res.ok) {
        setPacket(res.packet);
        setError("");
      } else setError(te.has(`errors.${res.error}`) ? te(`errors.${res.error}`) : te("errors.failed"));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <h2 id="wiz-title" className="text-xl font-semibold">{t("title")}</h2>
        <button type="button" onClick={onClose} aria-label={t("close")} className="min-h-tap min-w-tap rounded-md border border-border-strong px-2">
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <p className="text-sm text-muted">{t("lead")}</p>
      <fieldset>
        <legend className="text-sm font-medium">{t("language")}</legend>
        <div className="mt-1 flex gap-4">
          {(["en", "ar"] as const).map((l) => (
            <label key={l} className="inline-flex min-h-tap items-center gap-2">
              <input type="radio" name="wiz-lang" value={l} checked={lang === l} onChange={() => setLang(l)} className="size-5" />
              <span lang={l}>{l === "ar" ? "العربية" : "English"}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p role="alert" className="rounded-md bg-danger-bg p-2 text-sm text-danger">{error}</p>}
      {!packet ? (
        <p role="status" className="text-sm">{t("loading")}</p>
      ) : (
        <>
          <section aria-labelledby="wiz-1">
            <h3 id="wiz-1" className="font-semibold">{t("step1")}</h3>
            <p className="mt-1" lang={lang}>{packet.regulator.name}</p>
            <a href={packet.regulator.url} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex min-h-tap items-center gap-1 font-medium text-primary underline underline-offset-4">
              {t("open", { name: packet.regulator.name })}
              <span aria-hidden="true">↗</span>
              <span className="sr-only"> {t("newTab")}</span>
            </a>
            <p className="text-sm text-muted">
              <strong>{t("deadlineInfo")}:</strong> <span lang={lang} dir="auto">{packet.deadlineInfo}</span>
            </p>
          </section>
          <section aria-labelledby="wiz-2">
            <h3 id="wiz-2" className="font-semibold">{t("step2")}</h3>
            <pre lang={lang} dir="auto" data-testid="complaint-text" className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-sans text-sm">
              {packet.complaintText}
            </pre>
            <CopyButton text={packet.complaintText} label={t("copy")} />
          </section>
          <section aria-labelledby="wiz-3">
            <h3 id="wiz-3" className="font-semibold">{t("step3")}</h3>
            <ul className="mt-1 list-disc ps-5 text-sm" lang={lang}>
              {packet.evidenceSummary.map((e, i) => (
                <li key={i} dir="auto">{e}</li>
              ))}
            </ul>
            <a href={`/api/requests/${d.requestId}/evidence`} download className="mt-1 inline-flex min-h-tap items-center text-sm font-medium text-primary underline underline-offset-4">
              {te("detail.evidence")}
            </a>
          </section>
        </>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onFiled(ref);
        }}
        aria-labelledby="wiz-4"
        className="flex flex-col gap-2"
      >
        <h3 id="wiz-4" className="font-semibold">{t("step4")}</h3>
        <label htmlFor="wiz-ref" className="text-sm font-medium">{t("refLabel")}</label>
        <input id="wiz-ref" dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} className="min-h-tap rounded-md border border-border-strong bg-surface px-3" />
        <div className="mt-2 flex flex-wrap justify-between gap-3">
          <button type="button" onClick={onClose} className="min-h-tap rounded-md border border-border-strong px-4">{t("close")}</button>
          <button type="submit" disabled={pending} className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg">{t("filed")}</button>
        </div>
      </form>
    </div>
  );
}
