import { afterEach, describe, expect, it, vi } from "vitest";

const { buildAssistantImage, getWorkspaceAssistantSelection } = vi.hoisted(
  () => ({
    buildAssistantImage: vi.fn(),
    getWorkspaceAssistantSelection: vi.fn(
      async (): Promise<{ model: string | null; effort: string | null }> => ({
        model: null,
        effort: null,
      }),
    ),
  }),
);

vi.mock("~/deploy/eve-image.server", () => ({ buildAssistantImage }));
vi.mock("~/org/workspace.server", () => ({ getWorkspaceAssistantSelection }));

import {
  assistantTemplateHash,
  ensureAssistantAgent,
  ensureAssistantInstance,
  peekAssistantInstance,
  runAssistantDeploy,
} from "~/assistant/instance.server";
import { makeFakeStore } from "../fakes/store";

describe("assistant instance: agent + environment", () => {
  it("creates the assistant agent (kind assistant) and its 'assistant' environment", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    const { agent, environment } = await ensureAssistantAgent("p", store);
    expect(agent).toMatchObject({
      kind: "assistant",
      name: "assistant",
      root: ".harnesst/assistant",
    });
    expect(environment.name).toBe("assistant");
    // Idempotent: a second call returns the same rows.
    const again = await ensureAssistantAgent("p", store);
    expect(again.agent.id).toBe(agent.id);
  });

  it("falls back to a non-colliding name if a legacy member owns 'assistant'", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    store.seedAgent({
      id: "m1",
      projectId: "p",
      name: "assistant",
      root: "agents/assistant/agent",
    });
    const { agent } = await ensureAssistantAgent("p", store);
    expect(agent.name).toBe("assistant-internal");
    expect(agent.kind).toBe("assistant");
  });
});
describe("assistant instance: template hash", () => {
  it("is a stable 16-char hex of the bundled template", async () => {
    const a = await assistantTemplateHash();
    const b = await assistantTemplateHash();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
  });
});

describe("assistant instance: provisioning", () => {
  it("persists a pending deployment, queues assistant_deploy, and reports provisioning", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    const instance = await ensureAssistantInstance("p", store);
    expect(instance.status).toBe("provisioning");
    // The `pending` row is created synchronously (#17): a loader re-read right after the provision
    // click must already see "provisioning" instead of racing the async worker.
    expect(instance.deploymentId).not.toBeNull();
    const snapshot = await peekAssistantInstance("p", store);
    expect(snapshot.status).toBe("provisioning");
    const stats = await store.jobs.statsByStatus();
    expect((stats.queued ?? 0) >= 1).toBe(true);
  });

  it("marks the pending deployment failed when the assistant image build fails", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    const pending = await ensureAssistantInstance("p", store);
    buildAssistantImage.mockRejectedValueOnce(
      new Error("assistant image build exploded"),
    );

    await expect(runAssistantDeploy({ projectId: "p" }, store)).rejects.toThrow(
      "assistant image build exploded",
    );

    const { environment } = await ensureAssistantAgent("p", store);
    const deployments = await store.deployments.listByEnvironment(
      environment.id,
    );
    expect(deployments).toHaveLength(1);
    expect(deployments[0]).toMatchObject({
      id: pending.deploymentId,
      status: "failed",
      errorDetail: expect.stringContaining("assistant image build exploded"),
    });
    expect(await peekAssistantInstance("p", store)).toMatchObject({
      status: "failed",
    });
  });

  it("does not enqueue a second deploy while one is already pending", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    const first = await ensureAssistantInstance("p", store);
    const second = await ensureAssistantInstance("p", store);
    // The second call finds the pending row and returns it — no duplicate row, no duplicate job.
    expect(second.deploymentId).toBe(first.deploymentId);
    const stats = await store.jobs.statsByStatus();
    expect(stats.queued ?? 0).toBe(1);
  });

  it("recovers when a concurrent request wins the pending-insert race (#31)", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    // Reproduce the race deterministically: both requests read the environment's deployments
    // BEFORE either has inserted its pending row, so both take the "nothing usable" branch and
    // race on insert. Serving [] for the first two reads is exactly that interleaving.
    const realList = store.deployments.listByEnvironment.bind(
      store.deployments,
    );
    let staleReads = 2;
    store.deployments.listByEnvironment = async (envId) =>
      staleReads-- > 0 ? [] : realList(envId);

    const first = await ensureAssistantInstance("p", store);
    const second = await ensureAssistantInstance("p", store);

    // The loser's insert hits deployments_env_inflight_uq and adopts the winner's row.
    expect(second.status).toBe("provisioning");
    expect(second.deploymentId).toBe(first.deploymentId);
    const stats = await store.jobs.statsByStatus();
    expect(stats.queued ?? 0).toBe(1);
  });

  it("never leaves two in-flight rows or two jobs under genuinely concurrent provisions", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    // Settle the agent/env rows first: their creation race is covered by unique indexes the
    // fake doesn't model. This test pins the deployment-level invariant only.
    await ensureAssistantAgent("p", store);
    const [a, b] = await Promise.all([
      ensureAssistantInstance("p", store),
      ensureAssistantInstance("p", store),
    ]);
    expect(a.deploymentId).toBe(b.deploymentId);
    const { environment } = await ensureAssistantAgent("p", store);
    const deployments = await store.deployments.listByEnvironment(
      environment.id,
    );
    expect(
      deployments.filter(
        (d) => d.status === "pending" || d.status === "building",
      ),
    ).toHaveLength(1);
    const stats = await store.jobs.statsByStatus();
    expect(stats.queued ?? 0).toBe(1);
  });
});

