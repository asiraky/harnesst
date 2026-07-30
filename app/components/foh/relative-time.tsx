import { useEffect, useRef } from "react";

/** Compact relative-time labels for FOH lists ("2m", "1h", "Tue"). */
export function relativeTimeLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const ms = now.getTime() - then.getTime();
  if (ms < 60_000) return "now";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h`;
  if (ms < 7 * 24 * 60 * 60_000) {
    return then.toLocaleDateString(undefined, { weekday: "short" });
  }
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Keeps the server-rendered label through hydration, then recomputes it with the browser's
 * clock, locale, and time zone. Updating the text node directly is intentional: after a
 * suppressed mismatch React's client tree already believes it contains the browser-local label,
 * so setting state to that same label would not patch the server text.
 */
export function FohRelativeTime({ value }: { value: string }) {
  const elementRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (elementRef.current) {
      elementRef.current.textContent = relativeTimeLabel(value);
    }
  }, [value]);

  return (
    <span ref={elementRef} suppressHydrationWarning>
      {relativeTimeLabel(value)}
    </span>
  );
}
