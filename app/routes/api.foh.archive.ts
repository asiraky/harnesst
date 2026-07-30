/**
 * FOH archive / undo (resource route, action only) — the front-of-house tidy-up (#278).
 *
 * One endpoint for both directions because they are one gesture: archive, then Undo from the
 * transient strip. Both run under the FOH viewer scope (`getFohSessionForViewer`'s rule:
 * members their own rows plus agent-opened ones, admins/owners everything), so the person who
 * just archived a conversation can take it back without an admin. Neither direction destroys
 * anything — permanent deletion is back-of-house only.
 *
 * A refusal ("still working") comes back 200 with `ok: false`: it is inline copy next to the
 * row, not an error. Only an unresolvable session is a 404, matching stop/read.
 */
import { getSessionAuth } from "~/auth/session.server";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { asString } from "~/chat/turn-stream.server";
import { requireFohProject } from "~/foh/guard.server";
import {
  archiveFohSession,
  unarchiveFohSessionForViewer,
} from "~/playground/sessions.server";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const access = await requireFohProject(auth, args.params.projectId);

  const form = await args.request.formData();
  const playgroundSessionId = asString(form.get("playgroundSessionId"));
  const intent = asString(form.get("intent")) || "archive";
  if (!playgroundSessionId) {
    throw data({ error: "No conversation to archive." }, { status: 400 });
  }
  if (intent !== "archive" && intent !== "unarchive") {
    throw data({ error: "Unknown archive intent." }, { status: 400 });
  }

  const scope = {
    id: playgroundSessionId,
    projectId: access.project.id,
    viewerId: auth.user.id,
    includeAll: access.backOfHouse,
  };

  if (intent === "unarchive") {
    const restored = await unarchiveFohSessionForViewer(scope);
    if (!restored.ok) {
      throw data({ error: "That conversation was not found." }, { status: 404 });
    }
    return {
      ok: true as const,
      intent,
      sessionId: restored.session.id,
      title: restored.session.title ?? "New conversation",
    };
  }

  const archived = await archiveFohSession(scope);
  if (!archived.ok) {
    if (archived.reason === "working") {
      return {
        ok: false as const,
        intent,
        sessionId: playgroundSessionId,
        error: "Still working — stop it first.",
      };
    }
    throw data({ error: "That conversation was not found." }, { status: 404 });
  }
  return {
    ok: true as const,
    intent,
    sessionId: archived.session.id,
    title: archived.session.title ?? "New conversation",
  };
}
