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
 * WHY THE VERSION LIST COMES FROM THE MINT (#292). A capability is scoped to `(artifact, version)`,
 * so switching versions is a re-mint, and the endpoint that mints is already the one place the full
 * authorization runs — so it is also where the list of versions belongs. It must NOT come from
 * loader data: the session page revalidates every two seconds while a turn runs, and a panel driven
 * by loader data would be torn down on each poll.
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

/** One selectable version of the open artifact, as the mint endpoint reports it. */
export interface ArtifactPreviewVersion {
  id: string;
  version: number;
  byteSize: number;
  /** ISO timestamp of the publish — the picker's "when". */
  createdAt: string;
}

export interface ArtifactPreview {
  /** The artifact the panel is showing, or null when it is closed. */
  artifact: ChatArtifact | null;
  /** Current preview URL, or null while the first capability is being minted. */
  src: string | null;
  error: string | null;
  /** Versions of the open artifact, newest first — empty until the first mint answers. */
  versions: ArtifactPreviewVersion[];
  /** The version on screen, or null while the first mint (which chooses "newest") is in flight. */
  selectedVersionId: string | null;
  open: (artifact: ChatArtifact) => void;
  selectVersion: (versionId: string) => void;
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
  // The version the USER picked, or null for "whatever is newest" — which is what an open starts
  // at. It is a dep of the mint effect, so selecting a version re-mints: a capability is scoped to
  // `(artifact, version)` and the one on screen cannot be re-aimed at another version.
  const [requested, setRequested] = useState<string | null>(null);
  const [state, setState] = useState<{
    src: string | null;
    error: string | null;
    /** Which artifact the version list below belongs to — another one's must never be offered. */
    artifactId: string | null;
    versions: ArtifactPreviewVersion[];
    selectedVersionId: string | null;
  }>({
    src: null,
    error: null,
    artifactId: null,
    versions: [],
    selectedVersionId: null,
  });

  const open = useCallback((next: ChatArtifact) => {
    setArtifact(next);
    setRequested(null);
    setAttempt((n) => n + 1);
  }, []);
  const selectVersion = useCallback(
    (versionId: string) => setRequested(versionId),
    [],
  );
  const close = useCallback(() => setArtifact(null), []);
  useEffect(() => setArtifact(null), [sessionId]);

  useEffect(() => {
    if (!artifact) {
      setState({
        src: null,
        error: null,
        artifactId: null,
        versions: [],
        selectedVersionId: null,
      });
      return;
    }
    // `cancelled` rather than an AbortController alone: the guard also covers the state writes of a
    // mint that resolves after the panel closed or moved to another artifact.
    let cancelled = false;
    let timer = 0;
    // The version this effect run is pinned to. A LOCAL rather than state, deliberately: the first
    // mint resolves "newest" to a concrete id, and every re-mint must ask for that same one — a
    // re-mint that re-resolved "newest" would swap the user's page under them ten minutes after
    // they opened it. Writing it to state instead would re-run this effect and re-mint at once.
    let pinned = requested;
    setState((prev) => ({
      src: null,
      error: null,
      artifactId: artifact.id,
      // Keep the list across a version SWITCH — it is the picker the user is switching with — but
      // never across a change of artifact, which would offer another card's versions.
      versions: prev.artifactId === artifact.id ? prev.versions : [],
      selectedVersionId: requested,
    }));

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
      setState((prev) => ({ ...prev, src: null, error: PREVIEW_FAILED }));
    };

    const mint = async (retryable: boolean) => {
      const form = new FormData();
      form.set("artifactId", artifact.id);
      if (pinned) form.set("versionId", pinned);
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
              versionId?: unknown;
              versions?: unknown;
            } | null)
          : null;
        if (cancelled) return;
        if (!body?.ok || typeof body.url !== "string") {
          failed(retryable);
          return;
        }
        if (typeof body.versionId === "string") pinned = body.versionId;
        setState((prev) => ({
          src: body.url as string,
          error: null,
          artifactId: artifact.id,
          versions: Array.isArray(body.versions)
            ? (body.versions as ArtifactPreviewVersion[])
            : prev.versions,
          selectedVersionId: pinned,
        }));
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
  }, [artifact, attempt, projectId, requested]);

  return {
    artifact,
    src: state.src,
    error: state.error,
    versions: state.artifactId === artifact?.id ? state.versions : [],
    selectedVersionId: state.selectedVersionId,
    open,
    selectVersion,
    close,
  };
}
