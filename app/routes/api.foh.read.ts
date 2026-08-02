/**
 * FOH read acknowledgement (resource route, action only). Marking a session read (D3) and
 * acknowledging every inbox item visible to the viewer (D13) is a MUTATION, so it must not
 * live in a GET loader: the session links prefetch on hover/focus (`prefetch="intent"`),
 * and an intent prefetch runs the loader — a hover must never acknowledge a session the
 * user hasn't opened (issue #221 finding 8). The session page posts here after committed
 * navigation (and as new events arrive while it stays open).
 */
import { getSessionAuth } from "~/auth/session.server";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { asString } from "~/chat/turn-stream.server";
import { requireFohProject } from "~/foh/guard.server";
import { markSessionRead } from "~/foh/reads.server";
import { getFohSessionForViewer } from "~/playground/sessions.server";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const access = await requireFohProject(auth, args.params.projectId);

  const form = await args.request.formData();
  const playgroundSessionId = asString(form.get("playgroundSessionId"));
  if (!playgroundSessionId) {
    throw data({ error: "No conversation to acknowledge." }, { status: 400 });
  }

  const session = await getFohSessionForViewer({
    id: playgroundSessionId,
    projectId: access.project.id,
    viewerId: auth.user.id,
    includeAll: access.backOfHouse,
  });
  if (!session) {
    throw data({ error: "That conversation was not found." }, { status: 404 });
  }

  await markSessionRead(session, auth.user.id);
  return { ok: true as const };
}
