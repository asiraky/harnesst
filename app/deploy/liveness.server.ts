/**
 * Reconcile persisted deployment state with the active DeployTarget.
 *
 * A `live` database row is desired state, but local Docker containers do not survive daemon or
 * host restarts. Only definite negative health answers are actionable: several deploy adapters
 * intentionally return `pending`, and a transient probe failure must not take a working remote
 * instance offline. A dead instance stays `live` but loses its stale URL while it starts, then is
 * refreshed only with the URL returned by `start()` (Docker may assign a new host port). Keeping
 * the status live during that transition lets a concurrent deploy cutover see and drain it.
 */
import type { DataStore, DeploymentWithRelease } from "~/data/ports";
import type { DeployTarget, InstanceHealth } from "~/seams/types";

interface LivenessDeps {
  store: DataStore;
  deployTarget: DeployTarget;
}

function failedHealth(error: unknown): InstanceHealth {
  return {
    status: "failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** Revalidate the historical artifact on restart, even if its Release has since been rebuilt. */
async function startWithProvenance(deployment: DeploymentWithRelease, deps: LivenessDeps) {
  // Listing rows carry compact evidence only; load the full historical manifest once per wake.
  const snapshot = (await deps.store.deployments.findById(deployment.id))?.artifactProvenance;
  if (deployment.artifactProvenance && !snapshot) {
    throw new Error("Artifact verification failed: deployment source manifest is unavailable. Redeploy to rebuild and verify this release.");
  }
  return snapshot
    ? deps.deployTarget.start(deployment.id, snapshot)
    : deps.deployTarget.start(deployment.id); // Legacy instances and assistant have no manifest.
}

/** Wake a row already persisted as stopped, promoting it only when the target returns a URL. */
export async function wakeStoppedDeployment(
  stopped: DeploymentWithRelease,
  deps: LivenessDeps,
): Promise<DeploymentWithRelease | null> {
  const health = await startWithProvenance(stopped, deps).catch(failedHealth);
  if (health.status !== "live" || !health.url) {
    await deps.store.deployments.updateIfStatus(stopped.id, "stopped", {
      errorDetail: health.detail ?? null,
    });
    return null;
  }

  const promoted = await deps.store.deployments.updateIfStatus(
    stopped.id,
    "stopped",
    { status: "live", url: health.url },
  );
  if (!promoted) return null;
  return { ...stopped, status: "live", url: health.url };
}

/**
 * Verify a row persisted as live and restore it when the target reports a definite negative.
 * `pending` and thrown probes preserve the row for adapters that cannot answer health yet.
 */
export async function recoverLiveDeployment(
  live: DeploymentWithRelease,
  deps: LivenessDeps,
): Promise<DeploymentWithRelease | null> {
  if (live.status !== "live") return null;

  if (live.url) {
    let health: InstanceHealth | null = null;
    try {
      health = await deps.deployTarget.health(live.id);
    } catch {
      // An inconclusive probe cannot safely demote remote targets. Preserve today's behaviour.
      return live;
    }

    if (health.status !== "stopped" && health.status !== "failed") {
      // A capable target may report a corrected URL even when the instance stayed live.
      if (health.status === "live" && health.url && health.url !== live.url) {
        const refreshed = await deps.store.deployments.updateIfStatus(
          live.id,
          "live",
          { url: health.url },
        );
        return refreshed ? { ...live, url: health.url } : null;
      }
      return live;
    }
  }

  // Clear the unusable address but keep desired state `live`: cutover only discovers live
  // siblings, so temporarily demoting here would let it miss and then resurrect this old row.
  const claimed = await deps.store.deployments.updateIfStatus(live.id, "live", {
    url: null,
  });
  if (!claimed) return null;

  const woke = await startWithProvenance(live, deps).catch(failedHealth);
  if (woke.status === "live" && woke.url) {
    const refreshed = await deps.store.deployments.updateIfStatus(
      live.id,
      "live",
      { url: woke.url },
    );
    return refreshed ? { ...live, url: woke.url } : null;
  }

  // An unwakeable desired-live row becomes resumable. If cutover moved it meanwhile, its newer
  // lifecycle state wins and the compare-and-set leaves it alone.
  await deps.store.deployments.updateIfStatus(live.id, "live", {
    status: "stopped",
    url: null,
    errorDetail: woke.detail ?? null,
  });
  return null;
}

export interface LiveDeploymentReconcileResult {
  checked: number;
  live: number;
  stopped: number;
}

/**
 * Boot sweep for every environment, including ordinary agents and internal assistants. Rows that
 * were live before a host restart are restored immediately; unwakeable rows remain resumable as
 * `stopped` with no stale URL.
 */
export async function reconcileLiveDeployments(
  deps: LivenessDeps,
): Promise<LiveDeploymentReconcileResult> {
  const result: LiveDeploymentReconcileResult = {
    checked: 0,
    live: 0,
    stopped: 0,
  };
  const environments = await deps.store.environments.listAll();
  for (const environment of environments) {
    const rows = await deps.store.deployments.listByEnvironment(environment.id);
    for (const row of rows.filter(
      (deployment) =>
        deployment.status === "live" &&
        deployment.envRevision >= environment.envRevision,
    )) {
      result.checked++;
      const recovered = await recoverLiveDeployment(row, deps);
      if (recovered) {
        result.live++;
        continue;
      }
      const current = await deps.store.deployments.findById(row.id);
      if (current?.status === "stopped") result.stopped++;
    }
  }
  return result;
}
