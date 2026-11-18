/**
 * Shared, pure helpers for the usage views (issue #418): the time window, number formatting and
 * the ratios every level shows. Client-safe (no server imports).
 *
 * A missing figure is `null`, never 0: a provider that does not report cached input, or a row
 * recorded before the field existed, renders "not available" rather than a misleading zero.
 */

export const WINDOW_DAYS = [1, 7, 30] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

/** The `?days=` query param, defaulting to a week. */
export function parseWindowDays(value: string | null | undefined): WindowDays {
  const n = Number(value);
  return (WINDOW_DAYS as readonly number[]).includes(n) ? (n as WindowDays) : 7;
}

export function windowSince(days: WindowDays, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** 999 · 12.3k · 718k · 1.2M · 242M. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const scaled = (v: number, unit: string) =>
    `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${unit}`;
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return scaled(n / 1000, "k");
  if (abs < 1_000_000_000) return scaled(n / 1_000_000, "M");
  return scaled(n / 1_000_000_000, "B");
}

/** `part / whole`, or null when either side is unknown or the whole is zero. */
export function ratio(
  part: number | null | undefined,
  whole: number | null | undefined,
): number | null {
  if (part == null || whole == null || whole <= 0) return null;
  return part / whole;
}

/** 0.004 → "0.4%", 0.9 → "90%". */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  const pct = fraction * 100;
  if (pct !== 0 && Math.abs(pct) < 10) return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(pct)}%`;
}

export function formatUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Where eve compacts the context, as a share of the window. */
export const COMPACTION_THRESHOLD = 0.9;

/** How full a context is: amber past half the window, red from the compaction threshold. */
export function contextLevel(fraction: number | null): "ok" | "warn" | "crit" | null {
  if (fraction == null) return null;
  if (fraction >= COMPACTION_THRESHOLD) return "crit";
  if (fraction > 0.5) return "warn";
  return "ok";
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A plan window's length as people say it: 300 → "5h", 10080 → "weekly". */
export function planWindowLabel(minutes: number | null | undefined): string {
  if (minutes == null) return "window";
  if (minutes === 10080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** A run id as shown: the eve run id when there is one, else ours. */
export function runLabel(run: { id: string; externalRunId?: string | null }): string {
  return run.externalRunId ?? run.id;
}
