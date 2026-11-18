/**
 * Codex plan headroom from the `x-codex-*` response headers (issue #416).
 *
 * Every Codex response carries the plan's usage for a short (primary) and a long (secondary)
 * window. Header names and parsing follow the Codex CLI (`codex-rs/codex-api/src/rate_limits.rs`):
 * `x-codex-{primary,secondary}-used-percent`, `-window-minutes`, `-reset-at` (unix seconds). A
 * window whose headers are absent or all zero is reported as null, as the CLI does.
 */

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

export interface CodexRateLimits {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

function float(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function int(headers: Headers, name: string): number | null {
  const raw = headers.get(name)?.trim();
  if (!raw || !/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseWindow(
  headers: Headers,
  which: "primary" | "secondary",
): RateLimitWindow | null {
  const usedPercent = float(headers, `x-codex-${which}-used-percent`);
  if (usedPercent === null) return null;
  const windowMinutes = int(headers, `x-codex-${which}-window-minutes`);
  const resetsAt = int(headers, `x-codex-${which}-reset-at`);
  const hasData =
    usedPercent !== 0 ||
    (windowMinutes !== null && windowMinutes !== 0) ||
    resetsAt !== null;
  return hasData ? { usedPercent, windowMinutes, resetsAt } : null;
}

/** The plan's usage windows from one response, or null when the response carries none. */
export function parseCodexRateLimits(headers: Headers): CodexRateLimits | null {
  const primary = parseWindow(headers, "primary");
  const secondary = parseWindow(headers, "secondary");
  if (!primary && !secondary) return null;
  return { primary, secondary };
}

/**
 * A reset time that moves by less than this is the same reset: the backend can recompute it on
 * each response, and a sample per call would bury the real changes.
 */
const RESET_JITTER_SECONDS = 60;

function windowChanged(
  prev: RateLimitWindow | null,
  next: RateLimitWindow | null,
): boolean {
  if (!prev || !next) return prev !== next;
  if (prev.usedPercent !== next.usedPercent) return true;
  if (prev.windowMinutes !== next.windowMinutes) return true;
  if (prev.resetsAt === null || next.resetsAt === null)
    return prev.resetsAt !== next.resetsAt;
  return Math.abs(prev.resetsAt - next.resetsAt) >= RESET_JITTER_SECONDS;
}

/** Whether `next` differs from the stored value enough to add a sample. */
export function rateLimitsChanged(
  prev: CodexRateLimits | null,
  next: CodexRateLimits,
): boolean {
  if (!prev) return true;
  return (
    windowChanged(prev.primary, next.primary) ||
    windowChanged(prev.secondary, next.secondary)
  );
}
