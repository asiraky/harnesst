/**
 * Agent-facing read of the repository's published artifacts (the `team-artifacts` tool). Bad
 * bearer → 401; every model-readable failure → 200 `{ ok:false }`. Requests are a few fields of
 * JSON, so anything past 64 KB is refused rather than read.
 */
import { data, type ActionFunctionArgs } from "react-router";

import { runTeamArtifactOperation } from "~/foh/team-artifacts.server";
import { verifyDelegationToken } from "~/team/token.server";

const MAX_REQUEST_BYTES = 64 * 1024;

export async function action({ request }: ActionFunctionArgs) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) {
    return data({ ok: false, error: "The artifact request is too large." });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return data({
      ok: false,
      error: "Send the artifact operation as a JSON body.",
    });
  }
  return data(await runTeamArtifactOperation(deploymentId, body));
}
