/**
 * Runtime model resolution for deployed agents —
 * `GET /api/gateway/v1/model-config?agent=<name>[&subagent=<a/b>][&project=<id>]`.
 *
 * A running agent's generated `harnesst/model.ts` calls this per step (with a short client-side
 * cache) to learn which model the workspace wants it on. The answer comes from the inheritance
 * chain in `~/models/agent-model-config.server`: the target's own override, else the nearest
 * ancestor's, else the workspace default. `subagent` names a declared subagent below the agent
 * root (issue #344); `project` scopes the lookup to one repo so two repos in a workspace can
 * hold an agent of the same name. Both are optional, and a legacy container that ships the
 * pre-#344 module asks with `?agent=` alone — it lands on the agent's own target and resolves
 * exactly as it always did.
 *
 * Auth mirrors the chat gateway: the org-scoped `HARNESST_MODEL_GATEWAY_TOKEN` (`edng_`) every
 * deploy injects — nothing but the org id is trusted from the client, so `project` is verified
 * to belong to that org before it scopes anything. A workspace with nothing configured gets a
 * 404 with a human-readable message the agent surfaces verbatim; that error is the designed
 * behavior, not a fallback: an unconfigured workspace cannot run any model.
 */
import type { LoaderFunctionArgs } from "react-router";

import { getProject } from "~/db/queries.server";
import { resolveTargetModel } from "~/models/agent-model-config.server";
import { findWorkspaceModel } from "~/models/union.server";
import { bearerToken, verifyGatewayToken } from "~/gateway/token.server";

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Normalize `?subagent=` to the stored shape: no leading/trailing/duplicate separators. */
function normalizeSubagentPath(raw: string | null): string {
  return (raw ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const token = bearerToken(request);
  const orgId = token ? verifyGatewayToken(token) : null;
  if (!orgId) return errorResponse("Missing or invalid gateway token.", 401);

  const params = new URL(request.url).searchParams;
  const agent = params.get("agent")?.trim();
  if (!agent) return errorResponse("Pass ?agent=<agent-name>.", 400);
  const subagentPath = normalizeSubagentPath(params.get("subagent"));
  const projectId = params.get("project")?.trim() || null;

  if (projectId && !(await getProject(orgId, projectId))) {
    return errorResponse(
      `The project "${projectId}" is not part of this workspace — redeploy the agent from ` +
        `harnesst so it carries the right project id.`,
      404,
    );
  }

  const resolved = await resolveTargetModel(orgId, {
    agentName: agent,
    subagentPath,
    projectId,
  });
  if (!resolved) {
    const target = subagentPath ? `${agent}/${subagentPath}` : agent;
    return errorResponse(
      `No model is configured for this workspace. Set a default model in harnesst's Org settings ` +
        `(or add a model override for the "${target}" agent), then retry — no redeploy is needed.`,
      404,
    );
  }

  // Best-effort catalog metadata: the context window rides along when the catalog knows the
  // model; a catalog hiccup must not take model resolution down with it.
  let contextWindowTokens: number | null = null;
  try {
    const info = await findWorkspaceModel(orgId, resolved.model);
    contextWindowTokens = info?.contextWindow ?? null;
  } catch {
    contextWindowTokens = null;
  }

  return new Response(
    JSON.stringify({
      model: resolved.model,
      effort: resolved.effort,
      contextWindowTokens,
      source: resolved.source,
    }),
    { headers: { "content-type": "application/json" } },
  );
}
