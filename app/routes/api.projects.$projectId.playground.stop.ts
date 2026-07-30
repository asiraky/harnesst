import { getSessionAuth } from "~/auth/session.server";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { liveTargets } from "~/chat/playground.server";
import { asString, cancelActiveTurn } from "~/chat/turn-stream.server";
import {
  getPlaygroundSession,
  markPlaygroundSessionStopped,
} from "~/playground/sessions.server";
import {
  agentFromParams,
  requireActiveAgent,
  resolveAgentContext,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );

  const form = await args.request.formData();
  const agentName =
    agentFromParams(args.params) ?? asString(form.get("agentName"));
  const { active } = await resolveAgentContext(project.id, agentName);
  requireActiveAgent(active, project.id);
  const playgroundSessionId = asString(form.get("playgroundSessionId"));
  if (!playgroundSessionId) {
    throw data({ error: "No playground session to stop." }, { status: 400 });
  }

  const session = await getPlaygroundSession({
    id: playgroundSessionId,
    projectId: project.id,
    agentId: active.id,
    userId: auth.user.id,
  });
  if (!session) {
    throw data(
      { error: "That playground session was not found." },
      { status: 404 },
    );
  }

  const targets = await liveTargets(active.id);
  // The eve session lives in its environment's world store, so any live deployment of that
  // environment can cancel it. A cross-environment target never knew the session — Eve hangs
  // (not 404s) requests about unknown sessions, so a cancel there can only time out and used
  // to make Stop fail on exactly the sessions that most need it (#73).
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
      {
        error: eveCancel.detail,
      },
      { status: eveCancel.unsupported ? 501 : 502 },
    );
  }

  const localCanceled = cancelActiveTurn(session.id);
  if (!localCanceled && session.externalSessionId && target) {
    // The turn's AbortController lives in the process that streamed it. In a
    // multi-replica deployment the stream may be on another instance, so the
    // local abort is a no-op here (Eve was still cancelled above). Log it so
    // ops can spot the cross-instance case when a stop seems not to take.
    console.warn(
      `[playground/stop] no local turn controller for session ${session.id} — turn is likely streaming on another replica`,
    );
  }
  await markPlaygroundSessionStopped({ id: session.id, target });

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
