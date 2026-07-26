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
 * queue a rollback-style redeploy: `rollback: true` reuses the already-built image (no rebuild) but
 * re-creates the container with freshly-resolved env, which re-reads the grant and re-injects the
 * fresh refresh token via `connectionGrantEnv`. The grant is per-agent (environmentId null) and
 * shared across every environment, so we redeploy EVERY live environment.
 *
 * Three guards Aaron called out:
 *  - agent not currently deployed → connect only, no redeploy ("not-deployed").
 *  - the redeploy queue itself fails → surface it ("error"); the grant is already saved regardless.
 *  - staged drafts affecting this agent exist → do NOT silently redeploy the old committed version;
 *    return "staged" so the UI prompts the user to deliberately publish/redeploy. (Queueing an existing
 *    release never publishes drafts, but honoring the guard keeps the user in control of what goes live.)
 *
 * Deps are injected so the decision logic is unit-testable with fakes; `defaultDeps()` wires the
 * real server modules.
 */
import type { DraftChange, Environment, DeploymentWithRelease } from "~/data/ports";

export type RedeployAfterConnectOutcome =
  | { status: "not-deployed" }
  | { status: "staged" }
  | { status: "redeployed"; envNames: string[] }
  | { status: "error"; message: string };

export interface RedeployAfterConnectDeps {
  listDrafts: (projectId: string) => Promise<DraftChange[]>;
  listAgentEnvironments: (agentId: string) => Promise<Environment[]>;
  listDeployments: (environmentId: string) => Promise<DeploymentWithRelease[]>;
  ensureWorkerStarted: () => void;
  queueDeploy: (input: {
    environmentId: string;
    releaseId: string;
    rollback?: boolean;
    createdBy?: string | null;
  }) => Promise<unknown>;
}

function defaultDeps(): RedeployAfterConnectDeps {
  return {
    listDrafts: (projectId) =>
      import("~/drafts/drafts.server").then((m) => m.listDrafts(projectId)),
    listAgentEnvironments: (agentId) =>
      import("~/db/queries.server").then((m) => m.listAgentEnvironments(agentId)),
    listDeployments: (environmentId) =>
      import("~/deploy/controller.server").then((m) => m.listDeployments(environmentId)),
    ensureWorkerStarted: () => {
      void import("~/jobs/worker.server").then((m) => m.ensureWorkerStarted());
    },
    queueDeploy: (input) =>
      import("~/deploy/controller.server").then((m) => m.queueDeploy(input)),
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
      live.push({ envName: env.name, environmentId: env.id, releaseId: liveDep.releaseId });
    }
  }

  // 2. Nothing running → connect only.
  if (live.length === 0) return { status: "not-deployed" };

  // 3. Staged-changes guard: a draft affecting this agent (its own, or a shared/null-agent file)
  //    means redeploying the old committed version would ignore work the user hasn't published —
  //    hand it back to the UI to prompt, rather than silently redeploying.
  const drafts = await deps.listDrafts(input.projectId);
  const affectsAgent = drafts.some(
    (d) => d.agentId === input.agentId || d.agentId === null,
  );
  if (affectsAgent) return { status: "staged" };

  // 4. Queue an image-reusing redeploy per live environment (re-injects the fresh grant env).
  try {
    deps.ensureWorkerStarted();
    for (const l of live) {
      await deps.queueDeploy({
        environmentId: l.environmentId,
        releaseId: l.releaseId,
        rollback: true,
        createdBy: input.createdBy ?? null,
      });
    }
    return { status: "redeployed", envNames: live.map((l) => l.envName) };
  } catch (error) {
    return { status: "error", message: (error as Error).message };
  }
}
