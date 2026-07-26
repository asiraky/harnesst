/**
 * Roster-change teammate refresh (Team delegation — D7) against the in-memory fake store. Pins:
 * membership-unchanged and single-agent no-ops, a live member env getting a same-release queued
 * redeploy, an env with an in-flight deploy being skipped (the ship-then-webhook downgrade race —
 * queueing the stale live release would land after the ship's job and revert the member), and a
 * member without a live deployment being skipped.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { refreshTeammatesForRosterChange } from "~/deploy/teammate-refresh.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT = "proj_1";

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT, orgId: "org_1", repoOwner: "acme", repoName: "team" });
});

function seedMember(id: string, envId: string) {
  store.seedAgent({ id, projectId: PROJECT, name: id, root: `agents/${id}/agent` });
  store.seedEnvironment({ id: envId, projectId: PROJECT, agentId: id, name: "production" });
}

async function seedLive(agentId: string, envId: string): Promise<string> {
  const rel = await store.releases.insert({
    projectId: PROJECT,
    agentId,
    version: "v1",
    gitSha: agentId.repeat(2).padEnd(40, "a").slice(0, 40),
  });
  const dep = await store.deployments.insert({
    environmentId: envId,
    releaseId: rel.id,
    status: "live",
    trafficWeight: 100,
  });
  await store.deployments.update(dep.id, { url: "http://x" });
  return rel.id;
}

describe("refreshTeammatesForRosterChange", () => {
  it("is a no-op when membership is unchanged", async () => {
    seedMember("pm", "env_pm");
    await seedLive("pm", "env_pm");
    const queued = await refreshTeammatesForRosterChange(
      { projectId: PROJECT, previousNames: ["pm"], currentNames: ["pm"] },
      store,
    );
    expect(queued).toBe(0);
    expect(await store.jobs.claimNext(new Date())).toBeNull();
  });

  it("is a no-op for a single-agent repo", async () => {
    store.seedAgent({ id: "solo", projectId: PROJECT, name: "solo", root: "agent" });
    store.seedEnvironment({ id: "env_solo", projectId: PROJECT, agentId: "solo", name: "production" });
    await seedLive("solo", "env_solo");
    const queued = await refreshTeammatesForRosterChange(
      { projectId: PROJECT, previousNames: [], currentNames: ["solo"] },
      store,
    );
    expect(queued).toBe(0);
  });

  it("queues a same-release redeploy for a live member env on membership change", async () => {
    seedMember("pm", "env_pm");
    const liveRelease = await seedLive("pm", "env_pm");
    seedMember("deployer", "env_dep"); // the new member — no live deployment yet

    const queued = await refreshTeammatesForRosterChange(
      { projectId: PROJECT, previousNames: ["pm"], currentNames: ["pm", "deployer"] },
      store,
    );

    expect(queued).toBe(1);
    const rows = await store.deployments.listByEnvironment("env_pm");
    const queuedRow = rows.find((d) => d.status === "pending");
    expect(queuedRow?.releaseId).toBe(liveRelease); // image reuse: the CURRENT live release
    expect((await store.jobs.claimNext(new Date()))?.kind).toBe("deploy_release");
  });

  it("skips an env with an in-flight deploy (ship-then-webhook downgrade race)", async () => {
    seedMember("pm", "env_pm");
    await seedLive("pm", "env_pm"); // pre-merge release, still live
    // The in-app ship already queued pm's NEW release into the same env.
    const newRel = await store.releases.insert({
      projectId: PROJECT,
      agentId: "pm",
      version: "v2",
      gitSha: "f".repeat(40),
    });
    await store.deployments.insert({
      environmentId: "env_pm",
      releaseId: newRel.id,
      status: "pending",
      trafficWeight: 100,
    });
    seedMember("deployer", "env_dep");

    const queued = await refreshTeammatesForRosterChange(
      { projectId: PROJECT, previousNames: ["pm"], currentNames: ["pm", "deployer"] },
      store,
    );

    // No refresh row: queueing the stale live release would land after the ship's job (FIFO
    // worker) and silently revert pm to pre-merge code.
    expect(queued).toBe(0);
    const rows = await store.deployments.listByEnvironment("env_pm");
    expect(rows.filter((d) => d.status === "pending")).toHaveLength(1); // only the ship's
  });

  it("also skips while a deploy is mid-build (building)", async () => {
    seedMember("pm", "env_pm");
    await seedLive("pm", "env_pm");
    const newRel = await store.releases.insert({
      projectId: PROJECT,
      agentId: "pm",
      version: "v2",
      gitSha: "e".repeat(40),
    });
    await store.deployments.insert({
      environmentId: "env_pm",
      releaseId: newRel.id,
      status: "building",
      trafficWeight: 100,
    });
    seedMember("deployer", "env_dep");

    const queued = await refreshTeammatesForRosterChange(
      { projectId: PROJECT, previousNames: ["pm"], currentNames: ["pm", "deployer"] },
      store,
    );
    expect(queued).toBe(0);
  });

  it("fires for a pure rename (a name swap counts as a membership change)", async () => {
    // pm renamed → product: the other live member must refresh so HARNESST_TEAMMATES reflects it.
    seedMember("other", "env_other");
    const liveRelease = await seedLive("other", "env_other");

    const queued = await refreshTeammatesForRosterChange(
      { projectId: PROJECT, previousNames: ["pm", "other"], currentNames: ["product", "other"] },
      store,
    );

    expect(queued).toBe(1);
    const rows = await store.deployments.listByEnvironment("env_other");
    expect(rows.find((d) => d.status === "pending")?.releaseId).toBe(liveRelease);
  });

  it("skips a member without a live deployment", async () => {
    seedMember("pm", "env_pm"); // never deployed
    seedMember("deployer", "env_dep");

    const queued = await refreshTeammatesForRosterChange(
      { projectId: PROJECT, previousNames: ["pm"], currentNames: ["pm", "deployer"] },
      store,
    );
    expect(queued).toBe(0);
    expect(await store.jobs.claimNext(new Date())).toBeNull();
  });
});
