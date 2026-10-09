/**
 * A published page (#291) in a small browser: back, forward, reload, where you are inside the
 * bundle, a device width, and the page's console. Ported from Omniplex's `MiniBrowser`.
 *
 * THE IFRAME IS THE SECURITY SURFACE OF THIS FILE, so its attributes are not styling choices:
 *
 * - `sandbox` WITHOUT `allow-same-origin`, ever. The page then runs in an opaque origin and cannot
 *   reach this document, harnesst's cookie or its API, whichever origin served it. The tokens it
 *   does get match the preview response's own CSP sandbox (`artifact-preview.server.ts`): scripts,
 *   forms, popups, modals and downloads — what an agent-written prototype needs to behave like a
 *   web page. A popup or a download is the page acting from its own opaque origin, not harnesst's.
 * - `src`, never `srcdoc` and never a `blob:` URL. A local scheme inherits THIS document's CSP and
 *   cannot carry its own; loading over HTTP is what lets the response sandbox itself with a real
 *   header — the part that also survives a top-level navigation ("Open in new tab"), which iframe
 *   sandboxing cannot.
 * - `allow=` denying the powerful features, because the attribute's default is `'src'` (allow).
 * - `referrerPolicy="no-referrer"`, so the token-bearing URL never leaves in a Referer.
 *
 * THE BRIDGE. The preview route injects a script that reports the page's location and console OUT
 * with postMessage and accepts back/forward IN (`artifact-bridge.ts`). Everything it sends is
 * untrusted display data: a message is only read when it comes from THIS frame's window and passes
 * `isArtifactBridgeMessage`, and it is rendered as text. Nothing sent back gives the page anything
 * it could not do itself.
 *
 * THE FRAME'S `src` IS CAPTURED ONCE. The panel re-mints the capability before it lapses and hands
 * the fresh one down as `preview`; that never reloads the page. It is used by the next Reload (and
 * by the panel's "Open in new tab"). Switching version remounts this component by key.
 */
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Monitor,
  RotateCw,
  Smartphone,
  SquareTerminal,
  Tablet,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  appendConsoleEntry,
  artifactPreviewUrlAt,
  EMPTY_FRAME_HISTORY,
  frameHistoryRequested,
  frameHistoryVisited,
  type ConsoleEntry,
  type FrameHistory,
} from "~/components/artifacts/mini-browser-state";
import { frameFit } from "~/components/artifacts/panel-geometry";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  artifactBridgeNav,
  isArtifactBridgeMessage,
} from "~/foh/artifact-bridge";
import { ARTIFACT_PREVIEW_IFRAME_ALLOW } from "~/foh/artifact-media";
import type { ArtifactPreviewCapability } from "~/foh/use-artifact-preview";
import { cn } from "~/lib/utils";

export type Device = "desktop" | "tablet" | "phone";

const DEVICES: {
  id: Device;
  label: string;
  width?: number;
  Icon: typeof Monitor;
}[] = [
  { id: "desktop", label: "Desktop", Icon: Monitor },
  { id: "tablet", label: "Tablet · 768", width: 768, Icon: Tablet },
  { id: "phone", label: "Phone · 390", width: 390, Icon: Smartphone },
];

const DEVICE_KEY = "harnesst.artifactDevice";

function loadDevice(): Device {
  try {
    const value = window.localStorage.getItem(DEVICE_KEY);
    return value === "tablet" || value === "phone" ? value : "desktop";
  } catch {
    return "desktop";
  }
}

/** Refresh a token this close to expiry before reloading, rather than reload into a 404. */
const EXPIRY_MARGIN_MS = 60_000;

/** The `title` of a console row and the badge — capped so a runaway page cannot draw "12345". */
function badgeCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

