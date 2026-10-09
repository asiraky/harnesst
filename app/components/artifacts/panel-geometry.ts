/**
 * The arithmetic behind the artifact panel's width (drag handle, arrow keys, stored width) and the
 * mini browser's device frames. Pure so the clamping rules are tested rather than eyeballed.
 */

/** Narrowest the docked panel gets: a toolbar of six controls plus a URL pill still fits. */
export const PANEL_MIN_WIDTH = 360;
/** What the conversation keeps beside the panel: a readable column of chat plus the composer. */
export const CONVERSATION_MIN_WIDTH = 360;
/** Preferred width when nothing is stored, before the 45%-of-viewport cap. */
export const PANEL_DEFAULT_WIDTH = 560;
/** Arrow keys on the separator move by this much, and by `PANEL_KEY_STEP_LARGE` with Shift. */
export const PANEL_KEY_STEP = 16;
export const PANEL_KEY_STEP_LARGE = 64;

/**
 * The width the docked panel is drawn at. `reservedLeft` is everything left of the conversation
 * (the app sidebar, and the session list when it is showing); the conversation keeps
 * `CONVERSATION_MIN_WIDTH` beside it. When the window is too narrow for both minimums the panel's
 * wins — the docked layout only exists from 1280px, where that cannot happen with the stock
 * sidebar, and a panel below its minimum is the worse of the two failures.
 */
export function clampPanelWidth(input: {
  viewport: number;
  requested: number;
  reservedLeft?: number;
}): number {
  const max = panelMaxWidth(input.viewport, input.reservedLeft ?? 0);
  const requested = Number.isFinite(input.requested)
    ? input.requested
    : PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, requested)));
}

/** The widest the panel may be dragged, never below the panel's own minimum. */
export function panelMaxWidth(viewport: number, reservedLeft = 0): number {
  return Math.max(
    PANEL_MIN_WIDTH,
    Math.floor(viewport - reservedLeft - CONVERSATION_MIN_WIDTH),
  );
}

/** First-open width: 560px, or 45% of the window when that is smaller. */
export function defaultPanelWidth(viewport: number): number {
  return Math.min(PANEL_DEFAULT_WIDTH, Math.round(viewport * 0.45));
}

/**
 * A width read back from storage, or null when there is none worth trusting (absent, garbage, or
 * below the minimum — a value that small was written by an older or broken build).
 */
export function parseStoredPanelWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= PANEL_MIN_WIDTH ? value : null;
}

/**
 * The separator's keyboard model. The panel sits on the RIGHT, so ArrowLeft widens it (the handle
 * moves left) and ArrowRight narrows it; Home/End jump to the extremes. Null for any other key, so
 * the caller lets it through.
 */
export function panelWidthForKey(input: {
  key: string;
  shiftKey: boolean;
  width: number;
  min: number;
  max: number;
}): number | null {
  const step = input.shiftKey ? PANEL_KEY_STEP_LARGE : PANEL_KEY_STEP;
  let next: number;
  if (input.key === "ArrowLeft") next = input.width + step;
  else if (input.key === "ArrowRight") next = input.width - step;
  else if (input.key === "Home") next = input.min;
  else if (input.key === "End") next = input.max;
  else return null;
  return Math.min(input.max, Math.max(input.min, next));
}

/**
 * A page's frame width and the scale that fits it into the stage (ported from Omniplex
 * `frameFit.ts`). A device wider than the panel is shrunk whole rather than cropped, so a narrow
 * panel can still show what the tablet layout looks like. No device width means "fill the stage".
 */
export function frameFit(
  deviceWidth: number | undefined,
  stageWidth: number,
): { width?: number; scale: number } {
  if (!deviceWidth || stageWidth <= 0) return { scale: 1 };
  return { width: deviceWidth, scale: Math.min(1, stageWidth / deviceWidth) };
}
