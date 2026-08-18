/**
 * Blue-green drain of a superseded deployment (issue #81).
 *
 * A redeploy stands the new container up alongside the old and — at cutover (controller.server.ts)
 * — flips the old row to `draining`. That single status change does two things without any routing
 * code: it removes the row from every `status === "live"` query (splitter, Discord relay, playground,
 * team ask), so all NEW inbound work goes to the new container immediately; and it closes
 * `ingestRunStart`'s run-start gate, so no new `running` run row can attach to the old deployment.
 *
 * The old container keeps running only to FINISH in-flight turns (a turn can legitimately run for
 * hours; reply delivery is outbound and needs no inbound traffic). This watcher polls the runs
 * table and stops the container once it shows no `running` rows — or once a hard drain ceiling
 * (24h by default) passes, at which point any still-running turn is killed VISIBLY (marked
 * `failed` with an interruption error in Runs) rather than force-killed silently on a 5s docker
 * timeout. The poll runs every 30s for the first hour, then backs off (issue #375) — a drain
 * that old is waiting on a marathon turn, not a fast-settling one.
 *
 * Mirrors cleanup.server.ts's shape: a deps interface with a `getRuntime()` default, a re-check at
 * execution time (scheduling is never proof), and a result union. Shares the DeployTarget stop
 * helper with the controller (moved here so the import direction stays acyclic: controller → drain).
 */
import type { DataStore } from "~/data/ports";
import { enqueue } from "~/jobs/queue.server";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget } from "~/seams/types";
import { DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS } from "./cleanup.server";

/** Hard ceiling: a turn still running this long after cutover is reaped so the drain always ends. */
export const DEPLOYMENT_DRAIN_CEILING_MS = Number(
  process.env.HARNESST_DEPLOYMENT_DRAIN_CEILING_MS || 24 * 60 * 60 * 1000,
);

/** How often the drain watcher re-checks the runs table for the deployment going idle. */
export const DEPLOYMENT_DRAIN_POLL_MS = Number(
  process.env.HARNESST_DEPLOYMENT_DRAIN_POLL_MS || 30 * 1000,
);

/** Slower re-check cadence once a drain has been waiting longer than the backoff threshold. */
export const DEPLOYMENT_DRAIN_POLL_SLOW_MS = Number(
  process.env.HARNESST_DEPLOYMENT_DRAIN_POLL_SLOW_MS || 5 * 60 * 1000,
);

/** How long a drain polls at the fast cadence before backing off to the slow one. */
export const DEPLOYMENT_DRAIN_BACKOFF_AFTER_MS = 60 * 60 * 1000;

/**
 * The delay until a drain's next poll: 30s while the drain is young (most turns settle in
 * minutes — stop the old container promptly), then 5min once it has waited past the backoff
 * threshold (with a 24h ceiling, per-30s polls would be ~2,880 no-op jobs per drained container).
 */
export function drainPollDelayMs(now: number, drainStartedAt: number): number {
  return now - drainStartedAt < DEPLOYMENT_DRAIN_BACKOFF_AFTER_MS
    ? DEPLOYMENT_DRAIN_POLL_MS
    : DEPLOYMENT_DRAIN_POLL_SLOW_MS;
}

/** True while an instance is (or is becoming) a live traffic target — used to confirm a stop took. */
function deploymentStillActive(status: string): boolean {
  return status === "live" || status === "starting" || status === "pending";
}

/**
 * Stop a deployment's runtime infra and confirm it is actually down. `stop` first (graceful), then
 * `destroy` as the fallback both when stop throws and when health shows the instance still active.
 * Shared by the drain watcher (here) and the controller's failed-new-deployment cleanup.
 */
export async function stopDeploymentInfra(
  deployTarget: DeployTarget,
  deploymentId: string,
): Promise<void> {
  try {
    await deployTarget.stop(deploymentId);
  } catch (stopError) {
    if (!deployTarget.destroy) throw stopError;
    await deployTarget.destroy(deploymentId);
  }

  const health = await deployTarget.health(deploymentId);
  if (!deploymentStillActive(health.status)) return;

  if (deployTarget.destroy) {
    await deployTarget.destroy(deploymentId);
    const afterDestroy = await deployTarget.health(deploymentId);
    if (!deploymentStillActive(afterDestroy.status)) return;
    throw new Error(
      `deployment ${deploymentId} is still ${afterDestroy.status} after destroy`,
    );
  }

  throw new Error(`deployment ${deploymentId} is still ${health.status} after stop`);
}

/**
 * Enqueue the delayed container-reap once a drained deployment has actually stopped. Copies the
 * controller's old cleanup scheduling: best-effort (a scheduling hiccup must not undo the stop) and
 * re-checked at execution time by cleanupDeploymentContainer (which correctly skips a `draining` row
 * and only reaps a `stopped`/`failed` one with a live replacement).
 */
async function scheduleDeploymentContainerCleanup(
  store: DataStore,
  deploymentId: string,
): Promise<void> {
  const runAt = new Date(Date.now() + Math.max(0, DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS));
  try {
    await enqueue("cleanup_deployment_container", { deploymentId }, { runAt, maxAttempts: 3 }, store);
  } catch (error) {
    console.warn("[deploy] failed to schedule deployment container cleanup", error);
  }
}

