import { describe, expect, it, vi } from "vitest";

import {
  invalidateAgentEnvironments,
  invalidateOrganizationEnvironments,
  reconcileEnvironmentEnv,
  type EnvInvalidationDeps,
  type EnvReconcileDeps,
} from "~/deploy/env-reconcile.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_env";
const AGENT = "agent_env";
const ENVIRONMENT = "env_prod";

function seededStore(): FakeStore {
  const store = makeFakeStore();
  store.seedProject({ id: PROJECT, orgId: "org_env" });
  store.seedAgent({ id: AGENT, projectId: PROJECT });
  store.seedEnvironment({
    id: ENVIRONMENT,
    projectId: PROJECT,
    agentId: AGENT,
  });
  return store;
}

async function seedDeployment(
  store: FakeStore,
  status: string,
  envRevision = 0,
) {
  const release = await store.releases.insert({
    projectId: PROJECT,
    agentId: AGENT,
    version: `${status}-${envRevision}`,
    gitSha: `${status}-${envRevision}`.padEnd(40, "0"),
  });
  return store.deployments.insert({
    environmentId: ENVIRONMENT,
    releaseId: release.id,
    status,
    trafficWeight: status === "stopped" ? 0 : 100,
    envRevision,
  });
}

describe("environment env invalidation", () => {
  it("bumps every environment for the affected agent and queues durable reconciliation", async () => {
    const store = seededStore();
    store.seedEnvironment({
      id: "env_stage",
      projectId: PROJECT,
      agentId: AGENT,
      name: "staging",
    });
    const enqueue = vi.fn(async () => "job_1");
    const ensureWorkerStarted = vi.fn();

    const result = await invalidateAgentEnvironments(
      { agentIds: [AGENT, AGENT], createdBy: "user_1" },
      { store, enqueue, ensureWorkerStarted } as EnvInvalidationDeps,
    );

    expect(result.environmentIds).toEqual([ENVIRONMENT, "env_stage"]);
    expect((await store.environments.findById(ENVIRONMENT))?.envRevision).toBe(
      1,
    );
    expect((await store.environments.findById("env_stage"))?.envRevision).toBe(
      1,
    );
    expect(ensureWorkerStarted).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      "reconcile_environment_env",
      { environmentId: ENVIRONMENT, createdBy: "user_1" },
      undefined,
      store,
    );
  });

  it("invalidates member agents across an org but excludes the built-in assistant", async () => {
    const store = seededStore();
    store.seedAgent({
      id: "assistant_1",
      projectId: PROJECT,
      kind: "assistant",
    });
    store.seedEnvironment({
      id: "env_assistant",
      projectId: PROJECT,
      agentId: "assistant_1",
    });
    const enqueue = vi.fn(async () => "job_1");

    const result = await invalidateOrganizationEnvironments(
      { orgId: "org_env" },
      {
        store,
        enqueue,
        ensureWorkerStarted: vi.fn(),
      } as EnvInvalidationDeps,
    );

    expect(result.environmentIds).toEqual([ENVIRONMENT]);
    expect(
      (await store.environments.findById("env_assistant"))?.envRevision,
    ).toBe(0);
  });
});

describe("environment env reconciliation", () => {
  function deps(
    store: FakeStore,
    overrides: Partial<EnvReconcileDeps> = {},
  ): EnvReconcileDeps {
    return {
      store,
      queueDeploy: vi.fn(async () => ({ id: "dep_replacement" })),
      enqueue: vi.fn(async () => "job_retry"),
      ...overrides,
    };
  }

  it("does nothing when the live deployment captured the desired revision", async () => {
    const store = seededStore();
    await seedDeployment(store, "live", 0);
    const reconcileDeps = deps(store);

    expect(
      await reconcileEnvironmentEnv(
        { environmentId: ENVIRONMENT },
        reconcileDeps,
      ),
    ).toEqual({ status: "current" });
    expect(reconcileDeps.queueDeploy).not.toHaveBeenCalled();
  });

  it("queues an image-reusing replacement when a live deployment is stale", async () => {
    const store = seededStore();
    const live = await seedDeployment(store, "live", 0);
    await store.environments.bumpEnvRevision(ENVIRONMENT);
    const queueDeploy = vi.fn(async () => ({ id: "dep_fresh" }));

    expect(
      await reconcileEnvironmentEnv(
        { environmentId: ENVIRONMENT, createdBy: "user_1" },
        deps(store, { queueDeploy }),
      ),
    ).toEqual({ status: "redeploying", deploymentId: "dep_fresh" });
    expect(queueDeploy).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT,
      releaseId: live.releaseId,
      rollback: true,
      createdBy: "user_1",
    });
  });

  it("waits behind an older in-flight deploy so the unique deployment guard is never raced", async () => {
    const store = seededStore();
    await seedDeployment(store, "live", 0);
    const pending = await seedDeployment(store, "pending", 0);
    await store.environments.bumpEnvRevision(ENVIRONMENT);
    const enqueue = vi.fn(async () => "job_retry");
    const reconcileDeps = deps(store, { enqueue });

    expect(
      await reconcileEnvironmentEnv(
        { environmentId: ENVIRONMENT },
        reconcileDeps,
      ),
    ).toEqual({ status: "waiting", deploymentId: pending.id });
    expect(reconcileDeps.queueDeploy).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("recognizes an in-flight deploy that already captured the desired revision", async () => {
    const store = seededStore();
    await store.environments.bumpEnvRevision(ENVIRONMENT);
    const pending = await seedDeployment(store, "building", 1);
    const reconcileDeps = deps(store);

    expect(
      await reconcileEnvironmentEnv(
        { environmentId: ENVIRONMENT },
        reconcileDeps,
      ),
    ).toEqual({ status: "covered", deploymentId: pending.id });
    expect(reconcileDeps.enqueue).not.toHaveBeenCalled();
  });

  it("leaves stale stopped instances scaled to zero for the wake path to replace", async () => {
    const store = seededStore();
    await seedDeployment(store, "stopped", 0);
    await store.environments.bumpEnvRevision(ENVIRONMENT);
    const reconcileDeps = deps(store);

    expect(
      await reconcileEnvironmentEnv(
        { environmentId: ENVIRONMENT },
        reconcileDeps,
      ),
    ).toEqual({ status: "stopped" });
    expect(reconcileDeps.queueDeploy).not.toHaveBeenCalled();
  });
});
