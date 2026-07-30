/**
 * The client half of the sandboxed artifact preview (issue #291): turn "the user clicked a page
 * card" into a short-lived URL the panel's iframe can load, and keep that URL working while the
 * panel stays open.
 *
 * WHY THERE IS NO URL IN TRANSCRIPT DATA. A bundle's bytes are reachable only through a signed
 * capability minted for one artifact and one viewer, so the loader cannot hand the card a link: the
 * link has to be asked for, per open, by an authenticated POST. That is also the point where the
 * full cookie-side authorization runs (repo scope, then per-conversation visibility) — see
 * `routes/api.foh.artifact-preview.ts`.
 *
 * WHY IT RE-MINTS. The capability lives ~10 minutes because it travels in a URL (into history, into
 * "open in new tab"), and a page that pulls an asset late — a lazy image, a font on first hover —
 * would 404 the moment it lapsed. So the hook re-mints ahead of expiry, which reloads the frame:
 * the honest trade, since a stale token shows the user a page that half-renders for no visible
 * reason, while a reload of a static page costs a scroll position. A re-mint that fails keeps the
 * page that is already on screen and tries once more — the token it is replacing has not run out yet.
 */
import { useCallback, useEffect, useState } from "react";

import type { ChatArtifact } from "~/chat/types";

/** How long before expiry the next capability is minted, so a late subresource still loads. */
const REMINT_MARGIN_MS = 60_000;
/** Floor on the re-mint timer, so a short-dated or clock-skewed token cannot become a mint loop. */
const MIN_REMINT_DELAY_MS = 30_000;
/**
 * How long a failed RE-mint waits before its one retry. Comfortably inside the margin above, so both
 * attempts happen while the token on screen is still valid.
 */
const REMINT_RETRY_DELAY_MS = 10_000;
/** Used when the server's `expiresAt` is missing or unparseable — mint again rather than trust it. */
const FALLBACK_REMINT_DELAY_MS = 60_000;

const PREVIEW_FAILED =
  "harnesst couldn't open this preview. Close the panel and try again.";

/**
 * When to mint the next capability. Pure, and the only real arithmetic in this module. Two ways this
 * goes wrong if it is written naively: `setTimeout(NaN)` fires immediately, and an already-past
 * expiry (a clock-skewed server, a token that sat in a backgrounded tab) computes a negative delay
 * that does the same — either way the panel would mint in a tight loop for as long as it stayed open.
 * So a NUMBER is required (a coerced `null` is 0, which is finite and would look like 1970), and the
 * result is floored.
 */
export function nextPreviewRemintDelayMs(
  expiresAt: unknown,
  now: number,
): number {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return FALLBACK_REMINT_DELAY_MS;
  }
  return Math.max(MIN_REMINT_DELAY_MS, expiresAt - now - REMINT_MARGIN_MS);
}

export interface ArtifactPreview {
  /** The artifact the panel is showing, or null when it is closed. */
  artifact: ChatArtifact | null;
  /** Current preview URL, or null while the first capability is being minted. */
  src: string | null;
  error: string | null;
  open: (artifact: ChatArtifact) => void;
  close: () => void;
}

export function useArtifactPreview(input: {
  projectId: string;
  /** Switching conversations closes the panel — a card from the previous one must not linger. */
  sessionId: string;
}): ArtifactPreview {
  const { projectId, sessionId } = input;
  const [artifact, setArtifact] = useState<ChatArtifact | null>(null);
  // Bumped on every open so clicking the same card after a failure retries, even when the loader
  // handed back the very same artifact object and `setArtifact` would therefore be a no-op.
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    src: string | null;
    error: string | null;
  }>({ src: null, error: null });

  const open = useCallback((next: ChatArtifact) => {
    setArtifact(next);
    setAttempt((n) => n + 1);
  }, []);
  const close = useCallback(() => setArtifact(null), []);
  useEffect(() => setArtifact(null), [sessionId]);

  useEffect(() => {
    if (!artifact) {
      setState({ src: null, error: null });
      return;
    }
    // `cancelled` rather than an AbortController alone: the guard also covers the state writes of a
    // mint that resolves after the panel closed or moved to another artifact.
    let cancelled = false;
    let timer = 0;
    setState({ src: null, error: null });

    /**
     * A failed mint means different things at the two call sites. The FIRST one has nothing on
     * screen, so its failure is the error state. A re-mint failure happens while a still-valid token
     * is rendering a working page — tearing that down for a network blip would lose the user their
     * page a minute before it was actually due to lapse — so it retries once inside the margin and
     * only surfaces the error when the capability is genuinely gone.
     */
    const failed = (retryable: boolean) => {
      if (cancelled) return;
      if (retryable) {
        timer = window.setTimeout(() => void mint(false), REMINT_RETRY_DELAY_MS);
        return;
      }
      setState({ src: null, error: PREVIEW_FAILED });
    };

    const mint = async (retryable: boolean) => {
      const form = new FormData();
      form.set("artifactId", artifact.id);
      try {
        const res = await fetch(`/api/foh/${projectId}/artifact-preview`, {
          method: "POST",
          body: form,
        });
        const body = res.ok
          ? ((await res.json().catch(() => null)) as {
              ok?: boolean;
              url?: unknown;
              expiresAt?: unknown;
            } | null)
          : null;
        if (cancelled) return;
        if (!body?.ok || typeof body.url !== "string") {
          failed(retryable);
          return;
        }
        setState({ src: body.url, error: null });
        timer = window.setTimeout(
          () => void mint(true),
          nextPreviewRemintDelayMs(body.expiresAt, Date.now()),
        );
      } catch {
        failed(retryable);
      }
    };
    void mint(false);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [artifact, attempt, projectId]);

  return {
    artifact,
    src: state.src,
    error: state.error,
    open,
    close,
  };
}