export interface DrainDeps {
  store: DataStore;
  deployTarget: DeployTarget;
}

function drainDeps(): DrainDeps {
  const r = getRuntime();
  return { store: r.data, deployTarget: r.deployTarget };
}

export type DrainResult =
  | { status: "stopped"; interruptedRuns: number }
  | { status: "waiting"; runningRuns: number }
  | { status: "skipped"; reason: string };

/**
 * Schedule the first poll of the drain watcher for a just-superseded deployment. Best-effort, like
 * the old container-cleanup scheduling: a lost job leaves a VISIBLE `draining` row (the debuggable
 * failure surface) rather than failing the cutover after the new deployment is already live. The
 * ceiling is carried in the payload so every re-enqueue shares one deadline anchored at cutover;
 * `drainStartedAt` (also anchored at cutover) is what the poll backoff measures elapsed from.
 */
export async function scheduleDeploymentDrain(
  store: DataStore,
  deploymentId: string,
  deadlineAt: Date,
): Promise<void> {
  const runAt = new Date(Date.now() + DEPLOYMENT_DRAIN_POLL_MS);
  try {
    await enqueue(
      "drain_deployment",
      {
        deploymentId,
        deadlineAt: deadlineAt.toISOString(),
        drainStartedAt: new Date().toISOString(),
      },
      { runAt, maxAttempts: 3 },
      store,
    );
  } catch (error) {
    console.warn("[deploy] failed to schedule deployment drain", error);
  }
}

/**
 * One tick of the drain watcher. Re-reads the row (scheduling is never proof it should still run),
 * checks the runs table, and either waits (re-enqueuing the next poll) or stops the container.
 *
 * Ordering note: the run-start gate closed when the row flipped to `draining` at cutover, so no new
 * `running` row can appear here. On the stop path we stop infra FIRST, then reconcile the runs table
 * — matching the old cutover order — so the container is down before we mark its turns failed.
 */
export async function drainDeployment(
  payload: {
    deploymentId: string;
    deadlineAt: string;
    /**
     * When the drain began (cutover time) — what the poll backoff measures elapsed from.
     * Optional for jobs enqueued before this field existed: absent → treat as "started now",
     * which conservatively polls fast and converges once the next re-enqueue writes the field.
     * Never derive it from `deadlineAt - ceiling`: an in-flight job may carry an old ceiling.
     */
    drainStartedAt?: string;
  },
  deps: DrainDeps = drainDeps(),
): Promise<DrainResult> {
  const { store, deployTarget } = deps;
  const deployment = await store.deployments.findById(payload.deploymentId);
  if (!deployment) return { status: "skipped", reason: "deployment not found" };
  // Something else already settled this row — env teardown, a different lifecycle path, or a
  // previous drain tick that already stopped it. Only a `draining` row is ours to reap.
  if (deployment.status !== "draining") {
    return { status: "skipped", reason: `deployment is ${deployment.status}` };
  }

  const running = await store.runs.countRunningByDeployment(payload.deploymentId);
  if (running > 0 && Date.now() < Date.parse(payload.deadlineAt)) {
    // Still finishing in-flight turns and under the ceiling: keep the container up and poll again.
    // A failed re-enqueue here THROWS (unlike the best-effort initial schedule) so the worker
    // retries this drain tick rather than silently abandoning a live container.
    const startedAt = payload.drainStartedAt ?? new Date().toISOString();
    await enqueue(
      "drain_deployment",
      {
        deploymentId: payload.deploymentId,
        deadlineAt: payload.deadlineAt,
        drainStartedAt: startedAt,
      },
      {
        // Capped at the deadline: a slow-interval poll scheduled just under the ceiling must
        // not overshoot it by up to five minutes — the ceiling is a hard promise.
        runAt: new Date(
          Math.min(
            Date.now() + drainPollDelayMs(Date.now(), Date.parse(startedAt)),
            Date.parse(payload.deadlineAt),
          ),
        ),
        maxAttempts: 3,
      },
      store,
    );
    return { status: "waiting", runningRuns: running };
  }

  // Idle, or the ceiling has passed: stop the container, then reconcile.
  await stopDeploymentInfra(deployTarget, payload.deploymentId);
  await store.deployments.update(payload.deploymentId, {
    status: "stopped",
    trafficWeight: 0,
    errorDetail: null,
  });
  let interrupted = 0;
  try {
    interrupted = await store.runs.failRunningByDeployment(
      payload.deploymentId,
      "Run interrupted because its deployment kept running past the redeploy drain window and was shut down.",
    );
  } catch (error) {
    // Infra lifecycle is authoritative. A telemetry bookkeeping failure must not turn a completed
    // stop into a job failure after the container has already gone down.
    console.warn(
      `[deploy] failed to reconcile running runs for drained deployment ${payload.deploymentId}`,
      error,
    );
  }
  await scheduleDeploymentContainerCleanup(store, payload.deploymentId);
  return { status: "stopped", interruptedRuns: interrupted };
}
