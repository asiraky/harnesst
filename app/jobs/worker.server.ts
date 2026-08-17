/**
 * In-process job worker. Polls the queue and executes handlers; started once per server
 * process via ensureWorkerStarted() (HMR/multi-import safe through a globalThis guard, same
 * pattern as the db client). For v1 the worker lives inside the web process — one box, one
 * process (ARCH §2); it moves to a dedicated process/container by just importing and calling
 * startWorker() elsewhere.
 *
 * Concurrency: one claim loop, with deploy/rollback jobs dispatched into a bounded in-flight
 * pool (HARNESST_DEPLOY_CONCURRENCY, default 3) so an N-member team's deploys overlap instead
 * of running back-to-back (issue #375). Same-environment serialization is enforced at QUEUE
 * time by the `deployments_env_inflight_uq` index (queueDeploy inserts the pending deployment
 * row before the job exists), so two claimable deploy jobs are always different environments.
 * Every other kind still runs strictly serially, awaited inline in the claim loop.
 */
import type { DataStore } from "~/data/ports";
import { deployRelease, rollbackTo } from "~/deploy/controller.server";
import { reconcileLiveDeployments } from "~/deploy/liveness.server";
import { ensureSandboxReaperStarted } from "~/deploy/sandbox-reaper.server";
import { concurrencyFromEnv } from "~/lib/concurrency";
import { PUBLISH_INTERRUPTED_MESSAGE } from "~/publish/pipeline.server";
import { getRuntime } from "~/seams/index.server";
import type { DeployReleasePayload, Job } from "./queue.server";
import { claimNext, enqueue, markDone, markFailed } from "./queue.server";

const POLL_MS = Number(process.env.HARNESST_WORKER_POLL_MS ?? 2000);

/** Deploy/rollback jobs in flight at once; 1 restores the old strictly-serial worker. */
const DEPLOY_CONCURRENCY = concurrencyFromEnv(process.env.HARNESST_DEPLOY_CONCURRENCY, 3);

/** The pooled kinds. Everything else runs inline — builds and publishes stay serial. */
const POOLED_KINDS = new Set<Job["kind"]>(["deploy_release", "rollback_release"]);

