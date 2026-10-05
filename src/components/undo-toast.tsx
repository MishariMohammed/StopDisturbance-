"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Undo toast (04-ux §6.5, §10): role="status", counts down from the server's sendAfter, and pauses while
 * hovered or focused (WCAG 2.2.1). `onHold` keeps the server-side window open while paused.
 */
export function UndoToast({
  seconds,
  render,
  onUndo,
  onHold,
  onExpire,
  undoLabel,
  pending,
}: {
  seconds: number;
  render: (left: number, paused: boolean) => ReactNode;
  onUndo: () => void;
  onHold: () => void;
  onExpire: () => void;
  undoLabel: string;
  pending?: boolean;
}) {
  const [left, setLeft] = useState(seconds);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const paused = hover || focus;
  const expired = useRef(false);
  const holdRef = useRef(onHold);
  const expireRef = useRef(onExpire);
  useEffect(() => {
    holdRef.current = onHold;
    expireRef.current = onExpire;
  });

  useEffect(() => {
    if (paused) {
      holdRef.current();
      const keep = setInterval(() => holdRef.current(), 4000);
      return () => clearInterval(keep);
    }
    // Resuming restarts a full window: the server copy was pushed forward while paused.
    const tick = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(tick);
  }, [paused]);

  useEffect(() => {
    if (left === 0 && !expired.current) {
      expired.current = true;
      expireRef.current();
    }
  }, [left]);

  const [wasPaused, setWasPaused] = useState(false);
  if (paused !== wasPaused) {
    setWasPaused(paused);
    if (!paused && left > 0) setLeft(seconds);
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      }}
    >
      <div className="flex w-full max-w-xl flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 shadow-drawer">
        <p role="status" aria-live="polite" aria-atomic="true" className="font-medium">
          {render(left, paused)}
        </p>
        <button
          type="button"
          onClick={onUndo}
          disabled={pending || left === 0}
          className="min-h-tap rounded-md bg-primary px-4 font-medium text-primary-fg disabled:opacity-60"
        >
          {undoLabel}
        </button>
      </div>
    </div>
  );
}
