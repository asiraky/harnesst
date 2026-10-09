/**
 * The panel's Share button. Every artifact already HAS a public link (#370: minted at publish,
 * always the newest version, revoked or rotated only from the back-of-house Artifacts page), so
 * this is discoverability, not a sharing workflow: it says what the link does, shows it, and copies
 * or hands it to the system share sheet.
 *
 * Copy and Share use the link already on screen, so they run inside the tap — Safari refuses both
 * the clipboard and the share sheet once anything asynchronous has come between the tap and the
 * call. That is also why they are two separate buttons.
 */
import { Check, Copy, Share2 } from "lucide-react";
import { useState } from "react";

import { useCopy } from "~/components/chat/clipboard";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";

/** The share link as an absolute URL — loader data carries it app-relative (`/a/<token>`). */
export function absoluteShareUrl(shareUrl: string): string {
  if (typeof window === "undefined") return shareUrl;
  try {
    return new URL(shareUrl, window.location.origin).href;
  } catch {
    return shareUrl;
  }
}

function canShareNatively(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.share === "function"
  );
}

export function SharePopover({
  shareUrl,
  title,
  isPage,
}: {
  /** App-relative or absolute public link; null when an admin revoked it. */
  shareUrl: string | null;
  /** Passed to the system share sheet. */
  title: string;
  /** "page" or "file" in the copy. */
  isPage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { copy, copied } = useCopy();
  const url = shareUrl ? absoluteShareUrl(shareUrl) : null;
  const native = canShareNatively();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Share">
          <Share2 className="size-4" aria-hidden />
          <span className="sr-only">Share</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-[min(20rem,calc(100vw-1rem))] flex-col gap-3 p-3"
      >
        {url ? (
          <>
            <p className="text-xs leading-snug text-muted-foreground">
              Anyone with this link can view this {isPage ? "page" : "file"}. It
              always shows the newest version.
            </p>
            <input
              readOnly
              value={url}
              aria-label="Share link"
              onFocus={(event) => event.currentTarget.select()}
              // 16px on phones: anything smaller makes iOS zoom the page on focus.
              className="w-full rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-base md:text-[11px]"
            />
            <div className="flex gap-2">
              <Button
                className="flex-1"
                variant={native ? "outline" : "default"}
                size="sm"
                onClick={() => void copy(url)}
              >
                {copied ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                {copied ? "Copied" : "Copy link"}
              </Button>
              {native && (
                <Button
                  className="flex-1"
                  size="sm"
                  onClick={() => {
                    navigator.share({ title, url }).catch(() => {
                      // Dismissing the share sheet rejects too; there is nothing to report.
                    });
                  }}
                >
                  <Share2 className="size-3.5" aria-hidden />
                  Share…
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs leading-snug text-muted-foreground">
            Sharing is turned off for this artifact. An admin can turn it back
            on from the Artifacts page.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
