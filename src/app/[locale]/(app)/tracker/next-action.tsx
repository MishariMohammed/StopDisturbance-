"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { NextAction } from "@/lib/track/actions";
import type { Plain } from "@/lib/tracker-view/plain";
import { formatDate } from "@/lib/format";
import { cancelQueuedAction, followUpDraftAction } from "./actions";

export type ActionContext = {
  requestId: string;
  companyName: string;
  mailbox: string | null;
  provider: "GOOGLE" | "MICROSOFT" | null;
  regulator: string;
  /** On the detail page the wizard/form/replies live on the same page. */
  onDetail?: boolean;
  closed?: boolean;
  onEscalate?: () => void;
};

const primary = "inline-flex min-h-tap items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-fg disabled:opacity-60";
const link = "inline-flex min-h-tap items-center font-medium text-primary underline underline-offset-4";

/** Exactly one primary next action per request (04-ux §7.4). */
export function NextActionView({ action, ctx, locale }: { action: Plain<NextAction>; ctx: ActionContext; locale: string }) {
  const t = useTranslations("tracker");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const detail = `/${locale}/tracker/${ctx.requestId}`;
  const sr = <span className="sr-only"> — {ctx.companyName}</span>;
  const later = action.availableAt && Date.parse(action.availableAt) > Date.now() ? action.availableAt : null;
  const err = (code: string) => setError(t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.failed"));

  const followUp = (kind: "REMINDER" | "ID_REPLY") =>
    startTransition(async () => {
      setError("");
      const res = await followUpDraftAction(locale, ctx.requestId, kind);
      if (!res.ok) return err(res.error);
      router.push(`/${locale}/review?item=${res.outboundId}`);
    });

  let body: React.ReactNode;
  switch (action.kind) {
    case "REVIEW_DRAFT":
    case "SEND":
      body = (
        <Link href={`/${locale}/review${action.outboundId ? `?item=${action.outboundId}` : ""}`} className={primary}>
          {t(`action.${action.kind === "SEND" ? "SEND" : "REVIEW_DRAFT"}`)}
          {sr}
        </Link>
      );
      break;
    case "CANCEL":
      body = (
        <button
          type="button"
          disabled={pending || !action.outboundId}
          className={primary}
          onClick={() =>
            startTransition(async () => {
              setError("");
              const res = await cancelQueuedAction(locale, ctx.requestId, action.outboundId!);
              if (!res.ok) err(res.error);
            })
          }
        >
          {t("action.CANCEL_QUEUED")}
          {sr}
        </button>
      );
      break;
    case "SUBMIT_WEB_FORM":
      body = ctx.onDetail ? (
        <a href="#web-form" className={primary}>{t("action.WEB_FORM_SUBMITTED")}</a>
      ) : (
        <Link href={`${detail}#web-form`} className={primary}>
          {t("action.OPEN_FORM")}
          {sr}
        </Link>
      );
      break;
    case "GRANT_SEND_PERMISSION": {
      const p = ctx.provider === "MICROSOFT" ? "microsoft" : "google";
      body = (
        <a href={`/api/mail/${p}/start?send=1&locale=${locale}${ctx.mailbox ? `&hint=${encodeURIComponent(ctx.mailbox)}` : ""}`} className={primary}>
          {t("action.GRANT_SEND")}
          {sr}
        </a>
      );
      break;
    }
    case "RECONNECT_MAILBOX":
      body = (
        <Link href={`/${locale}/connect`} className={primary}>
          {t("action.RECONNECT")}
          {sr}
        </Link>
      );
      break;
    case "CONFIRM_REPLY":
      body = ctx.onDetail ? (
        <a href="#replies" className={primary}>{t("action.CONFIRM_REPLY")}</a>
      ) : (
        <Link href={`${detail}#replies`} className={primary}>
          {t("action.CONFIRM_REPLY")}
          {sr}
        </Link>
      );
      break;
    case "REPLY_WITH_DETAILS":
      body = (
        <button type="button" disabled={pending} onClick={() => followUp("ID_REPLY")} className={primary}>
          {t("action.REPLY_ID")}
          {sr}
        </button>
      );
      break;
    case "SEND_REMINDER":
      body = later ? (
        <span data-volatile className="text-sm">{t("reminderFrom", { date: formatDate(locale, later) })}</span>
      ) : (
        <button type="button" disabled={pending} onClick={() => followUp("REMINDER")} className={primary}>
          {t("action.SEND_REMINDER")}
          {sr}
        </button>
      );
      break;
    case "ESCALATE":
      body = later ? (
        <span data-volatile className="text-sm">{t("availableFrom", { date: formatDate(locale, later) })}</span>
      ) : ctx.onDetail && ctx.onEscalate ? (
        <button type="button" aria-haspopup="dialog" onClick={ctx.onEscalate} className={primary}>
          {t("action.ESCALATE", { regulator: ctx.regulator })}
        </button>
      ) : (
        <Link href={`${detail}?escalate=1`} className={primary}>
          {t("action.ESCALATE", { regulator: ctx.regulator })}
          {sr}
        </Link>
      );
      break;
    case "ADD_COMPLAINT_REF":
      body = ctx.onDetail && ctx.onEscalate ? (
        <button type="button" aria-haspopup="dialog" onClick={ctx.onEscalate} className={primary}>
          {t("action.ADD_COMPLAINT_REF")}
        </button>
      ) : (
        <Link href={`${detail}?escalate=1`} className={primary}>
          {t("action.ADD_COMPLAINT_REF")}
          {sr}
        </Link>
      );
      break;
    case "FIX_ADDRESS":
      body = (
        <Link href={detail} className={primary}>
          {t("action.FIX_ADDRESS")}
          {sr}
        </Link>
      );
      break;
    case "VIEW_REPLY":
      body = (
        <Link href={ctx.onDetail ? "#replies" : `${detail}#replies`} className={link}>
          {t("action.VIEW_REPLY")}
          {sr}
        </Link>
      );
      break;
    default:
      body = <span data-volatile={later ? "" : undefined} className="text-sm">{later ? t("availableFrom", { date: formatDate(locale, later) }) : ctx.closed ? t("action.NONE") : t("action.WAIT")}</span>;
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-next={action.kind}>
      {body}
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
