/**
 * The preview pane a published artifact opens in (issue #291) — generic on purpose: it takes a
 * title and a URL, and knows nothing about artifacts, bundles or tokens. Sketches and screenshot
 * galleries land here next.
 *
 * THE IFRAME IS THE WHOLE SECURITY SURFACE OF THIS FILE, so the three attributes below are not
 * styling choices:
 *
 * - `sandbox="allow-scripts"` and nothing else. Every additional token has a written reason it is
 *   absent in `artifact-preview.server.ts`; the short version is that `allow-same-origin` would let
 *   the frame reach back into this document, `allow-popups`/`allow-top-navigation` would let it
 *   drive the user's tab, `allow-downloads` would let it hand out an executable from harnesst's own
 *   domain, and `allow-modals` would let it draw native browser chrome that reads as harnesst's UI.
 * - `src`, never `srcdoc` and never a `blob:` URL. A local scheme inherits THIS document's CSP and
 *   cannot carry its own, so an artifact would silently acquire whatever network reach harnesst's
 *   pages have. Loading over HTTP is what lets the response sandbox itself with a real header — the
 *   part that also survives a top-level navigation, which iframe sandboxing cannot.
 * - `allow=` denying the powerful features, because the attribute's default is `'src'` (i.e. allow),
 *   not deny.
 *
 * There is deliberately no postMessage listener here and no proxy of any kind: the panel and the
 * previewed document exchange nothing.
 */
import { ExternalLink, X } from "lucide-react";

import { Button } from "~/components/ui/button";
import { ARTIFACT_PREVIEW_IFRAME_ALLOW } from "~/foh/artifact-media";
import { cn } from "~/lib/utils";

export interface PreviewPanelProps {
  /** Header label — the artifact's caption or file name. */
  title: string;
  /** Quiet second line, e.g. the file name when the title is a caption. */
  subtitle?: string | null;
  /**
   * URL the iframe loads. Null means "not ready yet" (the capability is still being minted), which
   * renders as a placeholder rather than an iframe pointed at nothing.
   */
  src: string | null;
  /** Set when the preview could not be opened at all; replaces the frame. */
  error?: string | null;
  onClose: () => void;
  className?: string;
}

export function PreviewPanel({
  title,
  subtitle,
  src,
  error,
  onClose,
  className,
}: PreviewPanelProps) {
  return (
    // A fourth pane at xl (the shell already needs 544px of chrome before the conversation gets
    // anything — see foh.tsx), and a full-screen overlay below that, which is the same sliding
    // window over the pane stack the rest of the shell uses.
    <aside
      className={cn(
        "fixed inset-0 z-40 flex flex-col bg-background xl:static xl:z-auto xl:w-[460px] xl:shrink-0 xl:border-l 2xl:w-[560px]",
        className,
      )}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          {subtitle && (
            <p className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {src && (
          // Safe precisely because the sandbox rides on the RESPONSE: a top-level load of this URL
          // applies none of the iframe's flags, and all of the header CSP's.
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            title="Open in new tab"
          >
            <a href={src} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" aria-hidden />
              <span className="sr-only">Open in new tab</span>
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title="Close preview"
        >
          <X className="size-4" aria-hidden />
          <span className="sr-only">Close preview</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        {error ? (
          <p className="p-4 text-sm text-muted-foreground">{error}</p>
        ) : src ? (
          <iframe
            // Keyed on the URL so a re-minted capability replaces the frame outright rather than
            // leaving a half-navigated document behind.
            key={src}
            src={src}
            title={title}
            sandbox="allow-scripts"
            allow={ARTIFACT_PREVIEW_IFRAME_ALLOW}
            referrerPolicy="no-referrer"
            // White rather than transparent: a page written for a light background must not inherit
            // harnesst's dark theme through the frame and render its own text invisible.
            className="size-full border-0 bg-white"
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Opening…</p>
        )}
      </div>
    </aside>
  );
}
