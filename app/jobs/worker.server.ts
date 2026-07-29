/**
 * In-process job worker. Polls the queue and executes handlers; started once per server
 * process via ensureWorkerStarted() (HMR/multi-import safe through a globalThis guard, same
 * pattern as the db client). For v1 the worker lives inside the web process — one box, one
 * process (ARCH §2); it moves to a dedicated process/container by just importing and calling
 * startWorker() elsewhere. Concurrency 1: builds are docker-bound and serializing them keeps
 * resource use predictable on a dev box.
 */
import type { DataStore } from "~/data/ports";
import { deployRelease, rollbackTo } from "~/deploy/controller.server";
import { ensureSandboxReaperStarted } from "~/deploy/sandbox-reaper.server";
import { PUBLISH_INTERRUPTED_MESSAGE } from "~/publish/pipeline.server";
import { getRuntime } from "~/seams/index.server";
import type { DeployReleasePayload, Job } from "./queue.server";
import { claimNext, markDone, markFailed } from "./queue.server";

const POLL_MS = Number(process.env.HARNESST_WORKER_POLL_MS ?? 2000);

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
      const p = job.payload as { deploymentId?: string; deadlineAt?: string };
      if (!p.deploymentId) throw new Error("drain job missing deploymentId");
      if (!p.deadlineAt) throw new Error("drain job missing deadlineAt");
      // A `waiting` result is a SUCCESS: the tick re-enqueued its own successor, so this job is
      // done. Only a thrown error (e.g. the container refused to stop) is a retry.
      const result = await drainDeployment({
        deploymentId: p.deploymentId,
        deadlineAt: p.deadlineAt,
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

async function tick(): Promise<void> {
  // Drain everything due, one job at a time; sleep only when the queue is empty.
  for (;;) {
    let job: Job | null = null;
    try {
      job = await claimNext();
    } catch (err) {
      console.error("[jobs] claim failed:", err);
      return;
    }
    if (!job) return;
    try {
      await execute(job);
      await markDone(job.id);
      console.log(`[jobs] done ${job.kind} ${job.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[jobs] ${job.kind} ${job.id} attempt ${job.attempts} failed: ${msg}`,
      );
      await markFailed(job, msg);
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
  reconcilePublishesOnBoot(data)
    .catch((err) =>
      console.error("[jobs] publish boot reconciliation failed:", err),
    )
    .then(() => data.jobs.requeueRunning())
    .then((n) => {
      if (n > 0)
        console.log(`[jobs] requeued ${n} job(s) stranded by a restart`);
    })
    .catch((err) => console.error("[jobs] boot recovery failed:", err));

  let running = false;
  const interval = setInterval(async () => {
    if (running) return; // don't stack ticks behind a long build
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  }, POLL_MS);
  interval.unref?.();
  console.log(`[jobs] worker started (poll ${POLL_MS}ms)`);
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
