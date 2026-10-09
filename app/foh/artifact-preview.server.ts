/**
 * What makes serving agent-authored HTML from harnesst's own origin safe (issue #291): a
 * path token, and a response that sandboxes itself into an OPAQUE ORIGIN.
 *
 * ── THE SANDBOX IS A PROPERTY OF THE RESOURCE, NOT THE EMBEDDING ──────────────────────────────
 * The HTML spec says it outright about `iframe[sandbox]`: "Sandboxing hostile content is of minimal
 * help if an attacker can convince the user to just visit the hostile content directly, rather than
 * in the iframe." Any top-level load — a new tab, a pasted link, a crawler — applies exactly zero
 * of the embedding's sandbox flags. So the sandbox travels on the RESPONSE, as the CSP `sandbox`
 * directive, which is header-only (`<meta>` cannot express it) and therefore survives a top-level
 * navigation. The iframe's own `sandbox` attribute is belt to this braces, not the mechanism.
 *
 * That is also why the bytes are never handed to a `srcdoc` or a `blob:` URL: a local scheme
 * inherits the embedding document's CSP and cannot carry its own, so an artifact would silently
 * acquire whatever reach harnesst's own pages have.
 *
 * ── WHAT THE SANDBOX IS NOW, AND WHY THAT IS THE WHOLE BOUNDARY ──────────────────────────────
 * `sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads` — and NEVER
 * `allow-same-origin`. Without that one token the document's origin is opaque: it reads no
 * harnesst cookie, no harnesst storage, and every request it makes to harnesst is cross-site with
 * an opaque `Origin`, so `SameSite` session cookies are not attached and no harnesst response
 * grants it CORS. The page can run, draw, submit a form, open a popup (which inherits the same
 * sandbox — no `allow-popups-to-escape-sandbox`), alert, and download what it generated. It cannot
 * act as the viewer. That isolation is the security boundary; it does not depend on what the page
 * may LOAD.
 *
 * Which is why the CONTENT restrictions this header used to carry are gone. #291 shipped
 * `default-src 'none'` with `connect-src 'none'`, `form-action 'none'` and `base-uri 'none'`: no
 * CDN, no fetch — even of the page's own sibling files — no forms. That bought one thing, making
 * exfiltration harder, and CSP never closed it anyway (WebRTC, DNS prefetch and navigation were
 * always open). Meanwhile it broke most of what agents actually produce: a chart from a CDN, a web
 * font, a dashboard that fetches `./data.json`. The compensating invariant is unchanged and is what
 * makes the trade sound — an artifact only ever contains data its viewer already has, the agent that
 * wrote it already had the network, and the opaque origin gives the page nothing of the VIEWER's to
 * send anywhere. `base-uri` falls with the rest: a `<base>` re-pointing the page's relative URLs only
 * redirects the agent's own document, which it could have written differently anyway.
 *
 * What stays load-bearing: `frame-ancestors <app-origin>` — only harnesst may embed a preview; this
 * is the directive that prevents the third-party-embed attack run against Claude Artifacts in Dec
 * 2025, where any site could frame a victim's authenticated artifact URL. `nosniff`, so a member
 * with the wrong type fails closed instead of being re-guessed as HTML. `Referrer-Policy:
 * no-referrer`, so a link out of the page does not carry the token to another site. `no-store`, so
 * no cache outlives the capability.
 *
 * `Access-Control-Allow-Origin: *` is new and follows from the opaque origin: the page's module
 * scripts, `fetch('./data.json')` and fonts are CROSS-ORIGIN requests (origin `null`) to the very
 * route that served it, and fail without it. `*` never carries credentials, and the only credential
 * here is the token in the path — whoever can name the URL could already open it.
 *
 * ── THE BRIDGE ────────────────────────────────────────────────────────────────────────────────
 * #291 shipped with "deliberately NO postMessage bridge and NO fetch proxy", because every such
 * convenience in the wild turned into an artifact-controlled authenticated capability. There is now
 * a bridge (`artifact-bridge.ts`), and it is shaped by that lesson: it reports location and console
 * OUT as untrusted display data and accepts only back/forward IN, which the page could do to itself.
 * It relays no request, no storage and no token. There is still no fetch proxy.
 *
 * ── WHY A PATH TOKEN AND NOT A COOKIE ─────────────────────────────────────────────────────────
 * A sandboxed frame is a null-origin, storage-less context, and once this preview moves to a
 * separate origin (`PREVIEW_ORIGIN`, #296) `SameSite=Lax` cookies stop being sent to it
 * altogether while `SameSite=None` fights Safari ITP. That is why the origin split needed no
 * change to authentication at all. A signed token in the PATH authenticates the
 * document and every subresource it pulls, identically same-origin or cross-origin, and it expires
 * on its own. Keyed by the same `HARNESST_SECRETS_KEY` as every other signed-state flow — never a
 * new env var — and pure over an injected key so mint/verify unit-test with no env.
 */
