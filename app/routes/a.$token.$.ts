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
 * self-sandboxing CSP (`artifactPreviewHeaders`), the same root-relative URL rewriting and the same
 * bridge (`artifactPageBody`), and when `PREVIEW_ORIGIN` is configured the app origin refuses to
 * serve any of this itself — the redirect below moves the whole family onto the sandbox origin,
 * which `previewHostAppRedirect` knows to leave there (`isPublicSharePath`). `/a/<token>` with no
 * trailing path redirects to the entry document, so the page's RELATIVE URLs resolve under the
 * token rather than one level up at `/a/`.
 *
 * Single files follow the cookie route's `artifactServePolicy`: images, audio, video and PDF inline
 * as themselves (PDF without a sandbox CSP, which Chrome's viewer cannot render under); SVG inline
 * but sandboxed; every text format as sandboxed `text/plain`; anything else, or `?download=1`, as an
 * attachment. Nothing agent-authored ever executes with an origin. `Range` is honoured throughout.
 *
 * Every failure — unknown or revoked token, a version that is not this artifact's, a member not in
 * the bundle, missing bytes — is the same 404, because distinguishing them would tell a guesser
 * which part it got right.
 */
import { data, type LoaderFunctionArgs } from "react-router";

import { artifactBytesResponse, artifactEtag } from "~/foh/artifact-http";
import {
  artifactServePolicy,
  normalizeBundleRelPath,
  safeArtifactFileName,
} from "~/foh/artifact-media";
import {
  artifactPageBody,
  artifactPreviewHeaders,
} from "~/foh/artifact-preview.server";
import { artifactSiteRoot } from "~/foh/artifact-urls";
import {
  findArtifactByShareToken,
  findArtifactFile,
  findArtifactVersion,
  latestArtifactVersion,
  readArtifactBytes,
} from "~/foh/artifact-store.server";
import { previewHostRedirect } from "~/lib/preview-origin.server";

const notFound = () => data("Not found", { status: 404 });

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
    const token = params.token ?? "";
    // An empty splat is the entry document — but served AT `/a/<token>` its relative URLs would
    // resolve against `/a/`, dropping the token. Redirect to the entry's own path so every
    // subresource resolves to `/a/<token>/<member>` and authenticates with the same token.
    if (!params["*"]) {
      const entry = version.entryPath
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/a/${token}/${entry}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    const relPath = normalizeBundleRelPath(params["*"]);
    if (!relPath) throw notFound();
    const file = await findArtifactFile({ versionId: version.id, relPath });
    if (!file) throw notFound();
    const bytes = await readArtifactBytes(file.storagePath);
    if (!bytes) throw notFound();

    const body = artifactPageBody({
      bytes,
      contentType: file.contentType,
      siteRoot: artifactSiteRoot(`/a/${token}`, version.entryPath),
    });
    const headers = artifactPreviewHeaders({
      contentType: file.contentType,
      byteSize: body.length,
      requestUrl: request.url,
    });
    // `private` says "per-user response", which this is not — but the operative half, `no-store`,
    // is shared: a cached copy would outlive revocation.
    headers.set("Cache-Control", "no-store");
    return artifactBytesResponse({
      request,
      bytes: body,
      headers,
      // A rewritten body embeds the token, so the stored bytes' hash does not identify it.
      etag: body === bytes ? artifactEtag(file.sha256) : null,
    });
  }

  // Single file (image, PDF document or file). A subpath under a single-file token names nothing.
  if (params["*"]) throw notFound();

  // `?v=` pins an exact retained version; constrained to THIS artifact, so a version id from
  // another artifact is not found rather than served. Pruned versions 404 — retention already
  // decided their bytes are not openable.
  const requested = new URL(request.url).searchParams.get("v");
  const version = requested
    ? await findArtifactVersion({
        artifactId: artifact.id,
        versionId: requested,
      })
    : await latestArtifactVersion(artifact.id);
  if (!version) throw notFound();

  const bytes = await readArtifactBytes(version.storagePath);
  if (!bytes) throw notFound();

  const url = new URL(request.url);
  const policy = artifactServePolicy({
    name: artifact.name,
    contentType: version.contentType,
    download: url.searchParams.get("download") === "1",
  });
  const headers = new Headers({
    "Content-Type": policy.contentType,
    "Content-Disposition": `${policy.disposition}; filename="${safeArtifactFileName(artifact.name)}"`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  // `sandbox` on everything the policy marks — SVG, text, attachments — so even a mis-stored type
  // renders with no origin and no script. Not on a PDF (Chrome's viewer renders blank under it) or
  // media; those carry no CSP of their own and the session middleware denies framing them.
  if (policy.sandbox) headers.set("Content-Security-Policy", "sandbox");
  return artifactBytesResponse({
    request,
    bytes,
    headers,
    etag: artifactEtag(version.sha256),
  });
}