async function execute(job: Job): Promise<void> {
  switch (job.kind) {
    case "deploy_release":
    case "rollback_release": {
      const p = job.payload as DeployReleasePayload;
      const dep =
        job.kind === "deploy_release"
          ? await deployRelease(p)
          : await rollbackTo(p);
      // A deployment that records `failed` is a real outcome, not a queue error — but
      // surfacing it as a job failure gets retries for transient build/docker flakes.
      if (dep.status === "failed") {
        // A desired-env replacement must not leave the environment permanently stale after the
        // ordinary deploy retries are exhausted. Re-enter reconciliation later; it will no-op if
        // another deployment fixed the revision meanwhile.
        if (job.attempts >= job.maxAttempts) {
          await enqueue(
            "reconcile_environment_env",
            {
              environmentId: p.environmentId,
              createdBy: p.createdBy ?? null,
            },
            { runAt: new Date(Date.now() + 30_000) },
          );
        }
        throw new Error(dep.errorDetail ?? "deployment failed");
      }
      return;
    }
    case "assistant_deploy": {
      const { runAssistantDeploy } =
        await import("~/assistant/instance.server");
      const p = job.payload as { projectId: string };
      const res = await runAssistantDeploy(p);
      if (res.status === "failed") {
        throw new Error("assistant deployment failed");
      }
      return;
    }
    case "assistant_restart": {
      // Config-change refresh: stop/start so the entrypoint re-fetches the bundle and rebuilds.
      // Best-effort — a missing instance is a no-op (it provisions on next use), never a retry.
      const { restartAssistantInstance } =
        await import("~/assistant/instance.server");
      const p = job.payload as { projectId: string };
      await restartAssistantInstance(p.projectId);
      return;
    }
    case "reconcile_environment_env": {
      const { reconcileEnvironmentEnv } =
        await import("~/deploy/env-reconcile.server");
      const p = job.payload as { environmentId?: string; createdBy?: string | null };
      if (!p.environmentId) throw new Error("env reconcile job missing environmentId");
      const result = await reconcileEnvironmentEnv({
        environmentId: p.environmentId,
        createdBy: p.createdBy,
      });
      console.log(`[jobs] reconciled env ${p.environmentId}: ${result.status}`);
      return;
    }
    case "cleanup_deployment_container": {
      const { cleanupDeploymentContainer } =
        await import("~/deploy/cleanup.server");
      const p = job.payload as { deploymentId?: string };
      if (!p.deploymentId) throw new Error("cleanup job missing deploymentId");
      const result = await cleanupDeploymentContainer(p.deploymentId);
      if (result.status === "skipped") {
        console.log(
          `[jobs] skipped cleanup_deployment_container ${p.deploymentId}: ${result.reason}`,
        );
      }
      return;
    }
    case "drain_deployment": {
      const { drainDeployment } = await import("~/deploy/drain.server");
      const p = job.payload as {
        deploymentId?: string;
        deadlineAt?: string;
        drainStartedAt?: string;
      };
      if (!p.deploymentId) throw new Error("drain job missing deploymentId");
      if (!p.deadlineAt) throw new Error("drain job missing deadlineAt");
      // A `waiting` result is a SUCCESS: the tick re-enqueued its own successor, so this job is
      // done. Only a thrown error (e.g. the container refused to stop) is a retry.
      // drainStartedAt stays optional: jobs enqueued before the poll backoff existed lack it.
      const result = await drainDeployment({
        deploymentId: p.deploymentId,
        deadlineAt: p.deadlineAt,
        drainStartedAt: p.drainStartedAt,
      });
      const detail =
        result.status === "waiting"
          ? `waiting (${result.runningRuns} running)`
          : result.status === "stopped"
            ? `stopped (${result.interruptedRuns} interrupted)`
            : `skipped: ${result.reason}`;
      console.log(`[jobs] drain_deployment ${p.deploymentId}: ${detail}`);
      return;
    }
    case "reattach_delegation": {
      const { reattachDelegation } = await import("~/team/reattach.server");
      const p =
        job.payload as unknown as import("~/team/reattach.server").ReattachPayload;
      if (!p.sessionId || !p.delegationId) {
        throw new Error("reattach job missing sessionId/delegationId");
      }
      // Like the drain: a `waiting` result is a SUCCESS — the tick enqueued its own successor.
      const result = await reattachDelegation(p);
      const detail =
        result.status === "waiting"
          ? `waiting (index ${result.streamIndex})`
          : result.status === "settled"
            ? `settled (${result.outcome})`
            : result.status === "expired"
              ? "expired at the reattach ceiling"
              : `skipped: ${result.reason}`;
      console.log(`[jobs] reattach_delegation ${p.delegationId}: ${detail}`);
      return;
    }
    case "publish": {
      // issue #225: the publish pipeline (check → build → commit → version → deploy). Progress and
      // failures surface through the workspace task's steps, not queue retries (maxAttempts:1).
      const { runPublish } = await import("~/publish/pipeline.server");
      const p =
        job.payload as import("~/publish/pipeline.server").PublishPayload;
      await runPublish(p);
      return;
    }
    default:
      throw new Error(`Unknown job kind: ${job.kind}`);
  }
}

/** The claim loop's injected seams — production wiring in startWorker, scripted in tests. */
export interface WorkerDeps {
  claim: () => Promise<Job | null>;
  execute: (job: Job) => Promise<void>;
  complete: (jobId: string) => Promise<void>;
  fail: (job: Job, error: string) => Promise<void>;
  deployConcurrency: number;
}

/** Run one claimed job to completion. Never throws: a failed `fail` write is only logged —
 *  a pooled job's rejection would otherwise surface as an unhandled rejection. */
async function runJob(job: Job, deps: WorkerDeps): Promise<void> {
  try {
    await deps.execute(job);
    await deps.complete(job.id);
    console.log(`[jobs] done ${job.kind} ${job.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[jobs] ${job.kind} ${job.id} attempt ${job.attempts} failed: ${msg}`,
    );
    try {
      await deps.fail(job, msg);
    } catch (failErr) {
      console.error(`[jobs] failed to record failure for ${job.id}:`, failErr);
    }
  }
}

/**
 * One pass over the queue: claim jobs until none are due. Deploy/rollback jobs are dispatched
 * into `inflight` (bounded by deployConcurrency) and NOT awaited — they keep running across
 * passes, and the caller's interval starts the next pass regardless. All other kinds run inline,
 * strictly serially. Exported as the worker's test seam.
 */
export async function processQueue(
  deps: WorkerDeps,
  inflight: Set<Promise<void>>,
): Promise<void> {
  for (;;) {
    let job: Job | null = null;
    try {
      job = await deps.claim();
    } catch (err) {
      console.error("[jobs] claim failed:", err);
      return;
    }
    if (!job) return;
    if (POOLED_KINDS.has(job.kind)) {
      // The job is already claimed, so a full pool means WAIT for a slot (never run over-bound,
      // never un-claim). runJob never rejects, so racing the pool is safe.
      while (inflight.size >= Math.max(1, deps.deployConcurrency)) {
        await Promise.race(inflight);
      }
      const running: Promise<void> = runJob(job, deps).finally(() =>
        inflight.delete(running),
      );
      inflight.add(running);
    } else {
      await runJob(job, deps);
    }
  }
}

