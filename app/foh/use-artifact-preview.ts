/**
 * The client half of the artifact panel: which artifact is open, which of its versions is on
 * screen, and — for a page bundle (#291) — a preview capability the panel's frame can load, kept
 * fresh while the panel stays open.
 *
 * WHY THERE IS NO PAGE URL IN TRANSCRIPT DATA. A bundle's bytes are reachable only through a signed
 * capability minted for one artifact and one viewer, so the loader cannot hand the card a link: the
 * link has to be asked for, per open, by an authenticated POST. That is also the point where the
 * full cookie-side authorization runs (repo scope, then per-conversation visibility) — see
 * `routes/api.foh.artifact-preview.ts`. Every other kind is served by the cookie-authenticated raw
 * and source routes, so for those the same POST only answers the version list, without a token.
 *
 * WHY THE VERSION LIST COMES FROM THE MINT (#292). A capability is scoped to `(artifact, version)`,
 * so switching versions is a re-mint, and the endpoint that mints is already the one place the full
 * authorization runs — so it is also where the list of versions belongs.
 *
 * WHY LOADER DATA ONLY NUDGES IT. The session page revalidates every two seconds while a turn runs;
 * a panel DRIVEN by loader data would be torn down on each poll. So the state here is local, and
 * the route passes the latest transcript copies in only so `artifactFollowDecision` can move the
 * panel to a newly published version (or refresh its header) — never to rebuild it.
 *
 * WHY A RE-MINT DOES NOT RELOAD THE PAGE. The capability lives an hour (it travels in a URL — into
 * history, into "open in new tab" — so it is not forever), and a page that pulls an asset late, a
 * lazy image or a font on first hover, would 404 once it lapsed. So the hook re-mints ahead of
 * expiry, and the new URL is only HELD: the mini browser captured its frame `src` when it mounted
 * and uses the fresh token for its next Reload or "open in new tab". The frame itself is replaced
 * only when the user switches version or presses Reload — a token refresh never costs them their
 * scroll position or the state of the page. A re-mint that fails keeps the page on screen and tries
 * once more; the token it is replacing has not run out yet.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatArtifact } from "~/chat/types";
import { artifactFollowDecision, findArtifact } from "~/foh/artifact-follow";

/**
 * How long before expiry the next capability is minted. Five minutes rather than a few seconds so
 * the URL "Open in new tab" hands out is never moments from dying.
 */
const REMINT_MARGIN_MS = 5 * 60_000;
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

/** A page's current preview capability: the entry URL under a token, and when it lapses. */
export interface ArtifactPreviewCapability {
  url: string;
  /** Epoch ms, or null when the server sent none usable. */
  expiresAt: number | null;
  /** The version the token is scoped to. */
  versionId: string;
}

export interface ArtifactPreview {
  /** The artifact the panel is showing, or null when it is closed. */
  artifact: ChatArtifact | null;
  /** Versions of the open artifact, newest first — empty until the endpoint answers. */
  versions: ArtifactPreviewVersion[];
  /**
   * The version on screen. For a page it is the version the capability is scoped to (the user's
   * pick while a switch is minting); for every other kind the pick or the artifact's latest.
   */
  selectedVersionId: string | null;
  /** Whether the user deliberately picked a version (vs. following the newest). */
  versionPinned: boolean;
  /**
   * Page bundles only: the freshest capability. Changes on every re-mint; consumers must not reload
   * the frame for it (see the module comment).
   */
  preview: ArtifactPreviewCapability | null;
  /** Page bundles only: the preview could not be opened at all. */
  error: string | null;
  open: (artifact: ChatArtifact) => void;
  selectVersion: (versionId: string) => void;
  close: () => void;
  /** Mint a capability NOW for the version on screen (Reload with a near-expired token). */
  refreshPreview: () => Promise<ArtifactPreviewCapability>;
}

