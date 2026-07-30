/**
 * What makes serving agent-authored HTML from harnesst's own origin safe (issue #291): a
 * short-lived path token, and a response that sandboxes itself.
 *
 * ── THE SANDBOX IS A PROPERTY OF THE RESOURCE, NOT THE EMBEDDING ──────────────────────────────
 * The HTML spec says it outright about `iframe[sandbox]`: "Sandboxing hostile content is of minimal
 * help if an attacker can convince the user to just visit the hostile content directly, rather than
 * in the iframe." Any top-level load — a new tab, a pasted link, a crawler — applies exactly zero
 * of the embedding's sandbox flags. So the sandbox travels on the RESPONSE, as the CSP `sandbox`
 * directive, which is header-only (`<meta>` cannot express it) and therefore survives a top-level
 * navigation. The iframe's own `sandbox="allow-scripts"` is belt to this braces, not the mechanism.
 *
 * That is also why the bytes are never handed to a `srcdoc` or a `blob:` URL: a local scheme
 * inherits the embedding document's CSP and cannot carry its own, so an artifact would silently
 * acquire whatever reach harnesst's own pages have.
 *
 * Each directive is load-bearing, and three of them do NOT fall back to `default-src`, so their
 * absence would be a hole rather than a default: `form-action 'none'` (no POSTing the page's data
 * anywhere), `base-uri 'none'` (without it a single `<base href="https://evil/">` re-points every
 * relative URL in the document), and `frame-ancestors <app-origin>` (only harnesst may embed the
 * preview — this is the directive that prevents the third-party-embed attack run against Claude
 * Artifacts in Dec 2025, where any site could frame a victim's authenticated artifact URL).
 * `connect-src 'none'` also covers `<a ping>`, which is widely believed otherwise.
 *
 * ACCEPTED RESIDUAL RISK: exfiltration. CSP was built against XSS, not exfil, and cannot close
 * WebRTC, DNS prefetch, CSP report endpoints, or (browser-dependent) self-navigation. The
 * compensating invariant is that an artifact only ever contains data its viewer already has — which
 * is why there is deliberately NO postMessage bridge and NO fetch proxy here: every such
 * convenience in the wild turned into an artifact-controlled authenticated capability.
 *
 * ── WHY A PATH TOKEN AND NOT A COOKIE ─────────────────────────────────────────────────────────
 * A sandboxed frame is a null-origin, storage-less context, and the moment this preview moves to a
 * separate origin (the obvious next hardening step) `SameSite=Lax` cookies stop being sent to it
 * altogether while `SameSite=None` fights Safari ITP. A signed token in the PATH authenticates the
 * document and every subresource it pulls, identically same-origin or cross-origin, and it expires
 * on its own. Keyed by the same `HARNESST_SECRETS_KEY` as every other signed-state flow — never a
 * new env var — and pure over an injected key so mint/verify unit-test with no env.
 */
import { appOrigin } from "~/lib/marketing-host.server";
import { signState, verifyState } from "~/lib/signed-state.server";
import { artifactCharsetType } from "~/foh/artifact-media";
import { decodeKey } from "~/seams/oss/secretbox";

const PURPOSE = "foh-artifact-preview";

/**
 * How long a minted preview URL works. Minutes, not hours: the token is a bearer capability that
 * travels in a URL (and therefore into history and into any "open in new tab"), so its value has to
 * decay quickly — and the panel re-mints transparently, so the user never meets the expiry.
 */
export const ARTIFACT_PREVIEW_TTL_MS = 10 * 60 * 1000;

interface ArtifactPreviewPayload {
  purpose: typeof PURPOSE;
  artifactId: string;
  projectId: string;
  userId: string;
  /**
   * Whether the minting viewer was back of house. Carried rather than re-derived because the
   * preview route has no cookie and so cannot read org/team membership — but the load-bearing
   * per-CONVERSATION visibility check is still re-run per request against `userId`, so a token
   * outliving the viewer's access to the conversation stops working inside the TTL.
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
}

/**
 * The claim a preview token carries for `artifactId`, or null. Null covers every failure the same
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
  if (typeof parsed.artifactId !== "string" || parsed.artifactId !== artifactId) {
    return null;
  }
  if (typeof parsed.projectId !== "string" || !parsed.projectId) return null;
  if (typeof parsed.userId !== "string" || !parsed.userId) return null;
  return {
    projectId: parsed.projectId,
    userId: parsed.userId,
    backOfHouse: parsed.backOfHouse === true,
  };
}

/**
 * The response headers a preview file is served with. `frame-ancestors` needs a concrete origin
 * (there is no `'self'`-with-sandbox trick that survives the null origin the sandbox creates), and
 * `BETTER_AUTH_URL` is legitimately unset on a self-host install — so the request's own origin is
 * the fallback, exactly as the CSRF origin check already does.
 */
export function artifactPreviewHeaders(input: {
  contentType: string;
  byteSize: number;
  requestUrl: string;
}): Headers {
  const origin = appOrigin() ?? new URL(input.requestUrl).origin;
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    "style-src 'unsafe-inline' 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "script-src 'unsafe-inline' 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
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
    // The URL is a bearer capability with a short life; caching it in a shared or on-disk cache
    // would outlive the token that authorized it. Set explicitly so the session middleware's
    // set-if-absent default is not what decides this.
    "Cache-Control": "private, no-store",
  });
}
