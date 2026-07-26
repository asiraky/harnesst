/**
 * Team environments — lifecycle + seeding against in-memory fakes. The TEAM is the deployment
 * unit: a project owns ONE set of env NAMES and every roster member has a row of every name.
 * Verifies the invariants that hangs on: seeding fans the team env set across all members, CRUD
 * fans out (create/rename/delete a NAME touches every member's row), delete refuses the team's
 * last env and tears down instance infra per member, a roster prune (member removal) reaps the
 * removed member's infra before the row cascade, and ensureTeamEnvironments converges drift
 * (a member missing a name gets it) and seeds 'default' when a roster has no envs at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTeamEnvironment,
  deleteTeamEnvironment,
  destroyEnvironmentInfra,
  ensureTeamEnvironments,
  listTeamEnvNames,
  renameTeamEnvironment,
} from "~/deploy/environments.server";
import { createProject, syncProjectAgents } from "~/db/queries.server";
import { createRelease, deployRelease } from "~/deploy/controller.server";
import { fakeDeployTarget, fakeSecrets } from "../fakes/infra";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const ORG = "org_1";

beforeEach(() => {
  store = makeFakeStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TEAM = [
  { name: "alpha", root: "agents/alpha/agent" },
  { name: "beta", root: "agents/beta/agent" },
];

async function memberEnvNames(projectId: string, name: string): Promise<string[]> {
  const agent = (await store.agents.listByProject(projectId)).find((a) => a.name === name)!;
  return (await store.environments.listByAgent(agent.id)).map((e) => e.name);
}

describe("seeding (ensureTeamEnvironments)", () => {
  it("a new project's members each get exactly one environment named default", async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
    expect(await memberEnvNames(project.id, "alpha")).toEqual(["default"]);
    expect(await memberEnvNames(project.id, "beta")).toEqual(["default"]);
    expect(await listTeamEnvNames(project.id, { store })).toEqual(["default"]);
  });

  it("a roster re-sync never re-seeds a member that has environments — renames survive", async () => {
    const project = await createProject(
      { orgId: ORG, name: "Solo", roster: [{ name: "agent", root: "agent" }] },
      store,
    );
    const [agent] = await store.agents.listByProject(project.id);
    const [env] = await store.environments.listByAgent(agent.id);
    await store.environments.rename(env.id, "production");

    await syncProjectAgents(project.id, [{ name: "agent", root: "agent" }], store);

    expect((await store.environments.listByAgent(agent.id)).map((e) => e.name)).toEqual([
      "production",
    ]);
  });

  it("a NEW member picked up on roster sync inherits the whole team env set", async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
    // The team renames its shared env to "production" and adds "staging".
    await renameTeamEnvironment(
      { projectId: project.id, from: "default", to: "production", orgId: ORG },
      { store, deployTarget: fakeDeployTarget() },
    );
    await createTeamEnvironment(
      { projectId: project.id, name: "staging", orgId: ORG },
      { store, deployTarget: fakeDeployTarget() },
    );

    // A third member joins on sync.
    await syncProjectAgents(
      project.id,
      [...TEAM, { name: "gamma", root: "agents/gamma/agent" }],
      store,
    );

    expect((await memberEnvNames(project.id, "gamma")).sort()).toEqual([
      "production",
      "staging",
    ]);
  });

  it("converges a drifted roster: a member missing a team name gets it", async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
    // Drift: only alpha gets "staging" (as if a stray per-agent create leaked in).
    const alpha = (await store.agents.listByProject(project.id)).find((a) => a.name === "alpha")!;
    await store.environments.create({ projectId: project.id, agentId: alpha.id, name: "staging" });

    await ensureTeamEnvironments(project.id, { store });

    expect((await memberEnvNames(project.id, "beta")).sort()).toEqual(["default", "staging"]);
  });

  it("seeds 'default' when a roster has no environments at all", async () => {
    const projectId = "proj_x";
    store.seedProject({ id: projectId, orgId: ORG, repoOwner: "acme", repoName: "a" });
    store.seedAgent({ id: "a1", projectId, name: "alpha", root: "agents/alpha/agent" });
    store.seedAgent({ id: "a2", projectId, name: "beta", root: "agents/beta/agent" });

    await ensureTeamEnvironments(projectId, { store });

    expect(await memberEnvNames(projectId, "alpha")).toEqual(["default"]);
    expect(await memberEnvNames(projectId, "beta")).toEqual(["default"]);
  });
});

describe("createTeamEnvironment / renameTeamEnvironment", () => {
  let projectId: string;

  beforeEach(async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
    projectId = project.id;
  });

  const deps = () => ({ store, deployTarget: fakeDeployTarget() });

  it("creates the name for every member, in creation order (the first is the primary)", async () => {
    await createTeamEnvironment({ projectId, name: "staging", orgId: ORG }, deps());
    expect(await memberEnvNames(projectId, "alpha")).toEqual(["default", "staging"]);
    expect(await memberEnvNames(projectId, "beta")).toEqual(["default", "staging"]);
    expect(await listTeamEnvNames(projectId, { store })).toEqual(["default", "staging"]);
  });

  it("trims and rejects empty names with a readable error", async () => {
    await expect(
      createTeamEnvironment({ projectId, name: "   ", orgId: ORG }, deps()),
    ).rejects.toThrow(/name is required/i);
  });

  it("is idempotent drift repair — creating an existing name changes nothing and doesn't throw", async () => {
    await createTeamEnvironment({ projectId, name: "default", orgId: ORG }, deps());
    expect(await memberEnvNames(projectId, "alpha")).toEqual(["default"]);
  });

  it("renames the name across every member", async () => {
    await renameTeamEnvironment(
      { projectId, from: "default", to: "production", orgId: ORG },
      deps(),
    );
    expect(await memberEnvNames(projectId, "alpha")).toEqual(["production"]);
    expect(await memberEnvNames(projectId, "beta")).toEqual(["production"]);
  });

  it("rename to an existing sibling name is rejected readably", async () => {
    await createTeamEnvironment({ projectId, name: "staging", orgId: ORG }, deps());
    await expect(
      renameTeamEnvironment({ projectId, from: "default", to: "staging", orgId: ORG }, deps()),
    ).rejects.toThrow(/already exists/i);
  });

  it("rename of a name no member has is rejected", async () => {
    await expect(
      renameTeamEnvironment({ projectId, from: "ghost", to: "production", orgId: ORG }, deps()),
    ).rejects.toThrow(/no environment named/i);
  });
});

describe("deleteTeamEnvironment", () => {
  it("tears down each member's instances via the target, then the rows (cascade takes deployments)", async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
    store.seedProject({ id: project.id, orgId: ORG, repoOwner: "acme", repoName: "a" });
    const target = fakeDeployTarget({ health: { status: "live", url: "http://x" } });
    await createTeamEnvironment(
      { projectId: project.id, name: "staging", orgId: ORG },
      { store, deployTarget: target },
    );

    // Deploy something live into alpha's staging so there's infra to tear down.
    const alpha = (await store.agents.listByProject(project.id)).find((a) => a.name === "alpha")!;
    const alphaStaging = (await store.environments.listByAgent(alpha.id)).find(
      (e) => e.name === "staging",
    )!;
    const release = await createRelease(
      { projectId: project.id, agentId: alpha.id, gitSha: "a".repeat(40) },
      store,
    );
    // A deployment row exists to tear down (its health is irrelevant to delete — the row is
    // destroyed regardless of status).
    const dep = await deployRelease(
      { environmentId: alphaStaging.id, releaseId: release.id },
      { store, deployTarget: target, secrets: fakeSecrets() },
    );

    const destroyed: string[] = [];
    const destroyedWorlds: string[] = [];
    const teardownOrder: string[] = [];
    const updateDeployment = store.deployments.update.bind(store.deployments);
    vi.spyOn(store.deployments, "update").mockImplementation(
      async (id, patch) => {
        if (id === dep.id && patch.status === "stopped")
          teardownOrder.push("stopped");
        return updateDeployment(id, patch);
      },
    );
    const failRunningRuns = vi
      .spyOn(store.runs, "failRunningByDeployment")
      .mockImplementationOnce(async () => {
        teardownOrder.push("reconciled");
        throw new Error("telemetry store unavailable");
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await deleteTeamEnvironment(
      { projectId: project.id, name: "staging", orgId: ORG },
      {
        store,
        deployTarget: {
          ...target,
          destroy: async (id) => {
            destroyed.push(id);
          },
          destroyWorld: async (key) => {
            destroyedWorlds.push(key);
          },
        },
      },
    );

    // The live instance was torn down; the world dropped once per member's staging row.
    expect(destroyed).toEqual([dep.id]);
    expect(destroyedWorlds).toContain(alphaStaging.id);
    expect(failRunningRuns).toHaveBeenCalledWith(
      dep.id,
      expect.stringMatching(/stopped|removed/i),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to reconcile running runs"),
      expect.any(Error),
    );
    expect(teardownOrder).toEqual(["stopped", "reconciled"]);
    // "staging" is gone for the whole team; "default" survives.
    expect(await memberEnvNames(project.id, "alpha")).toEqual(["default"]);
    expect(await memberEnvNames(project.id, "beta")).toEqual(["default"]);
    expect(await store.environments.findById(alphaStaging.id)).toBeNull();
  });

});

describe("destroyEnvironmentInfra run-start gate", () => {
  it("aborts before infra or reconciliation when the stopped marker cannot land", async () => {
    store.seedProject({ id: "project_gate", orgId: ORG });
    store.seedAgent({ id: "agent_gate", projectId: "project_gate" });
    store.seedEnvironment({
      id: "env_gate",
      projectId: "project_gate",
      agentId: "agent_gate",
    });
    const release = await store.releases.insert({
      projectId: "project_gate",
      agentId: "agent_gate",
      version: "v1",
      gitSha: "gate-marker-test",
    });
    const deployment = await store.deployments.insert({
      environmentId: "env_gate",
      releaseId: release.id,
      status: "live",
      trafficWeight: 100,
    });
    vi.spyOn(store.deployments, "update").mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const failRunningRuns = vi.spyOn(
      store.runs,
      "failRunningByDeployment",
    );
    const destroy = vi.fn();

    await expect(
      destroyEnvironmentInfra("env_gate", {
        store,
        deployTarget: { ...fakeDeployTarget(), destroy },
      }),
    ).rejects.toThrow("database unavailable");

    // Keeping the row live and aborting the caller's cascade is safer than opening a window in
    // which a post-sweep start could land and lose its deployment id during cascade deletion.
    expect(destroy).not.toHaveBeenCalled();
    expect(failRunningRuns).not.toHaveBeenCalled();
    expect((await store.deployments.findById(deployment.id))?.status).toBe(
      "live",
    );
  });
});

describe("member removal (roster prune) tears down infra", () => {
  it("explicitly removing the final member tears down infra while the assistant survives", async () => {
    const project = await createProject(
      { orgId: ORG, name: "Team", layout: "team", roster: [TEAM[0]] },
      store,
    );
    const [alpha] = (await store.agents.listByProject(project.id)).filter(
      (a) => a.kind === "member",
    );
    await store.agents.createAssistant({
      projectId: project.id,
      name: "assistant",
      root: ".harnesst/assistant",
    });
    const [environment] = await store.environments.listByAgent(alpha.id);
    const target = fakeDeployTarget({ health: { status: "live", url: "http://x" } });
    const release = await createRelease(
      { projectId: project.id, agentId: alpha.id, gitSha: "d".repeat(40) },
      store,
    );
    const deployment = await deployRelease(
      { environmentId: environment.id, releaseId: release.id },
      { store, deployTarget: target, secrets: fakeSecrets() },
    );
    const destroyed: string[] = [];
    const destroyedWorlds: string[] = [];

    const roster = await syncProjectAgents(
      project.id,
      [],
      store,
      {
        ...target,
        destroy: async (id) => { destroyed.push(id); },
        destroyWorld: async (id) => { destroyedWorlds.push(id); },
      },
      { allowEmpty: true },
    );

    expect(roster.filter((a) => a.kind === "member")).toEqual([]);
    expect(destroyed).toEqual([deployment.id]);
    expect(destroyedWorlds).toEqual([environment.id]);
    expect((await store.agents.listByProject(project.id)).map((a) => a.kind)).toEqual([
      "assistant",
    ]);
    expect(await store.environments.findById(environment.id)).toBeNull();
  });

  it("a removed member's instances and worlds are torn down before the roster prune", async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
    store.seedProject({ id: project.id, orgId: ORG, repoOwner: "acme", repoName: "a" });
    const target = fakeDeployTarget({ health: { status: "live", url: "http://x" } });

    // Deploy something live for beta so removing it has infra to reap.
    const beta = (await store.agents.listByProject(project.id)).find((a) => a.name === "beta")!;
    const [betaDefault] = await store.environments.listByAgent(beta.id);
    const release = await createRelease(
      { projectId: project.id, agentId: beta.id, gitSha: "c".repeat(40) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: betaDefault.id, releaseId: release.id },
      { store, deployTarget: target, secrets: fakeSecrets() },
    );

    // beta's directory vanished from the tree (merged remove-member change request).
    const destroyed: string[] = [];
    const destroyedWorlds: string[] = [];
    const roster = await syncProjectAgents(
      project.id,
      [{ name: "alpha", root: "agents/alpha/agent" }],
      store,
      {
        ...target,
        destroy: async (id) => {
          destroyed.push(id);
        },
        destroyWorld: async (key) => {
          destroyedWorlds.push(key);
        },
      },
    );

    expect(destroyed).toEqual([dep.id]);
    expect(destroyedWorlds).toContain(betaDefault.id);
    expect(roster.map((a) => a.name)).toEqual(["alpha"]);
  });

  it("a sync without removals (adds, renames) never touches instance infra", async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
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

    await syncProjectAgents(
      project.id,
      [...TEAM, { name: "gamma", root: "agents/gamma/agent" }],
      store,
      target,
    );

    expect(destroyed).toEqual([]);
    expect(destroyedWorlds).toEqual([]);
  });
});

describe("deleteTeamEnvironment (guards & fallbacks)", () => {
  it("refuses to delete the team's only environment", async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
    await expect(
      deleteTeamEnvironment(
        { projectId: project.id, name: "default", orgId: ORG },
        { store, deployTarget: fakeDeployTarget() },
      ),
    ).rejects.toThrow(/only environment/i);
    expect(await memberEnvNames(project.id, "alpha")).toEqual(["default"]);
  });

  it("falls back to stop() when the target has no destroy()", async () => {
    const project = await createProject({ orgId: ORG, name: "Team", roster: TEAM }, store);
    const target = fakeDeployTarget({ health: { status: "live", url: "http://x" } });
    await createTeamEnvironment(
      { projectId: project.id, name: "staging", orgId: ORG },
      { store, deployTarget: target },
    );
    const alpha = (await store.agents.listByProject(project.id)).find((a) => a.name === "alpha")!;
    const alphaStaging = (await store.environments.listByAgent(alpha.id)).find(
      (e) => e.name === "staging",
    )!;
    const release = await createRelease(
      { projectId: project.id, agentId: alpha.id, gitSha: "b".repeat(40) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: alphaStaging.id, releaseId: release.id },
      { store, deployTarget: target, secrets: fakeSecrets() },
    );

    const stopped: string[] = [];
    await deleteTeamEnvironment(
      { projectId: project.id, name: "staging", orgId: ORG },
      {
        store,
        deployTarget: {
          ...target,
          destroy: undefined,
          stop: async (id: string) => {
            stopped.push(id);
          },
        },
      },
    );
    expect(stopped).toContain(dep.id);
  });
});
