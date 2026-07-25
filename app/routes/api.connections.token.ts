/**
 * Instance token broker endpoint (issue #167). An agent instance whose provider uses
 * "access-token-broker" credential delivery (rotating refresh grants — the instance never holds
 * the refresh token) POSTs `{ provider }` here with `Authorization: Bearer <EDEN_TEAM_TOKEN>`
 * (the same delegation token the team relay and Discord send proxy use — one instance-facing
 * auth story). The token authenticates the CALLER DEPLOYMENT; the control plane resolves its
 * deployment → environment → agent and returns a fresh access token + `expiresAt` for
 * (agent, provider), refreshing centrally and persisting the rotation (broker.server.ts).
 *
 * Bad token → 401; business outcomes ride the BrokerResult's status with a readable `error`
 * so the shipped credentials binding can surface the text. Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { brokerAccessToken } from "~/connections/broker.server";
import { getRuntime } from "~/seams/index.server";
import { verifyDelegationToken } from "~/team/token.server";

export async function action({ request }: ActionFunctionArgs) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return data(
      { ok: false, error: "Send a JSON body with `provider`." },
      { status: 400 },
    );
  }
  const provider =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { provider?: unknown }).provider
      : undefined;
  if (typeof provider !== "string" || provider.length === 0) {
    return data(
      { ok: false, error: "Send a JSON body with `provider`." },
      { status: 400 },
    );
  }

  // Resolve the caller from the token's deployment: deployment → env → agent (the exact
  // pattern of the Discord send proxy). Nothing but the deployment id is trusted from the client.
  const store = getRuntime().data;
  const deployment = await store.deployments.findById(deploymentId);
  const env = deployment
    ? await store.environments.findById(deployment.environmentId)
    : null;
  const agent = env ? await store.agents.findById(env.agentId) : null;
  if (!agent) {
    return data(
      { ok: false, error: "Your deployment is no longer known to harnesst." },
      { status: 403 },
    );
  }

  const result = await brokerAccessToken({
    projectId: agent.projectId,
    agentId: agent.id,
    provider,
  });
  if (!result.ok) {
    return data({ ok: false, error: result.error }, { status: result.status });
  }
  return data({
    ok: true,
    accessToken: result.accessToken,
    expiresAt: result.expiresAt,
  });
}
