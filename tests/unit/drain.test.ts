/**
 * Blue-green drain watcher (issue #81) — against in-memory fakes (no DB, no docker). Verifies the
 * one-tick logic drainDeployment owns: idle → stop, busy-under-ceiling → wait + re-poll,
 * busy-past-ceiling → stop + reconcile, and the re-check guards (row missing / no longer draining).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS } from "~/deploy/cleanup.server";
import {
  DEPLOYMENT_DRAIN_BACKOFF_AFTER_MS,
  DEPLOYMENT_DRAIN_POLL_MS,
  DEPLOYMENT_DRAIN_POLL_SLOW_MS,
  drainDeployment,
  drainPollDelayMs,
} from "~/deploy/drain.server";
import type { DeployTarget } from "~/seams/types";
import { fakeDeployTarget, fakeSecrets } from "../fakes/infra";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_1";
const ORG = "org_1";
const AGENT = "agent_1";
const ENV = "env_1";
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

let store: FakeStore;

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT, orgId: ORG });
  store.seedAgent({ id: AGENT, projectId: PROJECT });
  store.seedEnvironment({ id: ENV, projectId: PROJECT, agentId: AGENT });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Insert a `draining` deployment (its own release) — the drain watcher's subject. */
async function seedDraining(): Promise<string> {
  const release = await store.releases.insert({
    projectId: PROJECT,
    agentId: AGENT,
    version: "v1",
    gitSha: "a".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: ENV,
    releaseId: release.id,
    status: "draining",
    trafficWeight: 0,
  });
  return dep.id;
}

