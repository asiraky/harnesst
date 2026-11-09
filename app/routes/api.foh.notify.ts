/**
 * Agent-initiated conversation endpoint (#288 3c). The baked `notify-user` tool POSTs
 * `{message, title?, awaits_reply?, topic?}` here with `Authorization: Bearer <HARNESST_TEAM_TOKEN>` to open a Front
 * of House conversation with the humans who run the agent. Transport shell only — the same
 * division as `routes/api.foh.park.ts`: the token authenticates the CALLER DEPLOYMENT and
 * nothing else, a bad token is the only 401, malformed JSON is a 400, and every business
 * outcome the agent should be able to read comes back 200 `{ ok:false, error }`.
 *
 * Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { defaultNotifyDeps, notifyHumans } from "~/foh/notify.server";
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

  const message = typeof body.message === "string" ? body.message : "";
  const title = typeof body.title === "string" ? body.title : null;
  // Anything but literal true is a plain notice: an old tool never sends the field.
  const awaitsReply = body.awaits_reply === true;
  const topic = typeof body.topic === "string" ? body.topic : null;

  if (!message.trim()) {
    throw data(
      { ok: false, error: "Send a non-empty message string (and optionally a title)." },
      { status: 400 },
    );
  }

  const result = await notifyHumans(
    { deploymentId, message, title, awaitsReply, topic },
    defaultNotifyDeps(),
  );
  return data(result);
}
