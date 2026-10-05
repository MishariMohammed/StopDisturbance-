import { useTranslations } from "next-intl";
import { deadlineView } from "@/lib/tracker-view/view";
import { formatDate, formatHijri, formatNumber } from "@/lib/format";

const BAR: Record<string, string> = { info: "bg-info", warning: "bg-warning", danger: "bg-danger" };
const TEXT: Record<string, string> = { info: "text-text", warning: "text-warning", danger: "text-danger" };

/**
 * Text-first deadline (04-ux §7.2); the bar fills from the start side and only repeats the text.
 * `data-volatile` marks content that changes with the current time (visual tests mask it).
 */
export function DeadlineCountdown({
  dueAt,
  clockStart,
  now,
  locale,
  hijri = false,
  extendedFrom,
  businessDays = false,
}: {
  dueAt: string;
  clockStart?: string | null;
  now: number;
  locale: string;
  hijri?: boolean;
  extendedFrom?: string | null;
  businessDays?: boolean;
}) {
  const t = useTranslations("tracker.deadline");
  const v = deadlineView(dueAt, now, clockStart);
  const n = (x: number) => formatNumber(locale, x);
  const date = formatDate(locale, dueAt);
  const text = v.overdue ? t("overdue", { count: n(-v.days), date }) : t("left", { count: n(v.days), date });
  return (
    <span data-volatile className="inline-flex flex-col gap-1">
      <span className={`text-sm font-medium ${TEXT[v.tone]}`}>
        {text}
        {businessDays && <span className="text-muted"> · {t("businessDays")}</span>}
        {extendedFrom && (
          <span className="ms-1 text-muted">
            ({t("extendedFrom")} <s>{formatDate(locale, extendedFrom)}</s>)
          </span>
        )}
      </span>
      {hijri && <span className="text-xs text-muted">{t("hijri", { date: formatHijri(locale, dueAt) })}</span>}
      {clockStart && (
        <span aria-hidden="true" className="block h-1.5 w-40 overflow-hidden rounded-full bg-surface-2">
          <span className={`block h-full ${BAR[v.tone]}`} style={{ width: `${Math.round(v.elapsed * 100)}%` }} />
        </span>
      )}
    </span>
  );
}
