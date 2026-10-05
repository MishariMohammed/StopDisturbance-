"use client";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Native modal <dialog>: traps focus, Esc closes, and focus returns to the element that opened it
 * (WCAG 2.4.3). `side="end"` renders it as an end-side drawer (left in Arabic).
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  side,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  side?: "end";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
    if (!open && opener.current) {
      const el = opener.current;
      opener.current = null;
      if (el.isConnected) el.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={
        side === "end"
          ? "fixed inset-y-0 m-0 ms-auto h-dvh max-h-none w-full max-w-[420px] overflow-y-auto border-s border-border bg-surface p-6 text-text shadow-drawer"
          : "m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-6 text-text shadow-drawer"
      }
    >
      {open && children}
    </dialog>
  );
}