interface MintResult {
  url: string | null;
  expiresAt: number | null;
  versionId: string | null;
  versions: ArtifactPreviewVersion[] | null;
}

async function requestArtifactPreview(
  projectId: string,
  artifactId: string,
  versionId: string | null,
): Promise<MintResult | null> {
  const form = new FormData();
  form.set("artifactId", artifactId);
  if (versionId) form.set("versionId", versionId);
  try {
    const res = await fetch(`/api/foh/${projectId}/artifact-preview`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      ok?: unknown;
      url?: unknown;
      expiresAt?: unknown;
      versionId?: unknown;
      versions?: unknown;
    } | null;
    if (!body || body.ok !== true) return null;
    return {
      url: typeof body.url === "string" ? body.url : null,
      expiresAt:
        typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
          ? body.expiresAt
          : null,
      versionId: typeof body.versionId === "string" ? body.versionId : null,
      versions: Array.isArray(body.versions)
        ? (body.versions as ArtifactPreviewVersion[])
        : null,
    };
  } catch {
    return null;
  }
}

interface PanelState {
  /** Which artifact everything below belongs to — another one's must never be offered. */
  artifactId: string | null;
  versions: ArtifactPreviewVersion[];
  /** Page bundles: the version the capability is (or is about to be) scoped to. */
  pinned: string | null;
  preview: ArtifactPreviewCapability | null;
  error: string | null;
}

const CLOSED: PanelState = {
  artifactId: null,
  versions: [],
  pinned: null,
  preview: null,
  error: null,
};

