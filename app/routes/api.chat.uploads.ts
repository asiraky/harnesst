/**
 * Serves one file a user attached to a chat message — the thumbnails and download links on user
 * bubbles point here. Resource route (loader only), same-origin with the browser session cookie.
 *
 * Visibility is the conversation's: a FOH conversation is readable by whoever can view it
 * (`getFohSessionForViewer`); playground and assistant conversations only by their creator
 * (`getPlaygroundSession`). Everything unauthorized — signed out, out-of-scope repo, someone
 * else's conversation, unknown sha — is a 404, never a 403, so an id's existence never leaks.
 *
 * Content-addressed (the path ends in the bytes' sha256), so the response is honestly immutable.
 * Only raster images render inline; everything else downloads, and `nosniff` stops a browser
 * from promoting a text file to HTML. SVG is never accepted at upload, so it never reaches here.
 */
import { data, type LoaderFunctionArgs } from "react-router";

import { getSessionAuth, type SessionAuth } from "~/auth/session.server";
import {
  readUpload,
  uploadContentDisposition,
  uploadRendersInline,
} from "~/chat/attachments.server";
import { requireFohProject } from "~/foh/guard.server";
import {
  findSessionSurface,
  getFohSessionForViewer,
  getPlaygroundSession,
  type SessionSurface,
} from "~/playground/sessions.server";
import { requireProject } from "~/project/guard.server";

function notFound(): never {
  throw data("Not found", { status: 404 });
}

/** Whether the signed-in user may read this conversation (any guard failure is a plain false). */
async function canViewConversation(input: {
  auth: SessionAuth;
  userId: string;
  projectId: string;
  sessionId: string;
}): Promise<boolean> {
  try {
    const row = await findSessionSurface({
      id: input.sessionId,
      projectId: input.projectId,
    });
    if (!row) return false;
    if (row.surface === "foh") {
      const access = await requireFohProject(input.auth, input.projectId);
      return Boolean(
        await getFohSessionForViewer({
          id: input.sessionId,
          projectId: access.project.id,
          viewerId: input.userId,
          includeAll: access.backOfHouse,
        }),
      );
    }
    const project = await requireProject(input.auth, input.projectId);
    return Boolean(
      await getPlaygroundSession({
        id: input.sessionId,
        projectId: project.id,
        agentId: row.agentId,
        userId: input.userId,
        surface: row.surface as SessionSurface,
      }),
    );
  } catch {
    // Guards throw redirects / 403s / 404s — all of which must look identical from outside.
    return false;
  }
}

export async function loader(args: LoaderFunctionArgs) {
  const state = await getSessionAuth(args);
  if (!state.user) notFound();
  const auth = state as SessionAuth;
  const projectId = args.params.projectId ?? "";
  const sessionId = args.params.sessionId ?? "";
  const sha256 = (args.params.sha ?? "").toLowerCase();
  if (!projectId || !sessionId || !/^[a-f0-9]{64}$/.test(sha256)) notFound();

  const allowed = await canViewConversation({
    auth,
    userId: auth.user.id,
    projectId,
    sessionId,
  });
  if (!allowed) notFound();

  const upload = await readUpload({ projectId, sessionId, sha256 });
  if (!upload) notFound();

  const { bytes, meta } = upload;
  const inline = uploadRendersInline(meta.mediaType);
  const contentType =
    meta.mediaType === "text/plain"
      ? "text/plain; charset=utf-8"
      : meta.mediaType;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": uploadContentDisposition(inline, meta.name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
