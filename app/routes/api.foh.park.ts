/**
 * Channel park endpoint (WS1). A channel-homed agent's `input.requested` handler POSTs the
 * question here with `Authorization: Bearer <HARNESST_TEAM_TOKEN>` so it lands in Front of House
 * as something a human can answer. Transport shell only — the same division as
 * `routes/api.team.ask.ts`: the token authenticates the CALLER DEPLOYMENT and nothing else, a
 * bad token is the only 401, malformed JSON is a 400, and every business outcome the agent
 * should be able to read comes back 200 `{ ok:false, error }`.
 *
 * Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import {
  defaultParkDeps,
  normalizeParkRequests,
  parkChannelQuestion,
} from "~/foh/park.server";
import { verifyDelegationToken } from "~/team/token.server";

export async function action({ request }: ActionFunctionArgs) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId) throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw data({ ok: false, error: "Malformed JSON body." }, { status: 400 });
  }

  const channel = typeof body.channel === "string" ? body.channel : "";
  const routePath = typeof body.routePath === "string" ? body.routePath : "";
  const eveSessionId =
    typeof body.eveSessionId === "string" ? body.eveSessionId : "";
  const continuationToken =
    typeof body.continuationToken === "string" ? body.continuationToken : "";
  const state =
    typeof body.state === "object" && body.state !== null && !Array.isArray(body.state)
      ? (body.state as Record<string, unknown>)
      : null;
  const title = typeof body.title === "string" ? body.title : null;
  const requests = normalizeParkRequests(body.requests);

  if (!channel || !routePath || !eveSessionId || !continuationToken || !state || !requests) {
    throw data(
      {
        ok: false,
        error:
          "Send channel, routePath, eveSessionId, continuationToken, state and a non-empty requests array.",
      },
      { status: 400 },
    );
  }

  const result = await parkChannelQuestion(
    {
      deploymentId,
      channel,
      routePath,
      eveSessionId,
      continuationToken,
      state,
      title,
      requests,
    },
    defaultParkDeps(),
  );
  return data(result);
}
