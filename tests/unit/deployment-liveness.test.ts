import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeploymentWithRelease } from "~/data/ports";
import { reconcileLiveDeployments } from "~/deploy/liveness.server";
import { ensureLiveDeploymentForEnvironment } from "~/deploy/wake.server";
import type { DeployTarget, InstanceHealth } from "~/seams/types";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;

function target(
  health: DeployTarget["health"],
  start: DeployTarget["start"],
): DeployTarget {
  return { health, start } as unknown as DeployTarget;
}

async function seedLive(
  environmentId: string,
  agentId: string,
  url: string | null = "http://stale.local",
): Promise<DeploymentWithRelease> {
  store.seedAgent({ id: agentId, projectId: "p" });
  store.seedEnvironment({ id: environmentId, projectId: "p", agentId });
  const release = await store.releases.insert({
    projectId: "p",
    agentId,
    version: "v1",
    gitSha: `${agentId}-sha`,
  });
  const deployment = await store.deployments.insert({
    environmentId,
    releaseId: release.id,
    status: "live",
    trafficWeight: 100,
  });
  if (url) await store.deployments.update(deployment.id, { url });
  const [joined] = await store.deployments.listByEnvironment(environmentId);
  return joined;
}

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: "p", orgId: "o" });
});

describe("deployment liveness recovery", () => {
  it("recovers an ordinary agent's stale live row on demand with a fresh URL", async () => {
    const live = await seedLive("env_member", "member");
    const health = vi.fn(async (): Promise<InstanceHealth> => ({
      status: "stopped",
    }));
    const start = vi.fn(async (): Promise<InstanceHealth> => ({
      status: "live",
      url: "http://fresh.local",
    }));

    const recovered = await ensureLiveDeploymentForEnvironment("env_member", {
      store,
      deployTarget: target(health, start),
    });

    expect(health).toHaveBeenCalledWith(live.id);
    expect(start).toHaveBeenCalledWith(live.id);
    expect(recovered).toMatchObject({
      id: live.id,
      status: "live",
      url: "http://fresh.local",
    });
  });

  it("restores stale live deployments for every environment during the boot sweep", async () => {
    const member = await seedLive("env_member", "member");
    const assistant = await seedLive("env_assistant", "assistant");
    const health = vi.fn(async (id: string): Promise<InstanceHealth> =>
      id === member.id
        ? { status: "stopped" }
        : { status: "live", url: "http://inspected.local" },
    );
    const start = vi.fn(async (): Promise<InstanceHealth> => ({
      status: "live",
      url: "http://restarted.local",
    }));

    const result = await reconcileLiveDeployments({
      store,
      deployTarget: target(health, start),
    });

    expect(result).toEqual({ checked: 2, live: 2, stopped: 0 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(member.id);
    expect(await store.deployments.findById(member.id)).toMatchObject({
      status: "live",
      url: "http://restarted.local",
    });
    expect(await store.deployments.findById(assistant.id)).toMatchObject({
      status: "live",
      url: "http://inspected.local",
    });
  });

  it("leaves an unwakeable boot-time deployment stopped with its stale URL cleared", async () => {
    const live = await seedLive("env_member", "member");
    const result = await reconcileLiveDeployments({
      store,
      deployTarget: target(
        async () => ({ status: "failed", detail: "inspect failed" }),
        async () => {
          throw new Error("container is gone");
        },
      ),
    });

    expect(result).toEqual({ checked: 1, live: 0, stopped: 1 });
    expect(await store.deployments.findById(live.id)).toMatchObject({
      status: "stopped",
      url: null,
    });
  });

  it("does not revive a deployment that begins draining while its container starts", async () => {
    const live = await seedLive("env_member", "member");
    const start = vi.fn(async () => {
      await store.deployments.drainLive("env_member");
      return { status: "live" as const, url: "http://fresh.local" };
    });
    const deployTarget = target(async () => ({ status: "stopped" }), start);

    await reconcileLiveDeployments({ store, deployTarget });

    expect(start).toHaveBeenCalledWith(live.id);
    expect(await store.deployments.findById(live.id)).toMatchObject({
      status: "draining",
      url: null,
    });
  });

  it("keeps live rows on pending or throwing probes for incomplete deploy adapters", async () => {
    const live = await seedLive("env_member", "member");
    const start = vi.fn();

    const pending = await ensureLiveDeploymentForEnvironment("env_member", {
      store,
      deployTarget: target(async () => ({ status: "pending" }), start),
    });
    expect(pending?.id).toBe(live.id);

    const throwing = await ensureLiveDeploymentForEnvironment("env_member", {
      store,
      deployTarget: target(async () => {
        throw new Error("probe unsupported");
      }, start),
    });
    expect(throwing?.id).toBe(live.id);
    expect(start).not.toHaveBeenCalled();
  });
});
