/**
 * An artifact's SOURCE — the text behind a page, an SVG, a markdown report — for the preview
 * panel's source view. Resource route (loader only), cookie-authenticated exactly like the raw
 * route (`requireArtifactAccess`; every failure is a 404).
 *
 *   GET /api/foh/:projectId/artifact/:artifactId/source[/:versionId]
 *     → JSON `{ versionId, entry, files: [{ path, contentType, byteSize }] }`
 *   GET /api/foh/:projectId/artifact/:artifactId/source[/:versionId]?path=<file path>
 *     → that file's bytes as `text/plain; charset=utf-8`
 *
 * This is the ONLY cookie-authenticated door to a page bundle's bytes, and it is safe for the same
 * reason the raw route's text is: the bytes go out as `text/plain` with `nosniff` and a `sandbox`
 * CSP, so a browser never interprets them as markup, whatever they say. Rendering a page is still
 * the preview route's alone.
 *
 * Works for every kind: a bundle lists its members (path-ordered, `entry` = the document the
 * preview opens at); a single file lists itself, under its published name.
 *
 * SIZE. A source view is for reading, and a viewer that highlights a 25 MB file freezes the tab, so
 * a member is capped at `ARTIFACT_SOURCE_MAX_BYTES` (1 MiB). A longer file is CUT — at a UTF-8
 * character boundary, so the tail is never a broken glyph — and the response says so with
 * `X-Artifact-Truncated: 1`; `X-Artifact-Byte-Size` always carries the file's full size. (A header
 * rather than `Range` because the client wants "as much as is reasonable", not a byte window it
 * would have to compute and re-assemble.)
 */
import { data, type LoaderFunctionArgs } from "react-router";

import { requireArtifactAccess } from "~/foh/artifact-access.server";
import { normalizeBundleRelPath } from "~/foh/artifact-media";
import {
  findArtifactFile,
  listArtifactFiles,
  readArtifactBytes,
} from "~/foh/artifact-store.server";
import {
  ARTIFACT_SOURCE_MAX_BYTES,
  ARTIFACT_SOURCE_SIZE_HEADER,
  ARTIFACT_SOURCE_TRUNCATED_HEADER,
  truncateUtf8,
  type ArtifactSourceListing,
} from "~/foh/artifact-source";

const notFound = () => data("Not found", { status: 404 });

export async function loader(args: LoaderFunctionArgs) {
  const { artifact, version, versionPinned } =
    await requireArtifactAccess(args);
  const cacheControl = versionPinned
    ? "private, max-age=31536000, immutable"
    : "private, no-cache";
  const bundle = artifact.kind === "html";
  const path = new URL(args.request.url).searchParams.get("path");

  if (path === null) {
    const listing: ArtifactSourceListing = bundle
      ? {
          versionId: version.id,
          entry: version.entryPath ?? "",
          files: (await listArtifactFiles(version.id)).map((file) => ({
            path: file.relPath,
            contentType: file.contentType,
            byteSize: file.byteSize,
          })),
        }
      : {
          versionId: version.id,
          entry: artifact.name,
          files: [
            {
              path: artifact.name,
              contentType: version.contentType,
              byteSize: version.byteSize,
            },
          ],
        };
    return Response.json(listing, {
      headers: { "Cache-Control": cacheControl },
    });
  }

  let storagePath: string;
  if (bundle) {
    const relPath = normalizeBundleRelPath(path);
    const file = relPath
      ? await findArtifactFile({ versionId: version.id, relPath })
      : null;
    if (!file) throw notFound();
    storagePath = file.storagePath;
  } else {
    if (path !== artifact.name) throw notFound();
    storagePath = version.storagePath;
  }
  const bytes = await readArtifactBytes(storagePath);
  if (!bytes) throw notFound();

  const { bytes: body, truncated } = truncateUtf8(
    bytes,
    ARTIFACT_SOURCE_MAX_BYTES,
  );
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; frame-ancestors 'self'",
    [ARTIFACT_SOURCE_SIZE_HEADER]: String(bytes.length),
    "Cache-Control": cacheControl,
  });
  if (truncated) headers.set(ARTIFACT_SOURCE_TRUNCATED_HEADER, "1");
  return new Response(
    new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.length),
    { headers },
  );
}