/**
 * Boot recovery for publishes, BEFORE the generic requeue: a publish stranded mid-run must be
 * FAILED, never rerun — its task already carries progress, and a rerun could land a duplicate
 * commit or misreport a landed publish (the drafts are gone) as "nothing to publish". Also
 * settles running publish tasks with no live job — the MCP `publishNow` path runs in-request
 * with no job at all, and without this a restart mid-run would leave that task `running`
 * forever, permanently disabling Publish for the project.
 */
async function reconcilePublishesOnBoot(store: DataStore): Promise<void> {
  const failedJobs = await store.jobs.failRunningByKind(
    "publish",
    PUBLISH_INTERRUPTED_MESSAGE,
  );
  const failedJobIds = new Set(failedJobs.map((j) => j.id));
  const running = await store.workspaceTasks.listRunningByKind("publish");
  let settled = 0;
  for (const task of running) {
    // A task whose job is still QUEUED never started — leave it; the worker runs it fresh.
    if (task.jobId !== null && !failedJobIds.has(task.jobId)) continue;
    await store.workspaceTasks.update(task.id, {
      status: "failed",
      error: PUBLISH_INTERRUPTED_MESSAGE,
    });
    settled++;
  }
  if (failedJobs.length > 0 || settled > 0) {
    console.log(
      `[jobs] settled ${settled} publish task(s) (${failedJobs.length} job(s)) stranded by a restart`,
    );
  }
}

function startWorker(): { stop: () => void } {
  // Boot recovery: a process restart (dev HMR, redeploy, crash) kills in-flight jobs, leaving
  // them stranded as `running` — and their deployment rows stuck at pending/building forever.
  // This worker is the only one per box (ARCH §2), so requeueing `running` jobs is safe —
  // except publishes, which are settled as failed first (see reconcilePublishesOnBoot).
  const data = getRuntime().data;
  let booted = false;
  void reconcilePublishesOnBoot(data)
    .catch((err) =>
      console.error("[jobs] publish boot reconciliation failed:", err),
    )
    .then(async () => {
      const result = await reconcileLiveDeployments({
        store: data,
        deployTarget: getRuntime().deployTarget,
      });
      if (result.checked > 0) {
        console.log(
          `[jobs] reconciled ${result.checked} live deployment(s): ` +
            `${result.live} live, ${result.stopped} stopped`,
        );
      }
    })
    .catch((err) =>
      console.error("[jobs] deployment boot reconciliation failed:", err),
    )
    .then(() => data.jobs.requeueRunning())
    .then((n) => {
      if (n > 0)
        console.log(`[jobs] requeued ${n} job(s) stranded by a restart`);
    })
    .then(async () => {
      const { reconcileAllEnvironmentEnv } =
        await import("~/deploy/env-reconcile.server");
      const result = await reconcileAllEnvironmentEnv();
      if (result.stale > 0) {
        console.log(
          `[jobs] found ${result.stale} stale env deployment(s) across ${result.checked} environment(s)`,
        );
      }
    })
    .catch((err) => console.error("[jobs] boot recovery failed:", err))
    .finally(() => {
      booted = true;
    });

  const deps: WorkerDeps = {
    claim: claimNext,
    execute,
    complete: markDone,
    fail: markFailed,
    deployConcurrency: DEPLOY_CONCURRENCY,
  };
  // Pooled deploys outlive a queue pass; the set is shared across passes so the bound holds.
  const inflight = new Set<Promise<void>>();
  let running = false;
  const interval = setInterval(async () => {
    if (!booted || running) return; // recover persisted state first; don't stack long builds
    running = true;
    try {
      await processQueue(deps, inflight);
    } finally {
      running = false;
    }
  }, POLL_MS);
  interval.unref?.();
  console.log(
    `[jobs] worker started (poll ${POLL_MS}ms, deploy pool ${DEPLOY_CONCURRENCY})`,
  );
  return { stop: () => clearInterval(interval) };
}

const globalForWorker = globalThis as unknown as {
  __harnesstJobWorker?: { stop: () => void };
};

/** Start the worker once per process; safe to call from any server module. */
export function ensureWorkerStarted(): void {
  if (process.env.HARNESST_DISABLE_WORKER !== "1") {
    globalForWorker.__harnesstJobWorker ??= startWorker();
  }
  // The sandbox reaper (issue #118) is a sibling periodic sweep with its own env gate and the
  // local-docker guard. Start it here so every existing worker call site gets it; it is a no-op on
  // other deploy targets and when HARNESST_DISABLE_SANDBOX_REAPER=1.
  ensureSandboxReaperStarted();
}
