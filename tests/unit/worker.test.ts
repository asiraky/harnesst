/**
 * Worker dispatch pool (issue #375) — processQueue driven with scripted deps, no DB and no
 * docker. What matters: deploy/rollback jobs overlap up to the bound while every other kind
 * stays strictly serial, a full pool blocks the (already-claimed) next deploy rather than
 * dropping it, failures are recorded, and a claim error exits the loop instead of spinning.
 */
import { describe, expect, it, vi } from "vitest";

import type { Job } from "~/jobs/queue.server";
import { processQueue, type WorkerDeps } from "~/jobs/worker.server";

function makeJob(id: string, kind: string): Job {
  return {
    id,
    kind,
    payload: {},
    status: "running",
    attempts: 1,
    maxAttempts: 3,
  } as unknown as Job;
}

/** A promise resolved only by `release()` — for holding a job's execution open. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface Script {
  queue: Job[];
  deployConcurrency?: number;
  /** Per-job-id gate; execute blocks on it when present. */
  gates?: Record<string, { promise: Promise<void>; release: () => void }>;
  /** Job ids whose execute should throw. */
  failing?: string[];
}

function makeDeps(script: Script) {
  const events: string[] = [];
  const queue = [...script.queue];
  const deps: WorkerDeps = {
    claim: vi.fn(async () => queue.shift() ?? null),
    execute: vi.fn(async (job: Job) => {
      events.push(`start:${job.id}`);
      await script.gates?.[job.id]?.promise;
      if (script.failing?.includes(job.id)) throw new Error(`${job.id} exploded`);
      events.push(`end:${job.id}`);
    }),
    complete: vi.fn(async (jobId: string) => {
      events.push(`complete:${jobId}`);
    }),
    fail: vi.fn(async (job: Job) => {
      events.push(`fail:${job.id}`);
    }),
    deployConcurrency: script.deployConcurrency ?? 3,
  };
  return { deps, events };
}

describe("processQueue", () => {
  it("overlaps deploys while a serial job runs inline between them", async () => {
    const gates = { d1: gate(), d2: gate() };
    const { deps, events } = makeDeps({
      queue: [
        makeJob("d1", "deploy_release"),
        makeJob("d2", "rollback_release"),
        makeJob("p1", "run_publish"),
      ],
      gates,
    });
    const inflight = new Set<Promise<void>>();

    const run = processQueue(deps, inflight);
    // The serial job only starts after both deploys were dispatched — and neither has ended,
    // proving the loop did not await them inline.
    await vi.waitFor(() => expect(events).toContain("start:p1"));
    expect(events).toContain("start:d1");
    expect(events).toContain("start:d2");
    expect(events).not.toContain("end:d1");
    expect(events).not.toContain("end:d2");

    await run; // serial job done, queue empty — loop exits with deploys still in flight
    expect(events).toContain("complete:p1");
    expect(inflight.size).toBe(2);

    gates.d1.release();
    gates.d2.release();
    await Promise.all([...inflight]);
    expect(events).toContain("complete:d1");
    expect(events).toContain("complete:d2");
  });

  it("respects the bound: with deployConcurrency 1 a claimed deploy waits for a slot", async () => {
    const gates = { d1: gate(), d2: gate() };
    const { deps, events } = makeDeps({
      queue: [makeJob("d1", "deploy_release"), makeJob("d2", "deploy_release")],
      deployConcurrency: 1,
      gates,
    });
    const inflight = new Set<Promise<void>>();

    const run = processQueue(deps, inflight);
    await vi.waitFor(() => expect(events).toContain("start:d1"));
    // d2 is already claimed but must not start while d1 holds the only slot.
    await vi.waitFor(() => expect(deps.claim).toHaveBeenCalledTimes(2));
    expect(events).not.toContain("start:d2");

    gates.d1.release();
    await vi.waitFor(() => expect(events).toContain("start:d2"));
    gates.d2.release();
    await run;
    await Promise.all([...inflight]);
    expect(events).toContain("complete:d1");
    expect(events).toContain("complete:d2");
  });

  it("records a pooled deploy failure without disturbing serial jobs", async () => {
    const { deps, events } = makeDeps({
      queue: [makeJob("d1", "deploy_release"), makeJob("p1", "run_publish")],
      failing: ["d1"],
    });
    const inflight = new Set<Promise<void>>();

    await processQueue(deps, inflight);
    await Promise.all([...inflight]);

    expect(events).toContain("fail:d1");
    expect(events).not.toContain("complete:d1");
    expect(deps.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d1" }),
      "d1 exploded",
    );
    expect(events).toContain("complete:p1");
  });

  it("exits the loop on a claim error instead of spinning or throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps: WorkerDeps = {
        claim: vi.fn(async () => {
          throw new Error("connection refused");
        }),
        execute: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        deployConcurrency: 3,
      };
      await expect(processQueue(deps, new Set())).resolves.toBeUndefined();
      expect(deps.claim).toHaveBeenCalledTimes(1);
      expect(deps.execute).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