import {
  previewFrameAncestors,
  previewOrigin,
} from "~/lib/preview-origin.server";
import { signState, verifyState } from "~/lib/signed-state.server";
import { injectArtifactBridge } from "~/foh/artifact-bridge.server";
import { artifactCharsetType, artifactPreviewPath } from "~/foh/artifact-media";
import { artifactMediaEssence } from "~/foh/artifact-viewer";
import { rewriteRootUrlsCss, rewriteRootUrlsHtml } from "~/foh/artifact-urls";
import { decodeKey } from "~/seams/oss/secretbox";

const PURPOSE = "foh-artifact-preview";

/**
 * How long a minted preview URL works. An hour, not a day: the token is a bearer capability that
 * travels in a URL (and therefore into history and into any "open in new tab"), so its value has to
 * decay — but a page is now a live app that loads data, plays media and gets opened in a tab to be
 * read, and ten minutes was cutting those off mid-use (a subresource requested after expiry 404s
 * even though the document already loaded). The panel still re-mints transparently.
 */
export const ARTIFACT_PREVIEW_TTL_MS = 60 * 60 * 1000;

interface ArtifactPreviewPayload {
  purpose: typeof PURPOSE;
  artifactId: string;
  /**
   * WHICH VERSION this capability opens (#292). The scope is `(artifact, version)`, not the
   * artifact: the panel mints per selection, so a token for the version the user chose must not
   * silently follow the artifact forward when the agent republishes — and an old-version link must
   * not outlive the intent it was minted with. It rides in the token rather than in the path
   * because the path is what every relative `href`/`src` inside the page resolves against, and a
   * segment more would have to be re-derived correctly by an agent-authored document.
   *
   * Optional so a token minted before this shipped still opens the artifact (as its newest
   * version) for the time it has left, rather than turning into a dead panel on deploy.
   */
  versionId?: string;
  projectId: string;
  userId: string;
  /**
   * Whether the minting viewer was back of house — i.e. may see conversations they did not start.
   * Carried rather than re-derived because the preview route has no cookie and so cannot read
   * org/team membership. The per-CONVERSATION visibility check is still re-run per request against
   * `userId`, so a token outliving the viewer's access to the conversation stops working inside the
   * TTL — but this one bit is a FROZEN verdict, and that is a reviewed, accepted residual:
   *
   * a viewer demoted out of back of house keeps, for the remainder of the TTL (≤ 60 minutes), the
   * cross-conversation reach the token was minted with. The blast radius is one artifact VERSION
   * they had already opened, because the artifact id is inside the signature and the token is not
   * replayable against another (see `verifyArtifactPreviewToken`). Closing it properly means either
   * a cookie on this route — which the sandbox's null origin makes unreliable and which is the whole
   * reason for the path token — or a revocation store consulted on every subresource request.
   * Re-reviewed when the TTL went from ten minutes to sixty: the window is longer but the reach is
   * the same — bytes the viewer was already shown, read-only — so it is still not worth either
   * mechanism. Revisit if the TTL grows again, or if a token ever opens more than one version.
   */
  backOfHouse: boolean;
  /** Unix ms; `verifyState` refuses the token once passed. */
  exp: number;
}

/** The signing key — reuses the secrets key source (never a new env var). */
export function artifactPreviewKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

export interface MintedArtifactPreview {
  token: string;
  /** Unix ms the token stops working — what the panel schedules its re-mint against. */
  expiresAt: number;
}

/** Mint a preview capability for one artifact and one viewer. Server-side callers only. */
export function mintArtifactPreviewToken(
  input: {
    artifactId: string;
    /** The version the panel asked for — omitted only by callers that predate versions. */
    versionId?: string;
    projectId: string;
    userId: string;
    backOfHouse: boolean;
    now?: number;
    ttlMs?: number;
  },
  key: Buffer = artifactPreviewKey(),
): MintedArtifactPreview {
  const expiresAt =
    (input.now ?? Date.now()) + (input.ttlMs ?? ARTIFACT_PREVIEW_TTL_MS);
  const token = signState<ArtifactPreviewPayload>(
    {
      purpose: PURPOSE,
      artifactId: input.artifactId,
      ...(input.versionId ? { versionId: input.versionId } : {}),
      projectId: input.projectId,
      userId: input.userId,
      backOfHouse: input.backOfHouse,
      exp: expiresAt,
    },
    key,
  );
  return { token, expiresAt };
}

export interface ArtifactPreviewClaim {
  projectId: string;
  userId: string;
  backOfHouse: boolean;
  /** The version the capability opens, or null for "whatever is newest" (pre-#292 tokens). */
  versionId: string | null;
}

/**
 * The claim a preview token carries for `artifactId` — including WHICH VERSION it opens — or null.
 * Null covers every failure the same
 * way — malformed, truncated, forged, signed for another purpose, minted for a DIFFERENT artifact,
 * or expired — because distinguishing them for the caller would tell an attacker which of those it
 * got right. `verifyState` compares the signature in constant time and enforces `exp` itself.
 */
