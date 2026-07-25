/**
 * HEAD deploys and version moves against in-memory fakes (no GitHub, no docker). The TEAM is
 * the deployment unit: shipRepoHead deploys the branch HEAD for the WHOLE roster with nothing
 * saved (idempotent per head sha), and deployTeamVersion moves the whole team to an existing
 * version by git sha — the rollback/redeploy path. The publish pipeline is covered in
 * publish-pipeline.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  deployTeamVersion,
  shipRepoHead,
  type ShipDeps,
  type ShipProject,
} from "~/deploy/ship.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT: ShipProject = {
  id: "proj_1",
  repoInstallationId: "inst_1",
  repoOwner: "acme",
  repoName: "agents",
  defaultBranch: "main",
};
beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT.id, orgId: "org_1", repoOwner: "acme", repoName: "agents" });
  store.seedAgent({ id: "agent_a", projectId: PROJECT.id, name: "alpha", root: "agents/alpha/agent" });
  store.seedAgent({ id: "agent_b", projectId: PROJECT.id, name: "beta", root: "agents/beta/agent" });
  // Team-level env invariant: every member has a row of every name.
  store.seedEnvironment({ id: "env_a_prod", projectId: PROJECT.id, agentId: "agent_a", name: "production" });
  store.seedEnvironment({ id: "env_a_prev", projectId: PROJECT.id, agentId: "agent_a", name: "preview" });
  store.seedEnvironment({ id: "env_b_prod", projectId: PROJECT.id, agentId: "agent_b", name: "production" });
  store.seedEnvironment({ id: "env_b_prev", projectId: PROJECT.id, agentId: "agent_b", name: "preview" });
});

describe("shipRepoHead", () => {
  const HEAD_SHA = "face".repeat(10);
  // Injected head reader — no GitHub. Records its ref so we can assert the default branch flows in.
  function fakeBranchHead(sha = HEAD_SHA) {
    const calls: { installationId: string | number; ref?: string }[] = [];
    const fn: ShipDeps["branchHead"] = async (installationId, { ref }) => {
      calls.push({ installationId, ref });
      return { sha, branch: ref ?? "main" };
    };
    return { fn, calls };
  }

  it("deploys the whole member roster from the head sha, no change-set", async () => {
    const branchHead = fakeBranchHead();
    const result = await shipRepoHead(
      { project: PROJECT, envName: "production", createdBy: "user_1" },
      { store, branchHead: branchHead.fn },
    );

    expect(result.gitSha).toBe(HEAD_SHA);
    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);
    // A release was cut at the head sha for every roster member.
    expect(await store.releases.findByCommit("agent_a", HEAD_SHA)).not.toBeNull();
    expect(await store.releases.findByCommit("agent_b", HEAD_SHA)).not.toBeNull();
    // Deploys are queued in the requested env for every member.
    const queuedA = await store.deployments.listByEnvironment("env_a_prod");
    const queuedB = await store.deployments.listByEnvironment("env_b_prod");
    expect(queuedA).toHaveLength(1);
    expect(queuedB).toHaveLength(1);
    expect(queuedA[0].status).toBe("pending");
    // And the worker has a deploy job to pick up.
    expect((await store.jobs.claimNext(new Date()))?.kind).toBe("deploy_release");
  });

  it("is idempotent — a second ship at the same head reuses releases and re-queues a deploy", async () => {
    // Pre-existing release at the head sha for alpha (e.g. from a prior click).
    const existing = await store.releases.insert({
      projectId: PROJECT.id,
      agentId: "agent_a",
      version: "v1",
      gitSha: HEAD_SHA,
    });
    const branchHead = fakeBranchHead();

    const result = await shipRepoHead(
      { project: PROJECT, envName: "production" },
      { store, branchHead: branchHead.fn },
    );

    // No duplicate release for alpha at that sha — the existing one was reused.
    const alphaRelease = await store.releases.findByCommit("agent_a", HEAD_SHA);
    expect(alphaRelease?.id).toBe(existing.id);
    // Deploy still queued for the whole team.
    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect((await store.deployments.listByEnvironment("env_a_prod"))[0]?.status).toBe("pending");
  });

  it("throws when no member has the requested environment", async () => {
    const branchHead = fakeBranchHead();
    await expect(
      shipRepoHead(
        { project: PROJECT, envName: "staging" },
        { store, branchHead: branchHead.fn },
      ),
    ).rejects.toThrow(/no "staging" environment/i);
  });

  it("passes the project's default branch through to branchHead as ref", async () => {
    const branchHead = fakeBranchHead();
    await shipRepoHead(
      { project: { ...PROJECT, defaultBranch: "trunk" }, envName: "production" },
      { store, branchHead: branchHead.fn },
    );
    expect(branchHead.calls).toHaveLength(1);
    expect(branchHead.calls[0].ref).toBe("trunk");
    expect(branchHead.calls[0].installationId).toBe(PROJECT.repoInstallationId);
  });
});

describe("deployTeamVersion", () => {
  const SHA = "cafe".repeat(10);

  async function seedRelease(agentId: string, gitSha = SHA) {
    return store.releases.insert({
      projectId: PROJECT.id,
      agentId,
      version: "v1",
      gitSha,
    });
  }

  it("moves the whole team to a version by git sha, into each member's env of that name", async () => {
    await seedRelease("agent_a");
    await seedRelease("agent_b");

    const result = await deployTeamVersion(
      { projectId: PROJECT.id, gitSha: SHA, envName: "production", createdBy: "user_1" },
      { store },
    );

    expect(result.deployed.map((d) => d.agentName).sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);
    expect((await store.deployments.listByEnvironment("env_a_prod"))[0]?.status).toBe("pending");
    expect((await store.deployments.listByEnvironment("env_b_prod"))[0]?.status).toBe("pending");
  });

  it("skips a member that has no release at that sha, deploys the rest", async () => {
    await seedRelease("agent_a"); // only alpha has a release at SHA

    const result = await deployTeamVersion(
      { projectId: PROJECT.id, gitSha: SHA, envName: "production" },
      { store },
    );

    expect(result.deployed.map((d) => d.agentName)).toEqual(["alpha"]);
    expect(result.skipped).toEqual([{ agentName: "beta" }]);
  });

  it("throws when no member has that version in that environment", async () => {
    await seedRelease("agent_a");
    await seedRelease("agent_b");
    await expect(
      deployTeamVersion(
        { projectId: PROJECT.id, gitSha: SHA, envName: "staging" },
        { store },
      ),
    ).rejects.toThrow(/nothing to deploy/i);
  });
});