export function MiniBrowser({
  preview,
  refreshPreview,
  onLocationChange,
  title,
}: {
  /** The freshest capability. A newer one does not reload the page; the next Reload uses it. */
  preview: ArtifactPreviewCapability;
  refreshPreview: () => Promise<ArtifactPreviewCapability>;
  /** The bridge's latest `href` (bundle path, token stripped), for "Open in new tab". */
  onLocationChange?: (href: string) => void;
  title: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef(preview);
  const onLocationRef = useRef(onLocationChange);
  useEffect(() => {
    previewRef.current = preview;
    onLocationRef.current = onLocationChange;
  });

  // The first URL only — see the module comment.
  const [src, setSrc] = useState(preview.url);
  const [frameKey, setFrameKey] = useState(0);
  const [href, setHref] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState("");
  const [history, setHistory] = useState<FrameHistory>(EMPTY_FRAME_HISTORY);
  // Mirrors `history` for the message handler, which must not be re-bound on every navigation.
  const historyRef = useRef(history);
  const [loading, setLoading] = useState(true);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const seq = useRef(0);
  const errors = entries.filter((entry) => entry.level === "error").length;

  const [device, setDevice] = useState<Device>(loadDevice);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () =>
      setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // The sender check is the one that matters: any window can post a well-formed message.
      if (!frame || event.source !== frame.contentWindow) return;
      if (!isArtifactBridgeMessage(event.data)) return;
      const message = event.data;
      if (message.type === "location") {
        setHref(message.href);
        setPageTitle(message.title);
        const next = frameHistoryVisited(historyRef.current, message.href);
        historyRef.current = next;
        setHistory(next);
        onLocationRef.current?.(message.href);
        return;
      }
      const n = ++seq.current;
      setEntries((all) =>
        appendConsoleEntry(all, {
          n,
          level: message.level,
          text: message.args.join(" "),
        }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const navigate = (dir: "back" | "forward") => {
    const next = frameHistoryRequested(historyRef.current, dir);
    historyRef.current = next;
    setHistory(next);
    // The frame is opaque-origin, so "*" is the only target that reaches it. Nothing sent is
    // secret: it is a request to go back or forward, which the page only obeys from its parent.
    frameRef.current?.contentWindow?.postMessage(artifactBridgeNav(dir), "*");
  };

  const reload = async () => {
    setReloadError(null);
    let fresh = previewRef.current;
    if (
      fresh.expiresAt === null ||
      Date.now() > fresh.expiresAt - EXPIRY_MARGIN_MS
    ) {
      try {
        fresh = await refreshPreview();
      } catch (error) {
        setReloadError(
          error instanceof Error ? error.message : "Could not reload.",
        );
        return;
      }
    }
    setEntries([]);
    setLoading(true);
    setSrc(artifactPreviewUrlAt(fresh.url, href));
    // A new key remounts the frame, which reloads it even when the URL is unchanged — and a new
    // frame starts with no history of its own.
    historyRef.current = EMPTY_FRAME_HISTORY;
    setHistory(EMPTY_FRAME_HISTORY);
    setFrameKey((key) => key + 1);
  };

  const chooseDevice = (next: Device) => {
    setDevice(next);
    try {
      window.localStorage.setItem(DEVICE_KEY, next);
    } catch {
      // Private mode: the choice lasts this view.
    }
  };

  const spec = DEVICES.find((d) => d.id === device) ?? DEVICES[0];
  const fit = frameFit(spec.width, stage.width);
  const path = href ?? "/";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b px-1 py-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title="Back"
          aria-label="Back"
          disabled={history.back === 0}
          onClick={() => navigate("back")}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Forward"
          aria-label="Forward"
          disabled={history.forward === 0}
          onClick={() => navigate("forward")}
        >
          <ArrowRight className="size-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Reload"
          aria-label="Reload"
          onClick={() => void reload()}
        >
          <RotateCw className="size-4" aria-hidden />
        </Button>
        <span
          className="mx-1 min-w-0 flex-1 truncate rounded-full bg-muted px-3 py-1 font-mono text-[11px] text-muted-foreground"
          title={pageTitle ? `${pageTitle}\n${path}` : path}
        >
          {path}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title={`Width: ${spec.label}`}
              aria-label={`Width: ${spec.label}`}
            >
              <spec.Icon className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {DEVICES.map((d) => (
              <DropdownMenuItem key={d.id} onSelect={() => chooseDevice(d.id)}>
                <d.Icon aria-hidden />
                <span className="flex-1">{d.label}</span>
                {d.id === device && <Check aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="relative">
          <Button
            variant="ghost"
            size="icon-sm"
            title={consoleOpen ? "Hide the console" : "Show the console"}
            aria-label={consoleOpen ? "Hide the console" : "Show the console"}
            aria-pressed={consoleOpen}
            onClick={() => setConsoleOpen((v) => !v)}
            className={cn(consoleOpen && "bg-muted")}
          >
            <SquareTerminal className="size-4" aria-hidden />
          </Button>
          {errors > 0 && (
            <span
              aria-label={`${errors} console errors`}
              className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[9px] leading-4 font-semibold text-white tabular-nums"
            >
              {badgeCount(errors)}
            </span>
          )}
        </span>
      </div>

      {reloadError && (
        <p
          role="alert"
          className="shrink-0 border-b px-3 py-1.5 text-[11px] text-destructive"
        >
          Couldn&rsquo;t reload: {reloadError}
        </p>
      )}

      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-muted/40"
      >
        <div
          className="mx-auto h-full"
          style={
            fit.width ? { width: fit.width * fit.scale } : { width: "100%" }
          }
        >
          <iframe
            key={frameKey}
            ref={frameRef}
            src={src}
            title={title}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            allow={ARTIFACT_PREVIEW_IFRAME_ALLOW}
            referrerPolicy="no-referrer"
            onLoad={() => setLoading(false)}
            className={cn(
              "block border-0",
              // White once the page is up, not before: a page written for a light background must
              // not inherit the app's dark theme through a transparent frame, but painting white
              // while it loads flashes a white slab over a dark app.
              !loading && "bg-white",
              fit.width && "shadow-md",
            )}
            style={
              fit.width
                ? {
                    width: fit.width,
                    height: stage.height / fit.scale,
                    transform: `scale(${fit.scale})`,
                    transformOrigin: "top left",
                  }
                : { width: "100%", height: "100%" }
            }
          />
        </div>
        {loading && (
          <span className="absolute top-2 right-2 rounded-full bg-background/80 p-1 shadow-sm">
            <Loader2
              className="size-3.5 animate-spin text-muted-foreground"
              aria-label="Loading"
            />
          </span>
        )}
      </div>

      {consoleOpen && (
        <div className="flex max-h-[45%] min-h-32 shrink-0 flex-col border-t">
          <div className="flex items-center gap-1 border-b px-2 py-0.5">
            <span className="flex-1 text-[11px] font-medium text-muted-foreground">
              Console
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Clear the console"
              aria-label="Clear the console"
              onClick={() => setEntries([])}
            >
              <Trash2 aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Hide the console"
              aria-label="Hide the console"
              onClick={() => setConsoleOpen(false)}
            >
              <X aria-hidden />
            </Button>
          </div>
          <ol
            aria-label="Console messages"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain font-mono text-[11px]"
          >
            {entries.length === 0 && (
              <li className="px-3 py-2 font-sans text-muted-foreground italic">
                Nothing logged.
              </li>
            )}
            {entries.map((entry) => (
              <li
                key={entry.n}
                className={cn(
                  "border-b px-3 py-1 break-words whitespace-pre-wrap",
                  entry.level === "error" &&
                    "bg-destructive/10 text-destructive",
                  entry.level === "warn" &&
                    "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                  entry.level === "info" && "text-sky-700 dark:text-sky-300",
                  entry.level === "debug" && "text-muted-foreground",
                )}
              >
                {entry.text}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
