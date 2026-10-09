import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { cn } from "~/lib/utils";
import type { ArtifactBadge } from "./artifact-type";
import { DownloadButton, FileCard, OpenInTabButton } from "./file-card";
import { Failure, Loading } from "./states";

/** A checkerboard behind an image, so transparency reads as transparency in both themes. */
const CHECKERBOARD =
  "bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]";

/**
 * An image (or SVG) fitted to the panel's width; a click shows it at its own size, zoomed around
 * the point clicked rather than the top-left corner.
 */
export function ImageView({ src, name }: { src: string; name: string }) {
  const [actual, setActual] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const img = useRef<HTMLImageElement>(null);
  // Where the click landed, as a fraction of the fitted image and a point on screen.
  const focus = useRef<{ fx: number; fy: number; x: number; y: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const f = focus.current;
    focus.current = null;
    const el = img.current;
    const scroller = el && actual && f ? scrollParent(el) : null;
    if (!el || !f || !scroller) return;
    const r = el.getBoundingClientRect();
    scroller.scrollLeft += r.left + f.fx * r.width - f.x;
    scroller.scrollTop += r.top + f.fy * r.height - f.y;
  }, [actual]);

  return (
    <div className="flex min-h-full flex-col">
      {state === "loading" && <Loading label="Loading image…" />}
      {state === "error" && <Failure message="The image couldn't be loaded." />}
      <button
        type="button"
        onClick={(e) => {
          const r = img.current?.getBoundingClientRect();
          // A keyboard press (detail 0) has no point; it zooms from the corner.
          if (!actual && r && e.detail > 0 && r.width > 0 && r.height > 0) {
            focus.current = {
              fx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
              fy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
              x: e.clientX,
              y: e.clientY,
            };
          }
          setActual((v) => !v);
        }}
        aria-pressed={actual}
        aria-label={actual ? "Fit to width" : "Show at actual size"}
        className={cn(
          "m-auto block p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          actual ? "cursor-zoom-out" : "cursor-zoom-in",
          state !== "ready" && "sr-only",
        )}
      >
        <img
          ref={img}
          src={src}
          alt={name}
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
          className={cn(
            "rounded-md",
            CHECKERBOARD,
            actual ? "max-w-none" : "h-auto max-w-full",
          )}
        />
      </button>
    </div>
  );
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (/auto|scroll/.test(overflowX + overflowY)) return p;
  }
  return null;
}

/** The browser's own player. A format it can't decode gets a Download instead of a dead control. */
export function MediaView({
  src,
  kind,
  name,
  downloadUrl,
}: {
  src: string;
  kind: "audio" | "video";
  name: string;
  downloadUrl: string;
}) {
  const [error, setError] = useState(false);
  if (error) {
    return (
      <Failure
        message={`This ${kind} can't be played in the browser. Download it instead.`}
      >
        <DownloadButton href={downloadUrl} name={name} />
      </Failure>
    );
  }
  if (kind === "audio") {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <audio
          controls
          preload="metadata"
          src={src}
          onError={() => setError(true)}
          className="w-full max-w-xl"
        />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center bg-black">
      <video
        controls
        playsInline
        preload="metadata"
        src={src}
        onError={() => setError(true)}
        className="max-h-full max-w-full"
      />
    </div>
  );
}

const INLINE_PDF_QUERY = "(pointer: fine) and (min-width: 768px)";

function subscribeInlinePdf(onChange: () => void) {
  const mql = window.matchMedia(INLINE_PDF_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Whether this device shows a PDF well in a frame: a desktop-width screen with a mouse. */
function useInlinePdf(): boolean {
  return useSyncExternalStore(
    subscribeInlinePdf,
    () => window.matchMedia(INLINE_PDF_QUERY).matches,
    () => true,
  );
}

/**
 * Inline on a desktop. A touch device gets a card instead: mobile browsers render a PDF in a frame
 * as its first page, unscrollable, or not at all — while opening it hands it to the system viewer,
 * which is good at exactly this.
 */
export function PdfView({
  src,
  downloadUrl,
  name,
  title,
  byteSize,
  contentType,
  badge,
}: {
  src: string;
  downloadUrl: string;
  name: string;
  title: string;
  byteSize: number;
  contentType: string;
  badge: ArtifactBadge;
}) {
  const inline = useInlinePdf();
  if (inline) {
    // NO sandbox attribute, deliberately: Chrome shows a blank error page for a PDF in a sandboxed
    // frame (attribute or CSP), even with scripts and popups allowed. What the frame renders is the
    // raw route's call, not this component's: `artifactServePolicy` sends a stored PDF as
    // `application/pdf` + `nosniff` (the browser's own viewer, never a page of this origin) and is
    // the only type it lets the app frame — a file merely NAMED `.pdf` with some other stored type
    // goes out sandboxed or as an attachment, so it cannot become a live document here either.
    //
    // WHY THE APP ORIGIN, not the preview origin pages use: `application/pdf` + `nosniff` is never
    // parsed as HTML, and the browser's PDF viewer gives the document no DOM or cookie access to
    // the app that embeds it, so the cookie-authenticated route is safe to frame. The preview origin
    // would buy nothing a PDF needs — Chrome's viewer blanks under any sandbox anyway — and it
    // carries no cookies, so it would need a token route of its own. Omniplex makes the same call.
    // react-doctor-disable-next-line react-doctor/iframe-missing-sandbox -- any sandbox blanks Chrome's PDF viewer; the src is a same-origin PDF served with nosniff
    return <iframe src={src} title={title} className="size-full border-0 bg-white" />;
  }
  return (
    <FileCard badge={badge} name={name} contentType={contentType} byteSize={byteSize}>
      <OpenInTabButton href={src} label="Open PDF" variant="default" />
      <DownloadButton href={downloadUrl} name={name} />
    </FileCard>
  );
}
