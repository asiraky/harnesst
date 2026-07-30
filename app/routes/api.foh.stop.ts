/**
 * FOH stop (resource route, action only) — the playground stop path rebound to FOH sessions
 * (D20 copy). Same eve-cancel discipline (#73: only ask the deployment that RAN the turn,
 * never a replacement instance) + the local drain abort; additionally resolves the session's
 * pending inbox items — a deliberate stop moots any parked question, and the stop-wins guards
 * mean nothing else could clear them afterwards.
 */
import { getSessionAuth } from "~/auth/session.server";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { liveTargets } from "~/chat/playground.server";
import { asString, cancelActiveTurn } from "~/chat/turn-stream.server";
import { resolveInboxForSession } from "~/foh/inbox.server";
import { requireFohProject } from "~/foh/guard.server";
import {
  getFohSessionForViewer,
  markPlaygroundSessionStopped,
} from "~/playground/sessions.server";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const access = await requireFohProject(auth, args.params.projectId);

  const form = await args.request.formData();
  const playgroundSessionId = asString(form.get("playgroundSessionId"));
  if (!playgroundSessionId) {
    throw data({ error: "No conversation to stop." }, { status: 400 });
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

  // The eve session lives in its environment's world store, so any live deployment of that
  // environment can cancel it. A cross-environment target never knew the session (and eve
  // hangs, not 404s, on unknown ids), so nothing outside the session's environment is asked.
  const targets = await liveTargets(session.agentId);
  const target =
    targets.find((t) => t.environmentId === session.environmentId) ?? null;

  const eveCancel =
    session.externalSessionId && target
      ? await cancelEveTurn({
          baseUrl: target.url,
          sessionId: session.externalSessionId,
        })
      : {
          ok: true as const,
          detail: target
            ? "No Eve session id was recorded yet."
            : "The deployment that ran this turn is gone — harnesst settled the conversation without contacting its replacement.",
        };

  if (!eveCancel.ok) {
    throw data(
      { error: eveCancel.detail },
      { status: eveCancel.unsupported ? 501 : 502 },
    );
  }

  const localCanceled = cancelActiveTurn(session.id);
  if (!localCanceled && session.externalSessionId && target) {
    console.warn(
      `[foh/stop] no local turn controller for session ${session.id} — turn is likely streaming on another replica`,
    );
  }
  await markPlaygroundSessionStopped({ id: session.id, target });
  // The stop clears pendingInputAt (sessions.server); the bell items go with it.
  await resolveInboxForSession(session.id);

  return {
    ok: true as const,
    localCanceled,
    detail: eveCancel.detail,
  };
}

async function cancelEveTurn(input: {
  baseUrl: string;
  sessionId: string;
}): Promise<
  | { ok: true; detail: string }
  | { ok: false; detail: string; unsupported?: boolean }
> {
  const base = input.baseUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/eve/v1/session/${input.sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "turn" }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return {
      ok: false,
      detail: `Couldn't reach Eve to stop the turn: ${(error as Error).message}`,
    };
  }

  if (res.ok) {
    return { ok: true, detail: "Eve accepted the stop request." };
  }
  if (res.status === 404 || res.status === 405) {
    return {
      ok: false,
      unsupported: true,
      detail:
        "This Eve deployment does not expose turn cancellation yet. harnesst did not detach from the running turn.",
    };
  }
  const text = await res.text().catch(() => "");
  return {
    ok: false,
    detail: `Eve rejected the stop request (${res.status}).${text ? ` ${text}` : ""}`,
  };
}
