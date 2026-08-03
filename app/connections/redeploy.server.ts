/**
 * Auto-redeploy after connect/reconnect (issue #69).
 *
 * The per-provider `<PREFIX>_OAUTH_*` env an agent needs to talk to a connected provider is
 * injected ONLY at deploy time (`connectionGrantEnv` inside `deployRelease`). So after a user
 * reconnects a provider from the Deployment tab, the grant row flips to "active" but the RUNNING
 * container still holds the old (or no) credentials until the next deploy — the exact gap that
 * made "Google Sheets connection is not configured" show up at runtime despite an "active" grant.
 *
 * Aaron's direction (issue #69, 2026-07-10): no banner/nudge — the connect/reconnect action ITSELF
 * performs the redeployment. When the OAuth flow completes and the agent has a live deployment, we
 * invalidate every environment through the general env reconciler. It reuses the already-built
 * image but re-creates the container with freshly-resolved env, which re-reads the grant and
 * re-injects the fresh refresh token via `connectionGrantEnv`.
 *
 * Two outcomes remain guarded:
 *  - agent not currently deployed → connect only, no redeploy ("not-deployed").
 *  - the redeploy queue itself fails → surface it ("error"); the grant is already saved regardless.
 * Staged drafts no longer suppress invalidation (#236): replacing a container with its already-live
 * release does not publish those drafts, while suppressing the desired revision can freeze stale
 * credentials indefinitely.
 *
 * Deps are injected so the decision logic is unit-testable with fakes; `defaultDeps()` wires the
 * real server modules.
 */
import type { Environment, DeploymentWithRelease } from "~/data/ports";
import { invalidateAgentEnvironments } from "~/deploy/env-reconcile.server";

export type RedeployAfterConnectOutcome =
  | { status: "not-deployed" }
  | { status: "redeployed"; envNames: string[] }
  | { status: "error"; message: string };

export interface RedeployAfterConnectDeps {
  listAgentEnvironments: (agentId: string) => Promise<Environment[]>;
  listDeployments: (environmentId: string) => Promise<DeploymentWithRelease[]>;
  invalidate: typeof invalidateAgentEnvironments;
}

function defaultDeps(): RedeployAfterConnectDeps {
  return {
    listAgentEnvironments: (agentId) => import("~/db/queries.server").then((m) => m.listAgentEnvironments(agentId)),
    listDeployments: (environmentId) =>
      import("~/deploy/controller.server").then((m) => m.listDeployments(environmentId)),
    invalidate: invalidateAgentEnvironments,
  };
}

/**
 * Decide and (when appropriate) queue an image-reusing redeploy of every live environment for an
 * agent, so a just-saved connection grant reaches the running container. Never throws: queue errors
 * become an `{ status: "error" }` outcome so the caller can surface them without losing the grant.
 */
export async function redeployAfterConnect(
  input: { projectId: string; agentId: string; createdBy?: string | null },
  deps: RedeployAfterConnectDeps = defaultDeps(),
): Promise<RedeployAfterConnectOutcome> {
  // 1. Find live deployments across all of the agent's environments (staging + production + …).
  const environments = await deps.listAgentEnvironments(input.agentId);
  const live: { envName: string; environmentId: string; releaseId: string }[] = [];
  for (const env of environments) {
    const deployments = await deps.listDeployments(env.id);
    const liveDep = deployments.find((d) => d.status === "live");
    if (liveDep) {
      live.push({
        envName: env.name,
        environmentId: env.id,
        releaseId: liveDep.releaseId,
      });
    }
  }

  // 2. Nothing running → still invalidate desired env so a stopped container is replaced rather
  //    than started with stale credentials on its next wake; there is simply no live redeploy now.
  if (live.length === 0) {
    try {
      await deps.invalidate({
        agentIds: [input.agentId],
        createdBy: input.createdBy ?? null,
      });
      return { status: "not-deployed" };
    } catch (error) {
      return { status: "error", message: (error as Error).message };
    }
  }

  // 3. Persist desired-env invalidation; the durable reconciler coalesces races and redeploys.
  try {
    await deps.invalidate({
      agentIds: [input.agentId],
      createdBy: input.createdBy ?? null,
    });
    return { status: "redeployed", envNames: live.map((l) => l.envName) };
  } catch (error) {
    return { status: "error", message: (error as Error).message };
  }
}
