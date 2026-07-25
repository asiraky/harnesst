/**
 * Runtime model resolution for deployed agents — `GET /api/gateway/v1/model-config?agent=<name>`.
 *
 * A running agent's generated `eden-model.ts` calls this per step (with a short client-side
 * cache) to learn which model the workspace wants it on: the org's per-agent override for
 * `agent`, else the workspace default model, resolved in `~/models/agent-model-config.server`.
 * Subagents ask with their PARENT agent's name, so they always match the parent.
 *
 * Auth mirrors the chat gateway: the org-scoped `EDEN_MODEL_GATEWAY_TOKEN` (`edng_`) every
 * deploy injects — nothing but the org id is trusted from the client. A workspace with nothing
 * configured gets a 404 with a human-readable message the agent surfaces verbatim; that error
 * is the designed behavior, not a fallback: an unconfigured workspace cannot run any model.
 */
import type { LoaderFunctionArgs } from "react-router";

import { resolveAgentModel } from "~/models/agent-model-config.server";
import { findWorkspaceModel } from "~/models/union.server";
import { bearerToken, verifyGatewayToken } from "~/gateway/token.server";

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const token = bearerToken(request);
  const orgId = token ? verifyGatewayToken(token) : null;
  if (!orgId) return errorResponse("Missing or invalid gateway token.", 401);

  const agent = new URL(request.url).searchParams.get("agent")?.trim();
  if (!agent) return errorResponse("Pass ?agent=<agent-name>.", 400);

  const resolved = await resolveAgentModel(orgId, agent);
  if (!resolved) {
    return errorResponse(
      `No model is configured for this workspace. Set a default model in harnesst's Org settings ` +
        `(or add a model override for the "${agent}" agent), then retry — no redeploy is needed.`,
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