describe("drainDeployment", () => {
  it("stops an idle draining deployment immediately", async () => {
    const id = await seedDraining();
    const stoppedIds: string[] = [];
    const deps = { store, deployTarget: fakeDeployTarget({ stoppedIds }), secrets: fakeSecrets() };

    const result = await drainDeployment({ deploymentId: id, deadlineAt: FUTURE }, deps);

    expect(result).toEqual({ status: "stopped", interruptedRuns: 0 });
    expect(stoppedIds).toContain(id);
    expect((await store.deployments.findById(id))?.status).toBe("stopped");
    // Container cleanup is scheduled once it has actually stopped.
    const cleanupJob = await store.jobs.claimNext(
      new Date(Date.now() + DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS + 1000),
    );
    expect(cleanupJob?.kind).toBe("cleanup_deployment_container");
    expect(cleanupJob?.payload).toEqual({ deploymentId: id });
  });

  it("waits and re-polls while a turn is in flight under the ceiling — container untouched", async () => {
    const id = await seedDraining();
    store.seedRun({ id: "run_1", projectId: PROJECT, deploymentId: id, status: "running" });
    const stoppedIds: string[] = [];
    const deps = { store, deployTarget: fakeDeployTarget({ stoppedIds }), secrets: fakeSecrets() };
    const startedAt = new Date().toISOString();

    const result = await drainDeployment(
      { deploymentId: id, deadlineAt: FUTURE, drainStartedAt: startedAt },
      deps,
    );

    expect(result).toEqual({ status: "waiting", runningRuns: 1 });
    expect(stoppedIds).toEqual([]);
    expect((await store.deployments.findById(id))?.status).toBe("draining");
    // The next poll is enqueued one interval out, carrying the same deadline and start.
    expect(await store.jobs.claimNext(new Date())).toBeNull();
    const next = await store.jobs.claimNext(new Date(Date.now() + DEPLOYMENT_DRAIN_POLL_MS + 1000));
    expect(next?.kind).toBe("drain_deployment");
    expect(next?.payload).toEqual({
      deploymentId: id,
      deadlineAt: FUTURE,
      drainStartedAt: startedAt,
    });
  });

  it("backs off to the slow poll once the drain is older than the backoff threshold", async () => {
    const id = await seedDraining();
    store.seedRun({ id: "run_1", projectId: PROJECT, deploymentId: id, status: "running" });
    const deps = { store, deployTarget: fakeDeployTarget(), secrets: fakeSecrets() };
    const oldStart = new Date(
      Date.now() - DEPLOYMENT_DRAIN_BACKOFF_AFTER_MS - 60_000,
    ).toISOString();

    const result = await drainDeployment(
      { deploymentId: id, deadlineAt: FUTURE, drainStartedAt: oldStart },
      deps,
    );

    expect(result).toEqual({ status: "waiting", runningRuns: 1 });
    // Not claimable at the fast interval — only at the slow one.
    expect(
      await store.jobs.claimNext(new Date(Date.now() + DEPLOYMENT_DRAIN_POLL_MS + 1000)),
    ).toBeNull();
    const next = await store.jobs.claimNext(
      new Date(Date.now() + DEPLOYMENT_DRAIN_POLL_SLOW_MS + 1000),
    );
    expect(next?.kind).toBe("drain_deployment");
    expect(next?.payload).toMatchObject({ drainStartedAt: oldStart });
  });

  it("treats a payload without drainStartedAt (pre-backoff job) as started now — fast poll", async () => {
    const id = await seedDraining();
    store.seedRun({ id: "run_1", projectId: PROJECT, deploymentId: id, status: "running" });
    const deps = { store, deployTarget: fakeDeployTarget(), secrets: fakeSecrets() };

    const result = await drainDeployment({ deploymentId: id, deadlineAt: FUTURE }, deps);

    expect(result).toEqual({ status: "waiting", runningRuns: 1 });
    // Claimable at the fast interval, and the re-enqueue writes the field so it converges.
    const next = await store.jobs.claimNext(new Date(Date.now() + DEPLOYMENT_DRAIN_POLL_MS + 1000));
    expect(next?.kind).toBe("drain_deployment");
    expect((next?.payload as { drainStartedAt?: string }).drainStartedAt).toBeDefined();
  });

  it("stops past the ceiling even with a turn in flight, failing it visibly", async () => {
    const id = await seedDraining();
    store.seedRun({
      id: "run_1",
      projectId: PROJECT,
      deploymentId: id,
      status: "running",
      startedAt: new Date(Date.now() - 5000),
    });
    const stoppedIds: string[] = [];
    const deps = { store, deployTarget: fakeDeployTarget({ stoppedIds }), secrets: fakeSecrets() };

    const result = await drainDeployment({ deploymentId: id, deadlineAt: PAST }, deps);

    expect(result).toEqual({ status: "stopped", interruptedRuns: 1 });
    expect(stoppedIds).toContain(id);
    expect((await store.deployments.findById(id))?.status).toBe("stopped");
    const run = store.getRun("run_1");
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/past the redeploy drain window/i);
    // Cleanup scheduled.
    const cleanupJob = await store.jobs.claimNext(
      new Date(Date.now() + DEPLOYMENT_CONTAINER_CLEANUP_GRACE_MS + 1000),
    );
    expect(cleanupJob?.kind).toBe("cleanup_deployment_container");
  });

  it("skips when the deployment row is gone (env teardown removed it)", async () => {
    const stoppedIds: string[] = [];
    const deps = { store, deployTarget: fakeDeployTarget({ stoppedIds }), secrets: fakeSecrets() };

    const result = await drainDeployment({ deploymentId: "missing", deadlineAt: FUTURE }, deps);

    expect(result).toEqual({ status: "skipped", reason: "deployment not found" });
    expect(stoppedIds).toEqual([]);
  });

  it("skips a row that is no longer draining — container untouched", async () => {
    const release = await store.releases.insert({
      projectId: PROJECT,
      agentId: AGENT,
      version: "v1",
      gitSha: "b".repeat(40),
    });
    const stoppedIds: string[] = [];
    const deps = { store, deployTarget: fakeDeployTarget({ stoppedIds }), secrets: fakeSecrets() };

    for (const status of ["live", "stopped"] as const) {
      const dep = await store.deployments.insert({
        environmentId: ENV,
        releaseId: release.id,
        status,
        trafficWeight: status === "live" ? 100 : 0,
      });
      const result = await drainDeployment({ deploymentId: dep.id, deadlineAt: FUTURE }, deps);
      expect(result).toEqual({ status: "skipped", reason: `deployment is ${status}` });
    }
    expect(stoppedIds).toEqual([]);
  });

  describe("drainPollDelayMs", () => {
    const T0 = Date.parse("2026-01-01T00:00:00Z");

    it("polls fast while the drain is younger than the backoff threshold", () => {
      expect(drainPollDelayMs(T0, T0)).toBe(DEPLOYMENT_DRAIN_POLL_MS);
      expect(drainPollDelayMs(T0 + DEPLOYMENT_DRAIN_BACKOFF_AFTER_MS - 1, T0)).toBe(
        DEPLOYMENT_DRAIN_POLL_MS,
      );
    });

    it("switches to the slow poll at the threshold and beyond", () => {
      expect(drainPollDelayMs(T0 + DEPLOYMENT_DRAIN_BACKOFF_AFTER_MS, T0)).toBe(
        DEPLOYMENT_DRAIN_POLL_SLOW_MS,
      );
      expect(drainPollDelayMs(T0 + 24 * 60 * 60 * 1000, T0)).toBe(DEPLOYMENT_DRAIN_POLL_SLOW_MS);
    });
  });

  it("propagates a stop failure so the worker retries the drain", async () => {
    const id = await seedDraining();
    // A target whose stop throws and has no destroy fallback — stopDeploymentInfra rethrows.
    const brokenStop = fakeDeployTarget({ stopError: "docker daemon unreachable" });
    delete (brokenStop as Partial<DeployTarget>).destroy;
    const deps = { store, deployTarget: brokenStop, secrets: fakeSecrets() };

    await expect(
      drainDeployment({ deploymentId: id, deadlineAt: FUTURE }, deps),
    ).rejects.toThrow(/docker daemon unreachable/);
    // Left draining for a retry — never silently marked stopped.
    expect((await store.deployments.findById(id))?.status).toBe("draining");
  });
});
