/**
 * The artifact BRIDGE protocol — what a previewed page (preview and share routes) says to the
 * harnesst panel framing it, and the one thing the panel may say back. Isomorphic: the panel
 * imports the guard and types; the server injects the script (`artifact-bridge.server.ts`).
 *
 * The page runs in an opaque-origin sandbox, so the panel cannot read its location, title or
 * console. The bridge script, injected first into every served HTML document, reports them OUT
 * with `postMessage`:
 *
 *   { source: "harnesst-artifact", type: "location", href, title }
 *       on load, popstate and hashchange. `href` is the page's path INSIDE the bundle with the
 *       token-bearing prefix stripped (`/about.html#team`), so the panel can show it and nothing
 *       bearer-shaped leaks into UI state.
 *   { source: "harnesst-artifact", type: "console", level, args }
 *       for console.log/info/warn/error/debug, uncaught errors and unhandled rejections. `args` are
 *       already strings (≤ 4000 chars each, ≤ 20 of them).
 *
 * and accepts exactly one command IN, honoured only when it comes from `window.parent`:
 *
 *   { source: "harnesst-artifact", type: "nav", dir: "back" | "forward" }
 *
 * GRANTS NO CAPABILITY. Everything the page sends is untrusted display data — the panel must
 * check `event.source === iframe.contentWindow` AND `isArtifactBridgeMessage(event.data)`, and
 * render strings as text. Nothing the panel sends gives the page anything it could not do itself
 * (history navigation of its own frame). There is still no fetch proxy and no storage relay.
 */

/** The namespace every bridge message carries, so the panel can ignore unrelated `message` events. */
export const ARTIFACT_BRIDGE_SOURCE = "harnesst-artifact";

export const ARTIFACT_BRIDGE_CONSOLE_LEVELS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
] as const;
export type ArtifactBridgeConsoleLevel =
  (typeof ARTIFACT_BRIDGE_CONSOLE_LEVELS)[number];

/** Longest single console argument the bridge forwards, and most arguments per call. */
export const ARTIFACT_BRIDGE_MAX_ARG_CHARS = 4000;
export const ARTIFACT_BRIDGE_MAX_ARGS = 20;

export interface ArtifactBridgeLocation {
  source: typeof ARTIFACT_BRIDGE_SOURCE;
  type: "location";
  /** Path within the bundle, token stripped, with search and hash: `/index.html?x=1#y`. */
  href: string;
  title: string;
}

export interface ArtifactBridgeConsole {
  source: typeof ARTIFACT_BRIDGE_SOURCE;
  type: "console";
  level: ArtifactBridgeConsoleLevel;
  args: string[];
}

/** Page → panel. */
export type ArtifactBridgeMessage =
  ArtifactBridgeLocation | ArtifactBridgeConsole;

/** Panel → page. */
export interface ArtifactBridgeNav {
  source: typeof ARTIFACT_BRIDGE_SOURCE;
  type: "nav";
  dir: "back" | "forward";
}

/** The command the panel posts to the frame's `contentWindow` for its back/forward buttons. */
export function artifactBridgeNav(dir: "back" | "forward"): ArtifactBridgeNav {
  return { source: ARTIFACT_BRIDGE_SOURCE, type: "nav", dir };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a `message` event's data is a well-formed page → panel bridge message. Shape only: the
 * caller still checks `event.source` is the artifact frame. Over-long strings are refused rather
 * than trimmed — the injected script never produces them, so one is a page speaking for itself.
 */
export function isArtifactBridgeMessage(
  data: unknown,
): data is ArtifactBridgeMessage {
  if (!isRecord(data) || data.source !== ARTIFACT_BRIDGE_SOURCE) return false;
  if (data.type === "location") {
    return (
      typeof data.href === "string" &&
      data.href.length <= 8192 &&
      typeof data.title === "string" &&
      data.title.length <= ARTIFACT_BRIDGE_MAX_ARG_CHARS
    );
  }
  if (data.type === "console") {
    return (
      typeof data.level === "string" &&
      (ARTIFACT_BRIDGE_CONSOLE_LEVELS as readonly string[]).includes(
        data.level,
      ) &&
      Array.isArray(data.args) &&
      data.args.length <= ARTIFACT_BRIDGE_MAX_ARGS &&
      data.args.every(
        (arg) =>
          typeof arg === "string" &&
          arg.length <= ARTIFACT_BRIDGE_MAX_ARG_CHARS,
      )
    );
  }
  return false;
}
