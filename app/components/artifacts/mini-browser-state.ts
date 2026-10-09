/**
 * The mini browser's bookkeeping, pure so it is tested rather than clicked through: where a reload
 * lands, how far back/forward the frame can go, and the console's bounded buffer.
 */
import type { ArtifactBridgeConsoleLevel } from "~/foh/artifact-bridge";

/** Matches the token-bearing prefix every preview URL starts with: `…/artifacts/preview/<token>/<id>`. */
const PREVIEW_PREFIX = /^(.*?\/artifacts\/preview\/[^/?#]+\/[^/?#]+)\//;

/**
 * The preview URL for `href` — a path INSIDE the bundle as the bridge reports it (`/about.html#x`,
 * token stripped) — under the token of `mintedUrl`, the freshest capability the panel holds. This is
 * how Reload and "Open in new tab" keep the page the user navigated to while swapping in a token
 * that has not lapsed (Omniplex's `retoken`).
 *
 * `href` is the page's own report, so it is untrusted: anything that is not a plain absolute path,
 * or that has a dot segment (which a browser would collapse to climb OUT of the artifact's prefix),
 * falls back to the minted entry URL. The bridge decodes the path for display, so it is re-encoded
 * here — without double-encoding an escape the page's path legitimately carried.
 */
export function artifactPreviewUrlAt(
  mintedUrl: string,
  href: string | null,
): string {
  const prefix = PREVIEW_PREFIX.exec(mintedUrl)?.[1];
  if (!prefix || !href || !href.startsWith("/") || href.startsWith("//")) {
    return mintedUrl;
  }
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const rest = cut === -1 ? "" : href.slice(cut);
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return mintedUrl;
  }
  if (/[\\\u0000-\u001f]/.test(path)) return mintedUrl;
  const encoded = encodeURI(path).replace(/%25([0-9A-Fa-f]{2})/g, "%$1");
  return `${prefix}${encoded}${rest}`;
}

/**
 * Back/forward availability. The frame is opaque-origin and shares the TAB's history, so it cannot
 * be asked how far back it can go; the panel counts instead. Every new location after the first is
 * one more step back — unless it is the answer to a Back/Forward the panel itself sent, which moves
 * one step between the two stacks.
 */
export interface FrameHistory {
  back: number;
  forward: number;
  /** The last location reported, so a duplicate report (popstate + hashchange) counts once. */
  lastHref: string | null;
  /** The direction the panel last asked for, consumed by the next new location. */
  pending: "back" | "forward" | null;
}

export const EMPTY_FRAME_HISTORY: FrameHistory = {
  back: 0,
  forward: 0,
  lastHref: null,
  pending: null,
};

export function frameHistoryRequested(
  state: FrameHistory,
  dir: "back" | "forward",
): FrameHistory {
  return { ...state, pending: dir };
}

export function frameHistoryVisited(
  state: FrameHistory,
  href: string,
): FrameHistory {
  if (href === state.lastHref) return state;
  if (state.lastHref === null) {
    // The first page of a (re)mounted frame: nothing behind it yet.
    return { back: 0, forward: 0, lastHref: href, pending: null };
  }
  if (state.pending === "back") {
    return {
      back: Math.max(0, state.back - 1),
      forward: state.forward + 1,
      lastHref: href,
      pending: null,
    };
  }
  if (state.pending === "forward") {
    return {
      back: state.back + 1,
      forward: Math.max(0, state.forward - 1),
      lastHref: href,
      pending: null,
    };
  }
  // A link the user followed inside the page: the forward stack is gone, as in any browser.
  return { back: state.back + 1, forward: 0, lastHref: href, pending: null };
}

export interface ConsoleEntry {
  /** Monotonic key, so a capped list re-renders rows by identity, not index. */
  n: number;
  level: ArtifactBridgeConsoleLevel;
  text: string;
}

/** A page that logs in a loop must not grow the app's memory without end. */
export const CONSOLE_MAX_ENTRIES = 500;

/** Append one message, keeping only the newest `max`. */
export function appendConsoleEntry(
  entries: readonly ConsoleEntry[],
  entry: ConsoleEntry,
  max = CONSOLE_MAX_ENTRIES,
): ConsoleEntry[] {
  const next = [...entries, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