describe("assistant instance: peek reports resumable, not first-run setup", () => {
  async function seedDeployment(
    store: ReturnType<typeof makeFakeStore>,
    { gitSha, status, url }: { gitSha: string; status: string; url?: string },
  ) {
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    const { agent, environment } = await ensureAssistantAgent("p", store);
    const release = await store.releases.insert({
      projectId: "p",
      agentId: agent.id,
      version: "v1",
      gitSha,
    });
    const dep = await store.deployments.insert({
      environmentId: environment.id,
      releaseId: release.id,
      status,
      trafficWeight: 100,
    });
    if (url) await store.deployments.update(dep.id, { url });
    return dep;
  }

  it("reports resumable for a live deployment on a stale template sha (post-harnesst-upgrade)", async () => {
    const store = makeFakeStore();
    await seedDeployment(store, {
      gitSha: "tmpl-0000000000000000",
      status: "live",
      url: "http://inst:3000",
    });
    // Before the fix this read as "idle" and long-standing projects were shown first-run setup.
    expect(await peekAssistantInstance("p", store)).toMatchObject({
      status: "resumable",
    });
  });

  it("reports resumable for a stopped deployment", async () => {
    const store = makeFakeStore();
    await seedDeployment(store, {
      gitSha: `tmpl-${await assistantTemplateHash()}`,
      status: "stopped",
    });
    expect(await peekAssistantInstance("p", store)).toMatchObject({
      status: "resumable",
    });
  });

  it("reports resumable for a live deployment missing its url", async () => {
    const store = makeFakeStore();
    await seedDeployment(store, {
      gitSha: `tmpl-${await assistantTemplateHash()}`,
      status: "live",
    });
    expect(await peekAssistantInstance("p", store)).toMatchObject({
      status: "resumable",
    });
  });

  it("reports resumable when a stopped row coexists with failed attempts", async () => {
    const store = makeFakeStore();
    const dep = await seedDeployment(store, {
      gitSha: `tmpl-${await assistantTemplateHash()}`,
      status: "stopped",
    });
    const { agent } = await ensureAssistantAgent("p", store);
    const release = await store.releases.insert({
      projectId: "p",
      agentId: agent.id,
      version: "v2",
      gitSha: "tmpl-1111111111111111",
    });
    await store.deployments.insert({
      environmentId: dep.environmentId,
      releaseId: release.id,
      status: "failed",
      trafficWeight: 0,
    });
    expect(await peekAssistantInstance("p", store)).toMatchObject({
      status: "resumable",
    });
  });

  it("still reports idle when nothing was ever deployed", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    await ensureAssistantAgent("p", store);
    expect(await peekAssistantInstance("p", store)).toMatchObject({
      status: "idle",
    });
  });
});

describe("assistant instance: workspace model change re-provisions", () => {
  afterEach(() => {
    getWorkspaceAssistantSelection.mockImplementation(async () => ({
      model: null,
      effort: null,
    }));
  });

  it("reads a live deployment from an older selection as stale and re-provisions", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    getWorkspaceAssistantSelection.mockResolvedValue({
      model: "openrouter/abcdefghijkl/openai/gpt-5.6-sol",
      effort: null,
    });
    const first = await ensureAssistantInstance("p", store);
    await store.deployments.update(first.deploymentId!, {
      status: "live",
      url: "http://inst:3000",
    });
    // Same selection → the live instance is reused as-is.
    expect((await peekAssistantInstance("p", store)).status).toBe("live");
    const same = await ensureAssistantInstance("p", store);
    expect(same.status).toBe("live");
    expect(same.deploymentId).toBe(first.deploymentId);

    // The org picks a different model: the container's env was fixed at create, so the running
    // instance can never serve the new selection — it must read as stale, not "live".
    getWorkspaceAssistantSelection.mockResolvedValue({
      model: "codex/abcdefghijkl/gpt-5.6-sol",
      effort: null,
    });
    expect((await peekAssistantInstance("p", store)).status).toBe("resumable");
    const next = await ensureAssistantInstance("p", store);
    expect(next.status).toBe("provisioning");
    expect(next.deploymentId).not.toBe(first.deploymentId);
  });

  it("reads an effort-only change as stale too (effort is baked into the container env)", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    getWorkspaceAssistantSelection.mockResolvedValue({
      model: "codex/abcdefghijkl/gpt-5.6-sol",
      effort: null,
    });
    const first = await ensureAssistantInstance("p", store);
    await store.deployments.update(first.deploymentId!, {
      status: "live",
      url: "http://inst:3000",
    });
    getWorkspaceAssistantSelection.mockResolvedValue({
      model: "codex/abcdefghijkl/gpt-5.6-sol",
      effort: "high",
    });
    expect((await peekAssistantInstance("p", store)).status).toBe("resumable");
  });
});

describe("fake store: in-flight deployment uniqueness", () => {
  it("rejects a second pending row for the same environment like Postgres would", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    store.seedAgent({ id: "a1", projectId: "p" });
    store.seedEnvironment({ id: "e1", projectId: "p", agentId: "a1" });
    const release = await store.releases.insert({
      projectId: "p",
      agentId: "a1",
      version: "v1",
      gitSha: "sha",
    });
    await store.deployments.insert({
      environmentId: "e1",
      releaseId: release.id,
      status: "pending",
      trafficWeight: 100,
    });
    await expect(
      store.deployments.insert({
        environmentId: "e1",
        releaseId: release.id,
        status: "building",
        trafficWeight: 100,
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint_name: "deployments_env_inflight_uq",
    });
    // Non-in-flight statuses stay unconstrained (a cutover transiently has two live rows).
    await expect(
      store.deployments.insert({
        environmentId: "e1",
        releaseId: release.id,
        status: "queued",
        trafficWeight: 100,
      }),
    ).resolves.toBeTruthy();
  });
});