export function useArtifactPreview(input: {
  projectId: string;
  /** Changing this closes the panel — a card from the previous conversation must not linger. */
  resetKey?: string;
  /**
   * The newest copies of the artifacts on screen (the transcript's cards, the artifacts table), so
   * a republish moves the open panel to the new version. Optional: without it the panel stays put.
   */
  artifacts?: readonly ChatArtifact[];
}): ArtifactPreview {
  const { projectId, resetKey, artifacts } = input;
  const [artifact, setArtifact] = useState<ChatArtifact | null>(null);
  // Bumped on every open so clicking the same card after a failure retries, even when the loader
  // handed back the very same artifact object and `setArtifact` would therefore be a no-op.
  const [openSeq, setOpenSeq] = useState(0);
  // Bumped when the version list is stale (a republish), which re-asks the endpoint.
  const [listSeq, setListSeq] = useState(0);
  // The version the USER picked, or null for "whatever is newest" — which is what an open starts
  // at. It is a dep of the mint effect, so selecting a version re-mints: a capability is scoped to
  // `(artifact, version)` and the one on screen cannot be re-aimed at another version.
  const [requested, setRequested] = useState<string | null>(null);
  const [state, setState] = useState<PanelState>(CLOSED);

  const open = useCallback((next: ChatArtifact) => {
    setArtifact(next);
    setRequested(null);
    setOpenSeq((n) => n + 1);
  }, []);
  const selectVersion = useCallback(
    (versionId: string) => setRequested(versionId),
    [],
  );
  const close = useCallback(() => setArtifact(null), []);
  useEffect(() => setArtifact(null), [resetKey]);

  // Follow republishes (see `artifactFollowDecision`).
  useEffect(() => {
    if (!artifact) return;
    const fresh = findArtifact(artifacts, artifact.id);
    const decision = artifactFollowDecision({
      open: artifact,
      fresh,
      pickedVersionId: requested,
    });
    if (decision === "ignore" || !fresh) return;
    setArtifact(fresh);
    if (decision === "follow") setRequested(null);
    if (fresh.latestVersionId !== artifact.latestVersionId) {
      setListSeq((n) => n + 1);
    }
  }, [artifacts, artifact, requested]);

  const artifactId = artifact?.id ?? null;
  const isPage = artifact?.kind === "html";

  useEffect(() => {
    if (!artifactId) {
      setState(CLOSED);
      return;
    }
    // `cancelled` rather than an AbortController alone: the guard also covers the state writes of a
    // mint that resolves after the panel closed or moved to another artifact.
    let cancelled = false;
    let timer = 0;
    // The version this effect run is pinned to. A LOCAL rather than state, deliberately: the first
    // mint resolves "newest" to a concrete id, and every re-mint must ask for that same one — a
    // re-mint that re-resolved "newest" would swap the user's page under them with no interaction.
    // (Moving to a new version is the follow effect's job, which re-runs this one.)
    let pinned = requested;
    setState((prev) =>
      prev.artifactId === artifactId
        ? // Same artifact: keep the list (it is the picker the user is switching with) and the
          // capability (a follow keeps the old page up until the new one is minted).
          { ...prev, pinned: requested ?? prev.pinned, error: null }
        : { ...CLOSED, artifactId, pinned: requested },
    );

    /**
     * A failed mint means different things at the two call sites. The FIRST one has nothing on
     * screen, so its failure is the error state. A re-mint failure happens while a still-valid token
     * is rendering a working page — tearing that down for a network blip would lose the user their
     * page before it was actually due to lapse — so it retries once inside the margin and only
     * surfaces the error when the capability is genuinely gone. For any other kind the request only
     * fetches the version list, so a failure leaves the panel without a picker, nothing more.
     */
    const failed = (retryable: boolean) => {
      if (cancelled || !isPage) return;
      if (retryable) {
        timer = window.setTimeout(() => void run(false), REMINT_RETRY_DELAY_MS);
        return;
      }
      setState((prev) => ({ ...prev, preview: null, error: PREVIEW_FAILED }));
    };

    const run = async (retryable: boolean) => {
      const result = await requestArtifactPreview(
        projectId,
        artifactId,
        pinned,
      );
      if (cancelled) return;
      if (!result || (isPage && (!result.url || !result.versionId))) {
        failed(retryable);
        return;
      }
      if (result.versionId) pinned = result.versionId;
      setState((prev) => ({
        artifactId,
        versions: result.versions ?? prev.versions,
        pinned,
        error: null,
        preview:
          isPage && result.url && pinned
            ? {
                url: result.url,
                expiresAt: result.expiresAt,
                versionId: pinned,
              }
            : null,
      }));
      if (isPage) {
        timer = window.setTimeout(
          () => void run(true),
          nextPreviewRemintDelayMs(result.expiresAt, Date.now()),
        );
      }
    };
    void run(false);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [artifactId, isPage, openSeq, listSeq, projectId, requested]);

  // `refreshPreview` reads the latest of these without being re-created on every render.
  const latest = useRef({ projectId, artifactId, pinned: state.pinned });
  useEffect(() => {
    latest.current = { projectId, artifactId, pinned: state.pinned };
  });

  const refreshPreview = useCallback(async () => {
    const { projectId: project, artifactId: id, pinned } = latest.current;
    if (!id) throw new Error("No artifact is open.");
    const result = await requestArtifactPreview(project, id, pinned);
    if (!result?.url || !result.versionId) {
      throw new Error("harnesst couldn't refresh this preview.");
    }
    const capability: ArtifactPreviewCapability = {
      url: result.url,
      expiresAt: result.expiresAt,
      versionId: result.versionId,
    };
    setState((prev) =>
      prev.artifactId === id && prev.pinned === capability.versionId
        ? { ...prev, preview: capability, error: null }
        : prev,
    );
    return capability;
  }, []);

  const current = state.artifactId !== null && state.artifactId === artifactId;
  return {
    artifact,
    versions: current ? state.versions : [],
    selectedVersionId: isPage
      ? current
        ? state.pinned
        : requested
      : (requested ?? artifact?.latestVersionId ?? null),
    versionPinned: requested !== null,
    preview: current ? state.preview : null,
    error: current ? state.error : null,
    open,
    selectVersion,
    close,
    refreshPreview,
  };
}
