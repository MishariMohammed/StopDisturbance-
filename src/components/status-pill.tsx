import { statusMeta, TONE_CLASSES } from "@/lib/tracker-view/view";

/** Canonical status: icon + text + colour token (never colour alone, 04-ux §7.1). */
export function StatusPill({ status, label }: { status: string; label: string }) {
  const m = statusMeta(status);
  return (
    <span data-status={status} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm font-medium ${TONE_CLASSES[m.tone]}`}>
      <span aria-hidden="true">{m.icon}</span>
      {label}
    </span>
  );
}
