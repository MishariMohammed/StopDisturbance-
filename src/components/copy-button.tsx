"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";

/** Copies text to the clipboard and announces the result politely. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const t = useTranslations("common");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
        className={className ?? "min-h-tap rounded-md border border-border-strong px-3 text-sm font-medium"}
      >
        {label}
      </button>
      <span role="status" aria-live="polite" className="text-sm text-muted">
        {state === "copied" ? t("copied") : state === "failed" ? t("copyFailed") : ""}
      </span>
    </span>
  );
}
