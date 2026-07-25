/**
 * Deployment container cleanup.
 *
 * Deployment rows remain as history and release images remain for rollback. This only reaps the
 * per-deployment runtime container after the deployment is no longer a possible traffic target.
 */
import type { DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget } from "~/seams/types";

export const DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS = Number(
  process.env.HARNESST_DEPLOYMENT_CLEANUP_GRACE_MS || 24 * 60 * 60 * 1000,
);

export interface DeploymentCleanupDeps {
  store: DataStore;
  deployTarget: DeployTarget;
}

function cleanupDeps(): DeploymentCleanupDeps {
  const r = getRuntime();
  return { store: r.data, deployTarget: r.deployTarget };
}

export type DeploymentCleanupResult =
  { status: "destroyed" } | { status: "skipped"; reason: string };

function hasLiveReplacement(
  deploymentId: string,
  siblings: { id: string; status: string }[],
): boolean {
  return siblings.some((d) => d.id !== deploymentId && d.status === "live");
}

/**
 * Re-checks the row at execution time. A delayed cleanup job may run after rollback/redeploy
 * activity, so scheduling alone is never treated as proof that a container is safe to remove.
 */
export async function cleanupDeploymentContainer(
  deploymentId: string,
  deps: DeploymentCleanupDeps = cleanupDeps(),
): Promise<DeploymentCleanupResult> {
  const deployment = await deps.store.deployments.findById(deploymentId);
  if (!deployment) return { status: "skipped", reason: "deployment not found" };

  if (deployment.status === "failed") {
    await (deps.deployTarget.destroy?.(deployment.id) ??
      deps.deployTarget.stop(deployment.id));
    return { status: "destroyed" };
  }

  if (deployment.status !== "stopped") {
    return { status: "skipped", reason: `deployment is ${deployment.status}` };
  }

  if (deployment.trafficWeight !== 0) {
    return { status: "skipped", reason: "deployment still has traffic weight" };
  }

  const siblings = await deps.store.deployments.listByEnvironment(
    deployment.environmentId,
  );
  if (!hasLiveReplacement(deployment.id, siblings)) {
    return { status: "skipped", reason: "no live replacement in environment" };
  }

  await (deps.deployTarget.destroy?.(deployment.id) ??
    deps.deployTarget.stop(deployment.id));
  return { status: "destroyed" };
}
