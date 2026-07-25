/**
 * Durable job queue (control plane), over the `DataStore` seam.
 *
 * Long-running work — builds and deploys above all — must not run inside HTTP request handlers:
 * GitHub delivers webhooks with a ~10s timeout while an `eve build` takes minutes, and an
 * in-request build dies silently on server restart. Handlers enqueue; the worker
 * (worker.server.ts) claims and executes. The claim's FOR UPDATE SKIP LOCKED and the backoff
 * persistence live in the Drizzle store; the retry *policy* is the pure planFailure (policy.ts).
 */
import type { DataStore, Job } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import { planFailure } from "./policy";

export type { Job } from "~/data/ports";

export type JobKind =
  | "deploy_release"
  | "rollback_release"
  | "assistant_deploy"
  | "assistant_restart"
  | "cleanup_deployment_container"
  | "drain_deployment"
  // issue #225: the whole publish pipeline (check → build → commit → version → deploy).
  | "publish";

export interface DeployReleasePayload {
  environmentId: string;
  releaseId: string;
  /** Pre-created `queued` deployment row the job takes over (visible in the UI immediately). */
  deploymentId?: string;
  /** Force a fresh image build even when the Release already has an imageRef. */
  rebuild?: boolean;
  trafficWeight?: number;
  createdBy?: string | null;
  [key: string]: unknown;
}

/** Enqueue a job; returns its id. The worker picks it up on its next poll. */
export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown>,
  opts?: { runAt?: Date; maxAttempts?: number },
  store: DataStore = getRuntime().data,
): Promise<string> {
  return store.jobs.insert({ kind, payload, runAt: opts?.runAt, maxAttempts: opts?.maxAttempts });
}

/**
 * Atomically claim the next runnable job (queued, due). Concurrent workers are safe: the store
 * claims each job for exactly one caller (SKIP LOCKED in the Drizzle impl).
 */
export function claimNext(store: DataStore = getRuntime().data): Promise<Job | null> {
  return store.jobs.claimNext(new Date());
}

export async function markDone(jobId: string, store: DataStore = getRuntime().data): Promise<void> {
  await store.jobs.update(jobId, { status: "done", error: null });
}

/** Retry with linear backoff while attempts remain; park as `failed` after the last one. */
export async function markFailed(
  job: Job,
  error: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  const plan = planFailure(job, new Date());
  await store.jobs.update(job.id, {
    status: plan.status,
    error,
    ...(plan.runAt ? { runAt: plan.runAt } : {}),
  });
}

/** Queue depth by status (ops/debug view). */
export function queueStats(store: DataStore = getRuntime().data): Promise<Record<string, number>> {
  return store.jobs.statsByStatus();
}
