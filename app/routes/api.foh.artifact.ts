/**
 * Serves one published single-file artifact's bytes (#290). Resource route (loader only) — image
 * cards, media players, the PDF viewer and the text viewers all point here, same-origin with the
 * browser session's cookie, so no bytes and no URL ever leave harnesst's own auth. Who may read is
 * `requireArtifactAccess` (shared with the source route); every failure is a 404.
 *
 * WHAT GOES ON THE WIRE is `artifactServePolicy`'s call, made from the stored content type, because
 * since the `file` kind that type is the agent's extension rather than a sniff:
 *
 *   - raster images, audio and video go out as themselves, inline;
 *   - a PDF goes out inline as `application/pdf` with `nosniff` and NO sandbox — Chrome's built-in
 *     viewer renders a blank page under a `sandbox` CSP — and with `frame-ancestors 'self'` so the
 *     app's own panel can frame it (setting a CSP also makes the session middleware drop its
 *     `X-Frame-Options: DENY`). No third party can frame it, and the viewer's scripting runs in the
 *     browser's PDF plugin, not against this origin. Served from HERE, the app origin, on purpose
 *     rather than from the preview origin pages use: `application/pdf` + `nosniff` is never parsed
 *     as HTML, the PDF viewer gives the document no DOM or cookie access to the embedding app,
 *     Chrome's viewer blanks under any sandbox, and the preview origin carries no cookies so it
 *     would need a token route — the same call Omniplex makes;
 *   - SVG goes out inline but under `Content-Security-Policy: sandbox`: inert in an `<img>`, and a
 *     direct navigation now runs no script and gets an opaque origin;
 *   - every text format — markdown, CSV, JSON, code, plain text, even HTML that arrived as a single
 *     file — goes out as `text/plain; charset=utf-8`, sandboxed. The viewers fetch and render it
 *     themselves; the browser never interprets it as markup;
 *   - anything else, and anything requested with `?download=1`, is an attachment.
 *
 * Page BUNDLES are refused here outright (#291) — their one door is the preview/share routes, whose
 * responses sandbox themselves into an opaque origin. Their source text is the source route's.
 *
 * `Range` is honoured (single range, 206/416) so media can seek and a PDF viewer can fetch by page.
 *
 * The bytes at an id-AND-VERSION never change (they are content-addressed at publish time and a
 * version row is immutable), so the response is cacheable — set explicitly, because a dynamic route
 * with no Cache-Control is forced to `private, no-store` by the session middleware, and a transcript
 * that revalidates every two seconds while a turn runs would refetch every image each time. The
 * version is in the path for exactly that reason (#292): republishing a name changes what the
 * artifact holds, so a version-less URL cannot honestly be `immutable` and is served revalidating.
 */
import { data, type LoaderFunctionArgs } from "react-router";

import { requireArtifactAccess } from "~/foh/artifact-access.server";
import { artifactBytesResponse, artifactEtag } from "~/foh/artifact-http";
import {
  artifactIsSingleFileKind,
  artifactServePolicy,
  safeArtifactFileName,
} from "~/foh/artifact-media";
import { readArtifactBytes } from "~/foh/artifact-store.server";

export async function loader(args: LoaderFunctionArgs) {
  const { artifact, version, versionPinned } =
    await requireArtifactAccess(args);
  // Single files only, and this is a security boundary rather than a lookup nicety (#291): a page
  // bundle's `text/html` served from this origin would execute agent-authored script against the
  // viewer's own cookie.
  if (!artifactIsSingleFileKind(artifact.kind)) {
    throw data("Not found", { status: 404 });
  }

  const bytes = await readArtifactBytes(version.storagePath);
  if (!bytes) throw data("Not found", { status: 404 });

  const download =
    new URL(args.request.url).searchParams.get("download") === "1";
  const policy = artifactServePolicy({
    name: artifact.name,
    contentType: version.contentType,
    download,
  });
  const headers = new Headers({
    "Content-Type": policy.contentType,
    "Content-Disposition": `${policy.disposition}; filename="${safeArtifactFileName(artifact.name)}"`,
    "X-Content-Type-Options": "nosniff",
    // Only a version-scoped URL is immutable. Without the segment this means "whatever is
    // newest", which a year-long cache would freeze at whatever it first happened to be.
    "Cache-Control": versionPinned
      ? "private, max-age=31536000, immutable"
      : "private, no-cache",
  });
  if (policy.sandbox) {
    headers.set("Content-Security-Policy", "sandbox; frame-ancestors 'self'");
  } else if (policy.embeddable) {
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }
  return artifactBytesResponse({
    request: args.request,
    bytes,
    headers,
    etag: artifactEtag(version.sha256),
  });
}
