/**
 * Teammate delegation relay endpoint (Team delegation — D1/§2). A team member's `ask-teammate`
 * or `tell-teammate` tool POSTs `{ teammate, message, mode }` here with
 * `Authorization: Bearer <HARNESST_TEAM_TOKEN>` — `mode: "tell"` (#269) returns as soon as the
 * peer's turn is dispatched; anything else is a blocking ask. The
 * token authenticates the CALLER DEPLOYMENT and nothing else — everything downstream (caller
 * identity, authorization, the target, its live deployment) is derived server-side in
 * `runAsk`. Bad token → 401; every business outcome the model should read → 200 `{ ok:false }`.
 * Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { defaultAskDeps, runAsk } from "~/team/ask.server";
import { verifyDelegationToken } from "~/team/token.server";

export async function action({ request }: ActionFunctionArgs) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId) throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { teammate?: unknown; message?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as {
      teammate?: unknown;
      message?: unknown;
      mode?: unknown;
    };
  } catch {
    return data({ ok: false, error: "Send a JSON body with `teammate` and `message`." });
  }
  const teammate = typeof body.teammate === "string" ? body.teammate : "";
  const message = typeof body.message === "string" ? body.message : "";
  // Anything that is not exactly "tell" is a blocking ask — the pre-#269 wire shape had no mode.
  const mode = body.mode === "tell" ? ("tell" as const) : ("ask" as const);

  const result = await runAsk(
    { deploymentId, teammate, message, mode },
    defaultAskDeps(),
  );
  return data(result);
}
