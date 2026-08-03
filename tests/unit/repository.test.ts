/**
 * Repository deletion (M5.8) — the full harnesst-side teardown against in-memory fakes.
 * Verifies the ordering the feature hangs on: instance infra is destroyed BEFORE the row
 * delete (afterwards nothing could find the containers), the audit entry lands, the cascade
 * removes dependent rows, and a missing destroy() falls back to stop(). Model overrides hold no
 * FK to projects (issue #344), so their explicit pruning is verified here too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The override table lives outside the fake store (raw drizzle), and deleteRepository reaches it
// through a lazy import — stub the module so these tests stay DB-free.
const mocks = vi.hoisted(() => ({ removeProjectModelOverrides: vi.fn() }));
vi.mock("~/models/agent-model-config.server", () => ({
  removeProjectModelOverrides: mocks.removeProjectModelOverrides,
}));

import { createRelease, deployRelease } from "~/deploy/controller.server";
import {
  deleteRepository,
  REPOSITORY_TEARDOWN_TIMEOUT_MS,
} from "~/deploy/repository.server";
import { createProject } from "~/db/queries.server";
import { fakeDeployTarget, fakeSecrets } from "../fakes/infra";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const ORG = "org_1";

async function seedRunningProject() {
  const project = await createProject(
    { orgId: ORG, name: "Doomed", repoOwner: "acme", repoName: "doomed" },
    store,
  );
  const agentId = (await store.agents.listByProject(project.id))[0].id;
  const [env] = await store.environments.listByAgent(agentId);
  const release = await createRelease(
    { projectId: project.id, agentId, gitSha: "d".repeat(40) },
    store,
  );
  const dep = await deployRelease(
    { environmentId: env.id, releaseId: release.id },
    {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://x" },
      }),
      secrets: fakeSecrets(),
    },
  );
  expect(dep.status).toBe("live");
  return { project, agentId, env, release, dep };
}

beforeEach(() => {
  store = makeFakeStore();
  mocks.removeProjectModelOverrides.mockReset();
  mocks.removeProjectModelOverrides.mockResolvedValue(undefined);
});

describe("deleteRepository", () => {
  it("destroys every instance, audits, then deletes the project (cascade)", async () => {
    const { project, env, dep } = await seedRunningProject();
    const destroyed: string[] = [];
    const destroyedWorlds: string[] = [];
    const target = {
      ...fakeDeployTarget(),
      destroy: async (id: string) => {
        destroyed.push(id);
      },
      destroyWorld: async (key: string) => {
        destroyedWorlds.push(key);
      },
    };

    await deleteRepository(
      { projectId: project.id, createdBy: "user_1" },
      { store, deployTarget: target },
    );

    expect(destroyed).toContain(dep.id);
    // Each environment's shared world is dropped once, keyed by the env id.
    expect(destroyedWorlds).toEqual([env.id]);
    expect(await store.projects.findById(project.id)).toBeNull();
    expect(await store.agents.listByProject(project.id)).toHaveLength(0);
    expect(await store.environments.listByProject(project.id)).toHaveLength(0);
    expect(await store.deployments.listByEnvironment(env.id)).toHaveLength(0);
    expect(await store.releases.listByProject(project.id)).toHaveLength(0);
    expect(store.auditEntries).toContainEqual(
      expect.objectContaining({
        action: "repository.delete",
        target: "Doomed",
        orgId: ORG,
      }),
    );
  });

  it("falls back to stop() when the target has no destroy()", async () => {
    const { project, dep } = await seedRunningProject();
    const stopped: string[] = [];
    const target = {
      ...fakeDeployTarget(),
      destroy: undefined,
      stop: async (id: string) => {
        stopped.push(id);
      },
    };
    await deleteRepository(
      { projectId: project.id },
      { store, deployTarget: target },
    );
    expect(stopped).toContain(dep.id);
    expect(await store.projects.findById(project.id)).toBeNull();
  });

  it("a failing teardown never blocks the delete (best-effort infra)", async () => {
    const { project } = await seedRunningProject();
    const target = {
      ...fakeDeployTarget(),
      destroy: async () => {
        throw new Error("docker unreachable");
      },
    };
    await deleteRepository(
      { projectId: project.id },
      { store, deployTarget: target },
    );
    expect(await store.projects.findById(project.id)).toBeNull();
  });

  it("a hung teardown times out and still deletes the repository", async () => {
    const { project } = await seedRunningProject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const target = {
        ...fakeDeployTarget(),
        destroy: async () => new Promise<void>(() => {}),
      };
      const promise = deleteRepository(
        { projectId: project.id },
        { store, deployTarget: target },
      );

      await vi.advanceTimersByTimeAsync(REPOSITORY_TEARDOWN_TIMEOUT_MS + 1);
      await promise;

      expect(await store.projects.findById(project.id)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("prunes the repo's model overrides (no FK cascade covers them)", async () => {
    const { project } = await seedRunningProject();
    await deleteRepository(
      { projectId: project.id },
      { store, deployTarget: fakeDeployTarget() },
    );
    expect(mocks.removeProjectModelOverrides).toHaveBeenCalledWith(
      ORG,
      project.id,
    );
  });

  it("a failing override prune never fails the delete", async () => {
    const { project } = await seedRunningProject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.removeProjectModelOverrides.mockRejectedValue(new Error("db down"));
    try {
      await deleteRepository(
        { projectId: project.id },
        { store, deployTarget: fakeDeployTarget() },
      );
      expect(await store.projects.findById(project.id)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("model override cleanup"),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("throws for an unknown repository", async () => {
    await expect(
      deleteRepository(
        { projectId: "nope" },
        { store, deployTarget: fakeDeployTarget() },
      ),
    ).rejects.toThrow(/not found/i);
  });
});
