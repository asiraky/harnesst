/**
 * Shared Playground plumbing used by both the page route and the streaming resource route:
 * the tenancy-guarded list of live deployments to talk to. Keeping this in one place means
 * the stream route enforces the exact same "live + belongs to this agent" guard the page has.
 */
import { listDeployments } from "~/deploy/controller.server";
import { refreshLiveDeploymentsForEnvironment } from "~/deploy/wake.server";
import { listAgentEnvironments } from "~/db/queries.server";

/** A live deployment this agent can be talked to, tagged with the release it serves. */
export interface Target {
  deploymentId: string;
  environmentId: string;
  releaseId: string;
  url: string;
  version: string;
  environmentName: string;
  /** The commit the deployment's release was built from — what is ACTUALLY running. */
  gitSha: string;
}

/** Every live deployment belonging to this agent (across its environments). */
export async function liveTargets(agentId: string): Promise<Target[]> {
  const envs = await listAgentEnvironments(agentId);
  const perEnv = await Promise.all(
    envs.map(async (env) => {
      // Target resolution is operational, not a passive status peek: verify persisted live rows
      // before handing their URLs to callers. Intentionally stopped rows stay scaled to zero.
      await refreshLiveDeploymentsForEnvironment(env.id);
      const deployments = await listDeployments(env.id);
      return deployments.flatMap((d) =>
        d.status === "live" && d.url
          ? [
              {
                deploymentId: d.id,
                environmentId: env.id,
                releaseId: d.releaseId,
                url: d.url,
                version: d.version,
                environmentName: env.name,
                gitSha: d.gitSha,
              },
            ]
          : [],
      );
    }),
  );
  return perEnv.flat();
}
