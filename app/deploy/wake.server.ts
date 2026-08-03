/**
 * Wake-on-demand for a single environment (Front of House §5): resolve the environment's live
 * deployment, starting a stopped (scaled-to-zero) instance when that's what it takes. Used by
 * the delegation relay (a stopped peer is woken, not denied) and the FOH stream route (opening
 * a session with a stopped agent wakes it).
 *
 * A persisted `live` row is health-checked before use. Definite negative answers recover through
 * the shared liveness path; inconclusive adapters preserve the row. A `stopped` row is started
 * and promoted only with the FRESH url. Returns null when nothing can be served or woken.
 */
import type { DataStore, DeploymentWithRelease } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget } from "~/seams/types";
import { recoverLiveDeployment, wakeStoppedDeployment } from "./liveness.server";

interface WakeDeps {
  store?: DataStore;
  deployTarget?: DeployTarget;
  /** Replace a stale live/stopped container with the same release and freshly-resolved env. */
  replaceStale?: (
    environmentId: string,
    deployment: DeploymentWithRelease,
  ) => Promise<DeploymentWithRelease | null>;
}

async function replaceStaleDeployment(
  environmentId: string,
  deployment: DeploymentWithRelease,
): Promise<DeploymentWithRelease | null> {
  const runtime = getRuntime();
  const { deployRelease } = await import("~/deploy/controller.server");
  let fresh: Awaited<ReturnType<typeof deployRelease>>;
  try {
    fresh = await deployRelease({
      environmentId,
      releaseId: deployment.releaseId,
    });
  } catch (error) {
    // Two simultaneous wakes can both observe the same stale row. The deployment uniqueness
    // guard elects one replacement; the loser waits for it instead of leaking a 500.
    const rows = await runtime.data.deployments.listByEnvironment(environmentId);
    if (rows.some((row) => row.status === "pending" || row.status === "building")) {
      return null;
    }
    throw error;
  }
  if (fresh.status !== "live") return null;

  if (deployment.status === "stopped") {
    // Scale-to-zero rows can retain their old traffic weight. Zero it before cleanup; the live
    // replacement is already serving and cleanup independently re-checks that fact.
    await runtime.data.deployments.updateIfStatus(deployment.id, "stopped", {
      trafficWeight: 0,
    });
    const { cleanupDeploymentContainer } =
      await import("~/deploy/cleanup.server");
    await cleanupDeploymentContainer(deployment.id);
  }
  const rows = await runtime.data.deployments.listByEnvironment(environmentId);
  return rows.find((row) => row.id === fresh.id) ?? null;
}

async function recoverLiveRows(
  rows: DeploymentWithRelease[],
  store: DataStore,
  deployTarget: DeployTarget,
): Promise<DeploymentWithRelease[]> {
  const recovered: DeploymentWithRelease[] = [];
  for (const live of rows.filter((d) => d.status === "live")) {
    const row = await recoverLiveDeployment(live, { store, deployTarget });
    if (row?.url) recovered.push(row);
  }
  return recovered;
}

/** Verify only rows already marked live; intentionally stopped rows remain scaled to zero. */
export async function refreshLiveDeploymentsForEnvironment(
  environmentId: string,
  deps: { store?: DataStore; deployTarget?: DeployTarget } = {},
): Promise<DeploymentWithRelease[]> {
  const store = deps.store ?? getRuntime().data;
  const deployTarget = deps.deployTarget ?? getRuntime().deployTarget;
  const rows = await store.deployments.listByEnvironment(environmentId);
  return recoverLiveRows(rows, store, deployTarget);
}

export async function ensureLiveDeploymentForEnvironment(
  environmentId: string,
  deps: WakeDeps = {},
): Promise<DeploymentWithRelease | null> {
  const store = deps.store ?? getRuntime().data;
  const deployTarget = deps.deployTarget ?? getRuntime().deployTarget;

  const [environment, rows] = await Promise.all([
    store.environments.findById(environmentId),
    store.deployments.listByEnvironment(environmentId),
  ]);
  if (!environment) return null;

  // Only reuse a container that resolved the latest desired env. Starting a stale stopped row is
  // exactly the silent failure this revision boundary prevents; a stale live row is excluded too,
  // so no new turn is deliberately routed to credentials the control plane knows are obsolete.
  const currentRows = rows.filter(
    (deployment) => deployment.envRevision >= environment.envRevision,
  );
  const [live] = await recoverLiveRows(currentRows, store, deployTarget);
  if (live) return live;

  if (
    rows.some(
      (deployment) =>
        deployment.status === "pending" || deployment.status === "building",
    )
  ) {
    return null;
  }

  const stale = rows.find(
    (deployment) =>
      (deployment.status === "live" || deployment.status === "stopped") &&
      deployment.envRevision < environment.envRevision,
  );
  if (stale) {
    return (deps.replaceStale ?? replaceStaleDeployment)(environmentId, stale);
  }

  for (const stopped of currentRows.filter((d) => d.status === "stopped")) {
    const recovered = await wakeStoppedDeployment(stopped, {
      store,
      deployTarget,
    });
    if (recovered?.url) return recovered;
  }
  return null;
}
