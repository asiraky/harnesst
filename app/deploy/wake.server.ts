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
import {
  recoverLiveDeployment,
  wakeStoppedDeployment,
} from "./liveness.server";

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
  deps: { store?: DataStore; deployTarget?: DeployTarget } = {},
): Promise<DeploymentWithRelease | null> {
  const store = deps.store ?? getRuntime().data;
  const deployTarget = deps.deployTarget ?? getRuntime().deployTarget;

  const rows = await store.deployments.listByEnvironment(environmentId);
  const [live] = await recoverLiveRows(rows, store, deployTarget);
  if (live) return live;

  for (const stopped of rows.filter((d) => d.status === "stopped")) {
    const recovered = await wakeStoppedDeployment(stopped, {
      store,
      deployTarget,
    });
    if (recovered?.url) return recovered;
  }
  return null;
}
