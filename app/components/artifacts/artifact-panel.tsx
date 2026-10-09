/**
 * The artifact panel: one published artifact beside (or over) the conversation — a page in the
 * mini browser, every other kind in `ArtifactFileView` — with the ways out of it (share, download,
 * a new tab). Driven entirely by `useArtifactPreview`'s state; renders nothing while it is closed.
 *
 * TWO LAYOUTS, chosen by width:
 *
 * - From xl (1280px) it is DOCKED: an `<aside>` the caller places in its flex row after the
 *   conversation (FOH), or a fixed right-hand overlay (`placement="overlay"`, the BOH table page,
 *   whose document scrolls). The left edge is a drag handle — pointer capture, arrow keys — and
 *   the width is clamped so the conversation keeps a readable column (`clampPanelWidth`), and
 *   stored. Maximise fills the content area; the caller hides its conversation column for that.
 *   Esc closes, unless a menu, popover or dialog owns the key.
 * - Below xl it is a Radix Sheet over the page, full width on a phone, closing the way any sheet
 *   does. No resize or maximise: there is nothing beside it to make room for.
 *
 * The iframe's security attributes live in `mini-browser.tsx`, the only place an artifact's own
 * markup is rendered.
 */
import {
  Check,
  Code,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  Link2,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { ArtifactFileView } from "~/components/artifacts/artifact-file-view";
import { artifactPreviewUrlAt } from "~/components/artifacts/mini-browser-state";
import { MiniBrowser } from "~/components/artifacts/mini-browser";
import {
  clampPanelWidth,
  defaultPanelWidth,
  PANEL_MIN_WIDTH,
  panelMaxWidth,
  panelWidthForKey,
  parseStoredPanelWidth,
} from "~/components/artifacts/panel-geometry";
import {
  absoluteShareUrl,
  SharePopover,
} from "~/components/artifacts/share-popover";
import { useCopy } from "~/components/chat/clipboard";
import { formatBytes } from "~/components/chat/composer";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import type { ChatArtifact } from "~/chat/types";
import { artifactRawUrl } from "~/foh/artifact-media";
import {
  artifactHasSourceView,
  type ArtifactViewer,
  type ArtifactViewMode,
} from "~/foh/artifact-viewer";
import type {
  ArtifactPreview,
  ArtifactPreviewVersion,
} from "~/foh/use-artifact-preview";
import { cn } from "~/lib/utils";

/** The docked layout's breakpoint — Tailwind's `xl`, which callers' `xl:` classes must match. */
const DOCKED_QUERY = "(min-width: 1280px)";
const WIDTH_KEY = "harnesst.artifactPanelWidth";
const VIEW_KEY_PREFIX = "harnesst.artifactView:";

function subscribeDocked(onChange: () => void) {
  const query = window.matchMedia(DOCKED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the panel docks. False on the server: the panel only ever opens from a click. */
export function useArtifactPanelDocked(): boolean {
  return useSyncExternalStore(
    subscribeDocked,
    () => window.matchMedia(DOCKED_QUERY).matches,
    () => false,
  );
}

/** The window's layout width — `clientWidth`, so a page scrollbar is not counted as room. */
function viewportWidth(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

function useViewport(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : viewportWidth(),
  );
  useEffect(() => {
    const onResize = () => setWidth(viewportWidth());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function loadViewMode(viewer: ArtifactViewer): ArtifactViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY_PREFIX + viewer) === "source"
      ? "source"
      : "preview";
  } catch {
    return "preview";
  }
}

/** Preview or source, remembered per viewer — someone reading CSVs as tables keeps getting tables. */
function useViewMode(
  viewer: ArtifactViewer,
): [ArtifactViewMode, (mode: ArtifactViewMode) => void] {
  const [chosen, setChosen] = useState(() => ({
    viewer,
    mode: loadViewMode(viewer),
  }));
  const mode = chosen.viewer === viewer ? chosen.mode : loadViewMode(viewer);
  const set = useCallback(
    (next: ArtifactViewMode) => {
      try {
        window.localStorage.setItem(VIEW_KEY_PREFIX + viewer, next);
      } catch {
        // Private mode: the choice lasts this panel.
      }
      setChosen({ viewer, mode: next });
    },
    [viewer],
  );
  return [artifactHasSourceView(viewer) ? mode : "preview", set];
}

const VIEWER_LABELS: Record<ArtifactViewer, string> = {
  html: "Page",
  markdown: "Markdown",
  svg: "SVG",
  image: "Image",
  audio: "Audio",
  video: "Video",
  pdf: "PDF",
  csv: "Table",
  json: "JSON",
  text: "Text",
  file: "File",
};

/**
 * When a version was published, for the picker. A time for today's, a date for anything older —
 * a refine loop makes several versions inside one conversation, so "14:32" is what distinguishes
 * them, while a card reopened next week needs the day.
 */
function versionTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = new Date();
  return at.toDateString() === today.toDateString()
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleDateString([], { month: "short", day: "numeric" });
}

function versionLabel(version: ArtifactPreviewVersion): string {
  const when = versionTime(version.createdAt);
  return when ? `v${version.version} · ${when}` : `v${version.version}`;
}

export interface ArtifactPanelProps {
  /** `useArtifactPreview`'s state. The panel renders nothing while `preview.artifact` is null. */
  preview: ArtifactPreview;
  projectId: string;
  /** Docked only: fill the content area. The caller hides its conversation column (at `xl`). */
  maximised: boolean;
  onMaximisedChange: (maximised: boolean) => void;
  /**
   * `docked` (default): an `<aside>` the caller puts in its flex row right after the conversation
   * column. `overlay`: fixed to the right edge over a normally scrolling page.
   */
  placement?: "docked" | "overlay";
  /**
   * Overlay only: the width of the chrome left of the page content (the app sidebar), which the
   * conversation-room clamp and maximise leave alone. Docked panels measure it themselves.
   */
  overlayInsetLeft?: number;
}

export function ArtifactPanel(props: ArtifactPanelProps) {
  const docked = useArtifactPanelDocked();
  const artifact = props.preview.artifact;
  if (!artifact) return null;
  if (!docked) {
    return (
      <Sheet open onOpenChange={(open) => !open && props.preview.close()}>
        <SheetContent
          tabIndex={-1}
          className="w-full gap-0 p-0 sm:w-[min(48rem,92vw)] sm:max-w-none"
          // Radix would focus the first control, popping its tooltip on a touch screen; focus still
          // has to enter the sheet, so it lands on the sheet itself.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <SheetTitle className="sr-only">{panelTitle(artifact)}</SheetTitle>
          <PanelBody {...props} artifact={artifact} docked={false} />
        </SheetContent>
      </Sheet>
    );
  }
  return <DockedPanel {...props} artifact={artifact} />;
}

function panelTitle(artifact: ChatArtifact): string {
  return artifact.title?.trim() || artifact.name;
}

function DockedPanel(props: ArtifactPanelProps & { artifact: ChatArtifact }) {
  const { preview, maximised, onMaximisedChange } = props;
  const overlay = props.placement === "overlay";
  const viewport = useViewport();
  const asideRef = useRef<HTMLElement>(null);
  // The width the reader asked for: null until the stored one is read, which happens in a layout
  // effect (before the first paint, so there is no jump) rather than during render, where it would
  // read the browser's storage on a pass the server renders too.
  const [requested, setRequested] = useState<number | null>(null);
  useLayoutEffect(() => {
    try {
      const stored = parseStoredPanelWidth(
        window.localStorage.getItem(WIDTH_KEY),
      );
      if (stored !== null) setRequested(stored);
    } catch {
      // Private mode: the default width.
    }
  }, []);
  const [dragging, setDragging] = useState(false);
  // Everything left of the conversation column — the app sidebar (the caller collapses its own
  // list while the panel is open). Measured from the conversation itself, the aside's previous
  // sibling in the flex row, so the clamp follows whatever chrome the layout actually has.
  const [reservedLeft, setReservedLeft] = useState(props.overlayInsetLeft ?? 0);
  useLayoutEffect(() => {
    if (overlay) {
      setReservedLeft(props.overlayInsetLeft ?? 0);
      return;
    }
    const sibling = asideRef.current?.previousElementSibling;
    if (!sibling) {
      setReservedLeft(0);
      return;
    }
    const measure = () => setReservedLeft(sibling.getBoundingClientRect().left);
    measure();
    // Observed, not measured once: the shell folds its session list away only AFTER the panel
    // opens (an effect in the route), which moves the conversation left and grows it — a resize
    // this observer sees, where a one-off measurement would keep the list's width reserved.
    const observer = new ResizeObserver(measure);
    observer.observe(sibling);
    return () => observer.disconnect();
  }, [overlay, props.overlayInsetLeft, viewport, maximised]);

  const width = clampPanelWidth({
    viewport,
    requested: requested ?? defaultPanelWidth(viewport),
    reservedLeft,
  });
  const max = panelMaxWidth(viewport, reservedLeft);
  // What a drag stores when it ends. Synced after commit, not assigned during render.
  const widthRef = useRef(width);
  useLayoutEffect(() => {
    widthRef.current = width;
  }, [width]);

  const store = (value: number) => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(value));
    } catch {
      // Private mode: the width lasts this page.
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Capture, so the drag keeps reporting over the iframe (which would otherwise swallow every
    // move) and past the window edge.
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setRequested(
      clampPanelWidth({
        viewport: viewportWidth(),
        requested: viewportWidth() - event.clientX,
        reservedLeft,
      }),
    );
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // Stored once, when the drag ends, not on every pixel of it.
    store(widthRef.current);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = panelWidthForKey({
      key: event.key,
      shiftKey: event.shiftKey,
      width,
      min: PANEL_MIN_WIDTH,
      max,
    });
    if (next === null) return;
    event.preventDefault();
    setRequested(next);
    store(next);
  };

  // Esc closes the docked panel (the sheet handles its own). A menu, popover or dialog owns Esc
  // first: Radix dismisses its layer on a capture-phase listener and prevents the event's default,
  // and an open one is still in the DOM when this bubble-phase listener runs.
  const close = preview.close;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      if (document.querySelector("[role=dialog],[role=menu],[role=listbox]"))
        return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <aside
      ref={asideRef}
      aria-label="Artifact preview"
      style={
        maximised ? (overlay ? { left: reservedLeft } : undefined) : { width }
      }
      className={cn(
        "flex flex-col border-l bg-background",
        overlay
          ? "fixed inset-y-0 right-0 z-40 shadow-xl"
          : maximised
            ? "relative min-w-0 flex-1"
            : "relative shrink-0",
        // While dragging, nothing inside may take the pointer — selection would run and an iframe
        // would eat the moves if capture were ever lost.
        dragging && "select-none [&_iframe]:pointer-events-none",
      )}
    >
      {!maximised && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the preview"
          aria-valuenow={width}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={max}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className={cn(
            "absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none hover:bg-primary/30 focus-visible:bg-primary/40",
            dragging && "bg-primary/40",
          )}
        />
      )}
      <PanelBody
        {...props}
        docked
        onToggleMaximised={() => onMaximisedChange(!maximised)}
      />
    </aside>
  );
}

