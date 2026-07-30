/**
 * Serves one published artifact's bytes (#290). Resource route (loader only) — the `<img>` in the
 * FOH artifact card points here, same-origin with the browser session's cookie, so no bytes and no
 * URL ever leave harnesst's own auth.
 *
 * Everything unauthorized is a 404, never a 403: `requireFohProject` already makes an out-of-scope
 * repo indistinguishable from a nonexistent one, and the same must hold for an artifact id — a
 * signed-out visitor or a member outside the repo's team must not be able to learn that an id
 * exists. Visibility is the session's, not the project's: the row is only served when the viewer
 * can see the conversation it was published into.
 *
 * The bytes at an id never change (they are content-addressed at publish time and the row is
 * immutable), so the response is cacheable — set explicitly, because a dynamic route with no
 * Cache-Control is forced to `private, no-store` by the session middleware, and a transcript that
 * revalidates every two seconds while a turn runs would refetch every image each time.
 */
import { data, type LoaderFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import { artifactRendersInline } from "~/foh/artifact-media";
import {
  findProjectArtifact,
  readArtifactBytes,
} from "~/foh/artifact-store.server";
import { requireFohProject } from "~/foh/guard.server";
import { getFohSessionForViewer } from "~/playground/sessions.server";

/** A quoted `filename` for the disposition header — never the raw agent-supplied name. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return cleaned || "artifact";
}

export async function loader(args: LoaderFunctionArgs) {
  const auth = await getSessionAuth(args);
  // 404, not the /login redirect the other FOH resource routes use: this URL is loaded by an
  // `<img>`, so a redirect would resolve to the sign-in HTML and render as a broken image while
  // also confirming the id exists.
  if (!auth.user) throw data("Not found", { status: 404 });
  const access = await requireFohProject(auth, args.params.projectId);

  const artifactId = args.params.artifactId ?? "";
  const artifact = artifactId
    ? await findProjectArtifact({ id: artifactId, projectId: access.project.id })
    : null;
  if (!artifact) throw data("Not found", { status: 404 });
  // Images only, and this is a security boundary rather than a lookup nicety (#291): this response
  // sets no CSP, so serving a page bundle's `text/html` here would execute agent-authored script
  // same-origin against the viewer's own cookie. Bundles have exactly one door — the preview route,
  // whose response sandboxes itself.
  if (artifact.kind !== "image") throw data("Not found", { status: 404 });

  const session = await getFohSessionForViewer({
    id: artifact.sessionId,
    projectId: access.project.id,
    viewerId: auth.user.id,
    includeAll: access.backOfHouse,
  });
  if (!session) throw data("Not found", { status: 404 });

  const bytes = await readArtifactBytes(artifact.storagePath);
  if (!bytes) throw data("Not found", { status: 404 });

  const inline = artifactRendersInline(artifact.contentType);
  // `new Uint8Array(...)`: a Node Buffer is not a `BodyInit` as far as the DOM lib is concerned,
  // and the copy is a view, not a duplicate of the bytes.
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": artifact.contentType,
      "Content-Length": String(bytes.length),
      // An SVG is safe inside an `<img>` (scripts never run in an image context) but a direct
      // navigation to this URL would execute them same-origin. A download disposition kills that:
      // navigations honour it, image loads ignore it. Raster formats stay inline.
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeFileName(artifact.name)}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
