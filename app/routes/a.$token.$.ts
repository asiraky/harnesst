/**
 * The public artifact share route (issue #370): `/a/<token>`, and `/a/<token>/<member>` for a
 * page's subresources. Resource route, loader only.
 *
 * The token is the ENTIRE authentication and authorization. No cookie is ever read here — the
 * response must mean the same thing to every holder of the URL, and a public link that varied by
 * browser session would leak the difference. What makes that sound is the token itself
 * (`newShareToken`: 32 nanoid chars, ~190 bits, unique-indexed) and the revocation story: the BOH
 * artifacts page can NULL or rotate a token, and because `findArtifactByShareToken` matches by
 * equality, a nulled token is unreachable on the very next request — which is why nothing here may
 * be cached (`no-store` throughout).
 *
 * Unlike the preview capability, this token is NOT version-scoped: a share link means "the current
 * state of this artifact", so it follows republishes. `?v=<versionId>` pins a single-file artifact
 * to an exact retained version — the picker's "share this version". Pages deliberately have no
 * `?v=`: every relative `href`/`src` inside the page resolves against the path and would drop the
 * query, so half the page would silently un-pin; the stable link serves the newest version only.
 *
 * SERVING SAFETY is the preview route's, wholesale. Page bytes go out with the same
 * self-sandboxing CSP (`artifactPreviewHeaders`), and when `PREVIEW_ORIGIN` is configured the app
 * origin refuses to serve any of this itself — the redirect below moves the whole family onto the
 * sandbox origin, which `previewHostAppRedirect` knows to leave there (`isPublicSharePath`).
 * Single files keep the cookie route's disposition rule: raster images inline, SVG and PDF as
 * attachment, so nothing agent-authored ever executes same-origin.
 *
 * Every failure — unknown or revoked token, a version that is not this artifact's, a member not in
 * the bundle, missing bytes — is the same 404, because distinguishing them would tell a guesser
 * which part it got right.
 */
import { data, type LoaderFunctionArgs } from "react-router";

import {
  artifactRendersInline,
  normalizeBundleRelPath,
  safeArtifactFileName,
} from "~/foh/artifact-media";
import { artifactPreviewHeaders } from "~/foh/artifact-preview.server";
import {
  findArtifactByShareToken,
  findArtifactFile,
  findArtifactVersion,
  latestArtifactVersion,
  readArtifactBytes,
} from "~/foh/artifact-store.server";
import { previewHostRedirect } from "~/lib/preview-origin.server";

const notFound = () => data("Not found", { status: 404 });

/** A Node Buffer as a `BodyInit` — a VIEW over the same memory, not a copy (see preview route). */
function bodyOf(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.length,
  );
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // With PREVIEW_ORIGIN configured the app origin serves none of this: the bounce happens before
  // any token work, so the app origin's answer never depends on whether the capability was valid.
  const toPreviewOrigin = previewHostRedirect(request);
  if (toPreviewOrigin) return toPreviewOrigin;

  const artifact = await findArtifactByShareToken(params.token ?? "");
  if (!artifact) throw notFound();

  if (artifact.kind === "html") {
    // Newest version only — the stable link's meaning. See the header comment for why `?v=` does
    // not exist for pages.
    const version = await latestArtifactVersion(artifact.id);
    if (!version || !version.entryPath) throw notFound();
    // An empty splat is the entry document, so `/a/<token>` opens the page and its relative URLs
    // resolve to `/a/<token>/<member>` — every subresource authenticating with the same token.
    const relPath = normalizeBundleRelPath(params["*"] || version.entryPath);
    if (!relPath) throw notFound();
    const file = await findArtifactFile({ versionId: version.id, relPath });
    if (!file) throw notFound();
    const bytes = await readArtifactBytes(file.storagePath);
    if (!bytes) throw notFound();

    const headers = artifactPreviewHeaders({
      contentType: file.contentType,
      byteSize: bytes.length,
      requestUrl: request.url,
    });
    // `private` says "per-user response", which this is not — but the operative half, `no-store`,
    // is shared: a cached copy would outlive revocation.
    headers.set("Cache-Control", "no-store");
    return new Response(bodyOf(bytes), { headers });
  }

  // Single file (image or PDF document). A subpath under a single-file token names nothing.
  if (params["*"]) throw notFound();

  // `?v=` pins an exact retained version; constrained to THIS artifact, so a version id from
  // another artifact is not found rather than served. Pruned versions 404 — retention already
  // decided their bytes are not openable.
  const requested = new URL(request.url).searchParams.get("v");
  const version = requested
    ? await findArtifactVersion({ artifactId: artifact.id, versionId: requested })
    : await latestArtifactVersion(artifact.id);
  if (!version) throw notFound();

  const bytes = await readArtifactBytes(version.storagePath);
  if (!bytes) throw notFound();

  const inline =
    artifact.kind === "image" && artifactRendersInline(version.contentType);
  return new Response(bodyOf(bytes), {
    headers: {
      "Content-Type": version.contentType,
      "Content-Length": String(bytes.length),
      // The cookie route's rule, kept deliberately on the public door: raster images render, SVG
      // (script-capable on navigation) and PDF download. `sandbox` CSP as belt to that braces —
      // even a mis-stored type renders with no origin and no script.
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeArtifactFileName(artifact.name)}"`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}