function PanelBody({
  preview,
  projectId,
  artifact,
  docked,
  maximised,
  onToggleMaximised,
}: ArtifactPanelProps & {
  artifact: ChatArtifact;
  docked: boolean;
  onToggleMaximised?: () => void;
}) {
  const viewer = artifact.viewer;
  const isPage = artifact.kind === "html";
  const [mode, setMode] = useViewMode(viewer);
  const versionId = preview.selectedVersionId;
  const title = panelTitle(artifact);
  const picker = preview.versions.length > 1 ? preview.versions : null;
  const shownVersion = preview.versions.find((v) => v.id === versionId);
  const subtitle = [
    artifact.title?.trim() ? artifact.name : null,
    VIEWER_LABELS[viewer],
    formatBytes(shownVersion?.byteSize ?? artifact.byteSize),
  ]
    .filter(Boolean)
    .join(" · ");

  // Where the mini browser is, keyed by version so a stale location never retargets another one.
  const [location, setLocation] = useState<{
    key: string;
    href: string;
  } | null>(null);
  const locationKey = `${artifact.id}:${versionId ?? ""}`;

  const openUrl = isPage
    ? preview.preview && preview.preview.versionId === versionId
      ? artifactPreviewUrlAt(
          preview.preview.url,
          location?.key === locationKey ? location.href : null,
        )
      : null
    : artifactRawUrl(projectId, artifact.id, versionId);
  const downloadUrl = isPage
    ? null
    : artifactRawUrl(projectId, artifact.id, versionId, { download: true });
  const { copy, copied } = useCopy();

  // Flipping preview and source keeps the reader roughly where they were, by proportion: the two
  // are different heights, but a third of the way down one is near a third down the other. The
  // new view usually loads its text after the flip, so the restore waits (briefly) for there to
  // be something to scroll.
  const scrollRef = useRef<HTMLDivElement>(null);
  const changeMode = (next: ArtifactViewMode) => {
    if (next === mode) return;
    const el = scrollRef.current;
    const room = el ? el.scrollHeight - el.clientHeight : 0;
    const ratio = el && room > 0 ? el.scrollTop / room : 0;
    setMode(next);
    if (!el || ratio === 0) return;
    let frames = 0;
    const restore = () => {
      const space = el.scrollHeight - el.clientHeight;
      if (space > 0) {
        el.scrollTop = ratio * space;
        return;
      }
      if (++frames < 60) requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
  };

  // A page's mini browser stays MOUNTED while its source is shown, only hidden: unmounting it
  // would drop the frame, so flipping back would reload the entry page at the top and lose where
  // the reader had navigated and whatever state the page held. It goes away only with the version
  // (by key) or the panel.
  const hasBrowser = isPage && viewer === "html";
  const pageView = hasBrowser && mode === "preview";
  const browser = hasBrowser ? (
    preview.error ? (
      <p className="p-4 text-sm text-muted-foreground">{preview.error}</p>
    ) : preview.preview && preview.preview.versionId === versionId ? (
      <MiniBrowser
        key={locationKey}
        title={title}
        preview={preview.preview}
        refreshPreview={preview.refreshPreview}
        onLocationChange={(href) => setLocation({ key: locationKey, href })}
      />
    ) : (
      <p className="p-4 text-sm text-muted-foreground">Opening…</p>
    )
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={artifact.name}>
            {title}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {subtitle}
          </p>
        </div>
        {picker && (
          // A plain select: switching versions replaces the whole document, so the control has to
          // read as a jump rather than as a filter.
          <select
            value={versionId ?? picker[0].id}
            onChange={(event) => preview.selectVersion(event.target.value)}
            aria-label="Version"
            className="h-7 max-w-32 shrink-0 rounded-md border bg-background px-1.5 text-xs text-muted-foreground"
          >
            {picker.map((version) => (
              <option key={version.id} value={version.id}>
                {versionLabel(version)}
              </option>
            ))}
          </select>
        )}
        {artifactHasSourceView(viewer) && (
          <div
            role="radiogroup"
            aria-label="View"
            className="flex shrink-0 rounded-md bg-muted p-0.5"
          >
            {(["preview", "source"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                aria-label={m === "preview" ? "Preview" : "Source"}
                title={m === "preview" ? "Preview" : "Source"}
                onClick={() => changeMode(m)}
                className={cn(
                  "flex h-6 min-w-7 items-center justify-center gap-1 rounded px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  mode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "preview" ? (
                  <Eye className="size-3.5" aria-hidden />
                ) : (
                  <Code className="size-3.5" aria-hidden />
                )}
              </button>
            ))}
          </div>
        )}
        <SharePopover
          shareUrl={artifact.shareUrl}
          title={title}
          isPage={isPage}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="More">
              <Ellipsis className="size-4" aria-hidden />
              <span className="sr-only">More</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {downloadUrl && (
              <DropdownMenuItem asChild>
                <a href={downloadUrl} download={artifact.name}>
                  <Download aria-hidden /> Download
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild disabled={!openUrl}>
              {/* Safe for a page precisely because the sandbox rides on the RESPONSE: a top-level
                  load of the preview URL applies none of the iframe's flags, and all of the
                  header CSP's. */}
              <a
                href={openUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink aria-hidden /> Open in new tab
              </a>
            </DropdownMenuItem>
            {artifact.shareUrl && (
              <DropdownMenuItem
                onSelect={(event) => {
                  // Stay open long enough to say it worked.
                  event.preventDefault();
                  void copy(
                    absoluteShareUrl(
                      artifact.shareUrl as string,
                      window.location.origin,
                    ),
                  );
                }}
              >
                {copied ? <Check aria-hidden /> : <Link2 aria-hidden />}
                {copied ? "Copied" : "Copy link"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {docked && onToggleMaximised && (
          <Button
            variant="ghost"
            size="icon-sm"
            title={maximised ? "Restore" : "Maximise"}
            aria-pressed={maximised}
            onClick={onToggleMaximised}
          >
            {maximised ? (
              <Minimize2 className="size-4" aria-hidden />
            ) : (
              <Maximize2 className="size-4" aria-hidden />
            )}
            <span className="sr-only">
              {maximised ? "Restore" : "Maximise"}
            </span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={preview.close}
          title="Close preview"
        >
          <X className="size-4" aria-hidden />
          <span className="sr-only">Close preview</span>
        </Button>
      </header>

      <div
        ref={scrollRef}
        className={cn(
          "relative min-h-0 flex-1",
          pageView ? "overflow-hidden" : "overflow-auto overscroll-contain",
        )}
      >
        {browser && (
          <div className={cn("h-full", !pageView && "hidden")}>{browser}</div>
        )}
        {!pageView && (
          <ArtifactFileView
            artifact={artifact}
            projectId={projectId}
            versionId={versionId}
            mode={mode}
          />
        )}
      </div>
    </div>
  );
}
