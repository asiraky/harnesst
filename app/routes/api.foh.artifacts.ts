/**
 * Artifact publish endpoint (#290, #291). The `publish-artifact` tool POSTs here with
 * `Authorization: Bearer <HARNESST_TEAM_TOKEN>` and harnesst copies the named file out of the
 * agent's home volume into its own store. Transport shell only — the same division as
 * `routes/api.foh.park.ts`: the token authenticates the CALLER DEPLOYMENT and nothing else, a bad
 * token is the only 401, malformed JSON or a missing path is a 400, and every business outcome the
 * agent should be able to read comes back 200 `{ ok:false, error }`.
 *
 * Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import {
  defaultPublishArtifactDeps,
  publishArtifact,
} from "~/foh/artifacts.server";
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

  const path = typeof body.path === "string" ? body.path : "";
  const title = typeof body.title === "string" ? body.title : null;
  const kind = typeof body.kind === "string" ? body.kind : null;
  if (!path) {
    throw data(
      { ok: false, error: "Send the path of the file to publish." },
      { status: 400 },
    );
  }

  const result = await publishArtifact(
    { deploymentId, path, title, kind },
    defaultPublishArtifactDeps(),
  );
  return data(result);
}