export function verifyArtifactPreviewToken(
  token: string,
  artifactId: string,
  key: Buffer = artifactPreviewKey(),
  now: number = Date.now(),
): ArtifactPreviewClaim | null {
  const parsed = verifyState<ArtifactPreviewPayload>(token, key, now);
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.purpose !== PURPOSE) return null;
  // The artifact id is in the path AND in the signature: a token minted for an artifact the viewer
  // may see must not be replayable against one they may not.
  if (
    typeof parsed.artifactId !== "string" ||
    parsed.artifactId !== artifactId
  ) {
    return null;
  }
  if (typeof parsed.projectId !== "string" || !parsed.projectId) return null;
  if (typeof parsed.userId !== "string" || !parsed.userId) return null;
  return {
    projectId: parsed.projectId,
    userId: parsed.userId,
    backOfHouse: parsed.backOfHouse === true,
    // The route looks the version up CONSTRAINED to the artifact, so a claim naming a version of
    // another artifact resolves to nothing rather than to someone else's bytes.
    versionId:
      typeof parsed.versionId === "string" && parsed.versionId
        ? parsed.versionId
        : null,
  };
}

/**
 * The absolute-or-root-relative URL a minted preview is opened at (#296).
 *
 * With `PREVIEW_ORIGIN` configured this is an ABSOLUTE URL on the sandbox origin, which is the
 * whole mechanism: the panel stores what it is given verbatim into `iframe[src]`, so prefixing here
 * is what moves the document off harnesst's origin. Unset, it returns exactly the path #291
 * shipped — same string, same route, same behaviour.
 *
 * Server-only because reading env in `artifact-media.ts` would ship the origin into the client
 * bundle and evaluate it at module load in the browser, where `process.env` is not the deployment's.
 */
export function artifactPreviewUrl(
  token: string,
  artifactId: string,
  relPath: string,
): string {
  return `${previewOrigin() ?? ""}${artifactPreviewPath(token, artifactId, relPath)}`;
}

/**
 * The response headers a preview (or share-link) page file is served with — see the module comment
 * for each one. `frame-ancestors` needs a concrete origin (there is no `'self'`-with-sandbox trick
 * that survives the opaque origin the sandbox creates), and it must stay the APP's origin even when
 * the bytes are served from `PREVIEW_ORIGIN` — see `previewFrameAncestors`, which owns that rule and
 * the self-host fallback.
 */
export function artifactPreviewHeaders(input: {
  contentType: string;
  byteSize: number;
  requestUrl: string;
}): Headers {
  const origin = previewFrameAncestors(input.requestUrl);
  const csp = [
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    `frame-ancestors ${origin}`,
  ].join("; ");
  return new Headers({
    "Content-Type": artifactCharsetType(input.contentType),
    "Content-Length": String(input.byteSize),
    // Inline is the point — but `nosniff` means a wrong type fails closed rather than being
    // re-guessed as HTML, which is what keeps the extension-derived types honest.
    "Content-Disposition": "inline",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // The page's own subresource requests come from an opaque origin; see the module comment.
    "Access-Control-Allow-Origin": "*",
    // The URL is a bearer capability; caching it in a shared or on-disk cache would outlive the
    // token that authorized it. Set explicitly so the session middleware's set-if-absent default is
    // not what decides this.
    "Cache-Control": "private, no-store",
  });
}

/**
 * Pages and stylesheets bigger than this are served as stored: rewriting means holding a decoded
 * copy, and a real page is nowhere near it. (Omniplex's limit, for the same reason.)
 */
export const ARTIFACT_PAGE_REWRITE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The bytes a page-bundle member goes out as on the preview and share routes. HTML gets its
 * root-relative URLs pointed at `siteRoot` (`artifact-urls.ts`) and the bridge injected first in its
 * head; CSS gets its root-relative URLs rewritten; everything else — and anything over the rewrite
 * limit — is the stored bytes untouched. Decoded as `latin1` so every byte round-trips exactly,
 * whatever the page's own encoding.
 */
export function artifactPageBody(input: {
  bytes: Buffer;
  contentType: string;
  siteRoot: string;
}): Buffer {
  const type = artifactMediaEssence(input.contentType);
  if (input.bytes.length > ARTIFACT_PAGE_REWRITE_MAX_BYTES) return input.bytes;
  if (type === "text/html") {
    const doc = input.bytes.toString("latin1");
    return Buffer.from(
      injectArtifactBridge(rewriteRootUrlsHtml(doc, input.siteRoot)),
      "latin1",
    );
  }
  if (type === "text/css") {
    return Buffer.from(
      rewriteRootUrlsCss(input.bytes.toString("latin1"), input.siteRoot),
      "latin1",
    );
  }
  return input.bytes;
}
