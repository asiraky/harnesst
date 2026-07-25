/**
 * In-process job worker. Polls the queue and executes handlers; started once per server
 * process via ensureWorkerStarted() (HMR/multi-import safe through a globalThis guard, same
 * pattern as the db client). For v1 the worker lives inside the web process — one box, one
 * process (ARCH §2); it moves to a dedicated process/container by just importing and calling
 * startWorker() elsewhere. Concurrency 1: builds are docker-bound and serializing them keeps
 * resource use predictable on a dev box.
 */
import { deployRelease, rollbackTo } from "~/deploy/controller.server";
import { ensureSandboxReaperStarted } from "~/deploy/sandbox-reaper.server";
import { getRuntime } from "~/seams/index.server";
import type { DeployReleasePayload, Job } from "./queue.server";
import { claimNext, markDone, markFailed } from "./queue.server";

const POLL_MS = Number(process.env.EDEN_WORKER_POLL_MS ?? 2000);

async function execute(job: Job): Promise<void> {
  switch (job.kind) {
    case "deploy_release":
    case "rollback_release": {
      const p = job.payload as DeployReleasePayload;
      const dep =
        job.kind === "deploy_release" ? await deployRelease(p) : await rollbackTo(p);
      // A deployment that records `failed` is a real outcome, not a queue error — but
      // surfacing it as a job failure gets retries for transient build/docker flakes.
      if (dep.status === "failed") {
        throw new Error(dep.errorDetail ?? "deployment failed");
      }
      return;
    }
    case "assistant_deploy": {
      const { runAssistantDeploy } = await import("~/assistant/instance.server");
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
      const { restartAssistantInstance } = await import("~/assistant/instance.server");
      const p = job.payload as { projectId: string };
      await restartAssistantInstance(p.projectId);
      return;
    }
    case "cleanup_deployment_container": {
      const { cleanupDeploymentContainer } = await import("~/deploy/cleanup.server");
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
    case "publish": {
      // issue #225: the publish pipeline (check → build → commit → version → deploy). Progress and
      // failures surface through the workspace task's steps, not queue retries (maxAttempts:1).
      const { runPublish } = await import("~/publish/pipeline.server");
      const p = job.payload as import("~/publish/pipeline.server").PublishPayload;
      await runPublish(p);
      return;
    }
    case "merge_change": {
      // issue #142: the merge build gate + GitHub merge, moved off the HTTP request. Progress and
      // a build-gate failure surface through the workspace task, not a queue retry (maxAttempts:1).
      const { runMergeChange } = await import("~/deploy/merge-change.server");
      const p = job.payload as import("~/deploy/merge-change.server").MergeChangePayload;
      await runMergeChange(p);
      return;
    }
    case "publish_change": {
      const { runPublishChange } = await import("~/drafts/publish-change.server");
      const p = job.payload as import("~/drafts/publish-change.server").PublishChangePayload;
      await runPublishChange(p);
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
      console.error(`[jobs] ${job.kind} ${job.id} attempt ${job.attempts} failed: ${msg}`);
      await markFailed(job, msg);
    }
  }
}

function startWorker(): { stop: () => void } {
  // Boot recovery: a process restart (dev HMR, redeploy, crash) kills in-flight jobs, leaving
  // them stranded as `running` — and their deployment rows stuck at pending/building forever.
  // This worker is the only one per box (ARCH §2), so requeueing all `running` jobs is safe.
  getRuntime()
    .data.jobs.requeueRunning()
    .then((n) => {
      if (n > 0) console.log(`[jobs] requeued ${n} job(s) stranded by a restart`);
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
  __edenJobWorker?: { stop: () => void };
};

/** Start the worker once per process; safe to call from any server module. */
export function ensureWorkerStarted(): void {
  if (process.env.EDEN_DISABLE_WORKER !== "1") {
    globalForWorker.__edenJobWorker ??= startWorker();
  }
  // The sandbox reaper (issue #118) is a sibling periodic sweep with its own env gate and the
  // local-docker guard. Start it here so every existing worker call site gets it; it is a no-op on
  // other deploy targets and when EDEN_DISABLE_SANDBOX_REAPER=1.
  ensureSandboxReaperStarted();
}
