/**
 * The publish pipeline (issue #225) — pins runPublish + startPublish, the one way a change goes
 * live: check → build → commit → version → deploy, recorded step by step on the workspace task.
 * All GitHub/docker/runtime seams are injected as vi.fn()s (zero I/O); releases, deployments and
 * queued jobs are asserted through the fake store via the REAL ensureReleasesForCommit/queueDeploy
 * path. Contract under test:
 *   - the happy path runs every step, deletes the published drafts only after the commit, cuts one
 *     release per member, promotes the publish build's images, and queues rebuild-free deploys;
 *   - a build failure is the task's outcome: no commit, no release, no deploy, drafts kept, the
 *     failed step carries the compiler output, later steps stay pending;
 *   - the orphan gate fails at `check` before anything builds;
 *   - assistant-config-only publishes skip build/version/deploy (visible, with a reason) and
 *     enqueue an assistant restart instead;
 *   - a CAS miss on the commit rebuilds and retries exactly once, then fails with the
 *     "someone else changed this repository" message;
 *   - §2.8 env resolution: a single env auto-resolves and persists, a persisted value never asks,
 *     a multi-env project with no answer fails at `check`;
 *   - §2.9 dedupe: one publish per project at a time;
 *   - only project/task load failures rethrow (genuine queue errors).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineStepStatus } from "~/data/ports";
import { NonFastForwardError } from "~/github/write.server";
import {
  initialPublishSteps,
  runPublish,
  startPublish,
  type PublishPipelineDeps,
} from "~/publish/pipeline.server";
import { ensureReleasesForCommit, queueDeploy } from "~/deploy/controller.server";
import { listTeamEnvNames } from "~/deploy/environments.server";
import { enqueue } from "~/jobs/queue.server";
import { createTask } from "~/tasks/tasks.server";
import type { WorkspaceTask } from "~/data/ports";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT = "proj_1";
const SHA = "cafebabe00112233445566778899aabbccddeeff";

function seedTeam(opts: { envNames?: string[]; live?: string | null } = {}): void {
  store.seedProject({
    id: PROJECT,
    orgId: "org_1",
    layout: "team",
    repoOwner: "acme",
    repoName: "team",
    repoInstallationId: "inst_1",
    defaultBranch: "main",
    liveEnvironmentName: opts.live ?? null,
  });
  store.seedAgent({ id: "agent_ivy", projectId: PROJECT, name: "ivy", root: "agents/ivy/agent" });
  store.seedAgent({
    id: "agent_otto",
    projectId: PROJECT,
    name: "otto",
    root: "agents/otto/agent",
  });
  for (const name of opts.envNames ?? ["production"]) {
    store.seedEnvironment({ id: `env_ivy_${name}`, projectId: PROJECT, agentId: "agent_ivy", name });
    store.seedEnvironment({
      id: `env_otto_${name}`,
      projectId: PROJECT,
      agentId: "agent_otto",
      name,
    });
  }
}

async function stageDrafts(paths: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(paths)) {
    const agentId = path.startsWith("agents/ivy/")
      ? "agent_ivy"
      : path.startsWith("agents/otto/")
        ? "agent_otto"
        : null;
    await store.drafts.upsert({ projectId: PROJECT, agentId, path, content });
  }
}

async function seedTask(): Promise<WorkspaceTask> {
  return createTask(
    {
      projectId: PROJECT,
      kind: "publish",
      subjectKey: "publish",
      label: "Publishing changes",
      originUrl: "/repos/proj_1",
      steps: initialPublishSteps(),
    },
    store,
  );
}

function makeDeps(over: Partial<PublishPipelineDeps> = {}): PublishPipelineDeps {
  return {
    checkBuild: vi.fn(async (req: { agentRoot?: string }) => ({
      ok: true as const,
      provisionalTag: `eden/publish-task:${req.agentRoot ?? "repo"}`,
    })),
    listRepoPaths: vi
      .fn()
      .mockResolvedValue(["agents/ivy/agent/agent.ts", "agents/otto/agent/agent.ts"]),
    normalizeDrafts: vi.fn(async ({ files }: { files: unknown }) => files),
    commitToDefaultBranch: vi.fn().mockResolvedValue({ sha: SHA }),
    fetchAgentSource: vi.fn().mockResolvedValue({ paths: [] }),
    detectAgentRoots: vi.fn().mockReturnValue([]),
    syncProjectAgents: vi.fn().mockResolvedValue([]),
    invalidateRepoSource: vi.fn(),
    warmAgentSource: vi.fn(),
    ensureReleasesForCommit,
    queueDeploy,
    listTeamEnvNames: (projectId, s) => listTeamEnvNames(projectId, { store: s }),
    promoteImage: vi.fn(
      async (input: { provisionalTag: string; gitSha: string; agentRoot?: string }) => ({
        imageRef: `promoted:${input.agentRoot}@${input.gitSha.slice(0, 12)}`,
        digest: "sha256:abc",
      }),
    ),
    removeProvisionalImages: vi.fn().mockResolvedValue(undefined),
    discardConversationCheckouts: vi.fn().mockResolvedValue(undefined),
    enqueueJob: enqueue,
    ...over,
  } as PublishPipelineDeps;
}

function payload(taskId: string, over: Record<string, unknown> = {}) {
  return { projectId: PROJECT, taskId, createdBy: "user_1", ...over };
}

async function stepStatuses(taskId: string): Promise<Record<string, PipelineStepStatus>> {
  const row = await store.workspaceTasks.findById(taskId);
  return Object.fromEntries((row?.steps ?? []).map((s) => [s.key, s.status])) as Record<
    string,
    PipelineStepStatus
  >;
}

async function drainJobs(): Promise<{ kind: string; payload: Record<string, unknown> }[]> {
  const out: { kind: string; payload: Record<string, unknown> }[] = [];
  for (;;) {
    const job = await store.jobs.claimNext(new Date());
    if (!job) return out;
    out.push({ kind: job.kind, payload: job.payload });
  }
}

beforeEach(() => {
  store = makeFakeStore();
});

describe("runPublish — happy path", () => {
  it("runs every step, deletes drafts after the commit, promotes images, queues rebuild-free deploys", async () => {
    seedTeam();
    await stageDrafts({
      "agents/ivy/agent/agent.ts": "export default {};",
      "agents/otto/agent/agent.ts": "export default {};",
    });
    const task = await seedTask();

    // Capture the build step's live state at each build call: the running substep + (i of n).
    const observed: { status: PipelineStepStatus; detail?: string }[] = [];
    const deps = makeDeps({
      checkBuild: vi.fn(async (req: { agentRoot?: string }) => {
        const row = await store.workspaceTasks.findById(task.id);
        const build = row!.steps!.find((s) => s.key === "build")!;
        observed.push({ status: build.status, detail: build.detail });
        return { ok: true as const, provisionalTag: `eden/publish-task:${req.agentRoot}` };
      }),
    });

    await runPublish(payload(task.id), deps, store);

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("succeeded");
    expect(await stepStatuses(task.id)).toEqual({
      check: "succeeded",
      build: "succeeded",
      commit: "succeeded",
      version: "succeeded",
      deploy: "succeeded",
    });
    // The build step was visibly running, with per-root progress, while each root built.
    expect(observed).toEqual([
      { status: "running", detail: "ivy (1 of 2)" },
      { status: "running", detail: "otto (2 of 2)" },
    ]);
    // The succeeded version step records the team version label — the panel's "Live · vN"
    // success headline reads it off the steps.
    expect(row!.steps!.find((s) => s.key === "version")?.detail).toBe("v1");

    // Commit carried both files; drafts were deleted only after it landed.
    expect(deps.commitToDefaultBranch).toHaveBeenCalledOnce();
    expect(await store.drafts.listByProject(PROJECT)).toEqual([]);
    expect(deps.discardConversationCheckouts).toHaveBeenCalledWith(PROJECT);

    // One release per member at the commit, each promoted to the publish build's image.
    const ivyRelease = await store.releases.findByCommit("agent_ivy", SHA);
    const ottoRelease = await store.releases.findByCommit("agent_otto", SHA);
    expect(ivyRelease?.imageRef).toBe(`promoted:agents/ivy/agent@${SHA.slice(0, 12)}`);
    expect(ottoRelease?.imageRef).toBe(`promoted:agents/otto/agent@${SHA.slice(0, 12)}`);

    // One rebuild-free deploy per member into the live env.
    const jobs = await drainJobs();
    expect(jobs.map((j) => j.kind)).toEqual(["deploy_release", "deploy_release"]);
    expect(jobs.every((j) => j.payload.rebuild === false)).toBe(true);
    expect((await store.deployments.listByEnvironment("env_ivy_production")).length).toBe(1);
    expect((await store.deployments.listByEnvironment("env_otto_production")).length).toBe(1);

    // Provisional tags never outlive the publish.
    expect(deps.removeProvisionalImages).toHaveBeenCalledWith([
      "eden/publish-task:agents/ivy/agent",
      "eden/publish-task:agents/otto/agent",
    ]);
  });

  it("promotes only the touched root — untouched members deploy without an imageRef", async () => {
    seedTeam();
    await stageDrafts({ "agents/ivy/agent/agent.ts": "export default {};" });
    const task = await seedTask();
    const deps = makeDeps();

    await runPublish(payload(task.id), deps, store);

    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
    expect((await store.releases.findByCommit("agent_ivy", SHA))?.imageRef).toBe(
      `promoted:agents/ivy/agent@${SHA.slice(0, 12)}`,
    );
    // otto still gets a release + deploy — the team is the deployment unit — but builds at
    // deploy time (no pre-set imageRef).
    expect((await store.releases.findByCommit("agent_otto", SHA))?.imageRef).toBeNull();
    const jobs = await drainJobs();
    expect(jobs.filter((j) => j.kind === "deploy_release").length).toBe(2);
    expect(deps.promoteImage).toHaveBeenCalledOnce();
  });

  it("leaves conversation checkouts alone when every published draft was human-staged", async () => {
    seedTeam();
    // A human save always carries a user id; assistant-staged drafts are the authorless ones.
    await store.drafts.upsert({
      projectId: PROJECT,
      agentId: "agent_ivy",
      path: "agents/ivy/agent/agent.ts",
      content: "export default {};",
      createdBy: "user_1",
    });
    const task = await seedTask();
    const deps = makeDeps();

    await runPublish(payload(task.id), deps, store);

    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
    expect(deps.discardConversationCheckouts).not.toHaveBeenCalled();
  });
});

describe("runPublish — failures leave nothing landed", () => {
  it("build failure: no commit, no release, no deploy; drafts kept; later steps pending", async () => {
    seedTeam();
    await stageDrafts({ "agents/ivy/agent/agent.ts": "broken" });
    const task = await seedTask();
    const deps = makeDeps({
      checkBuild: vi
        .fn()
        .mockResolvedValue({ ok: false, output: "TS2304: Cannot find name 'foo'." }),
    });

    await expect(runPublish(payload(task.id), deps, store)).resolves.toBeUndefined();

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("TS2304");
    expect(await stepStatuses(task.id)).toEqual({
      check: "succeeded",
      build: "failed",
      commit: "pending",
      version: "pending",
      deploy: "pending",
    });
    const build = row!.steps!.find((s) => s.key === "build")!;
    expect(build.error).toContain("TS2304");
    expect(build.substeps?.[0]).toMatchObject({ status: "failed" });

    expect(deps.commitToDefaultBranch).not.toHaveBeenCalled();
    expect((await store.drafts.listByProject(PROJECT)).length).toBe(1);
    expect(await store.releases.findByCommit("agent_ivy", SHA)).toBeNull();
    expect(await drainJobs()).toEqual([]);
  });

  it("orphan gate: fails at check before anything builds", async () => {
    seedTeam();
    // A lone package.json under a member nothing backs — the classic stranded draft.
    await store.drafts.upsert({
      projectId: PROJECT,
      agentId: null,
      path: "agents/ghost/package.json",
      content: "{}",
    });
    const task = await seedTask();
    const deps = makeDeps({ listRepoPaths: vi.fn().mockResolvedValue([]) });

    await runPublish(payload(task.id), deps, store);

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("no longer part of this team");
    expect(await stepStatuses(task.id)).toMatchObject({ check: "failed", build: "pending" });
    expect(deps.checkBuild).not.toHaveBeenCalled();
    expect((await store.drafts.listByProject(PROJECT)).length).toBe(1);
  });
});

describe("runPublish — assistant-config-only", () => {
  it("skips build/version/deploy with a reason and enqueues an assistant restart", async () => {
    seedTeam();
    await stageDrafts({ ".eden/assistant/instructions.md": "Be helpful." });
    const task = await seedTask();
    const deps = makeDeps();

    await runPublish(payload(task.id), deps, store);

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("succeeded");
    expect(await stepStatuses(task.id)).toEqual({
      check: "succeeded",
      build: "skipped",
      commit: "succeeded",
      version: "skipped",
      deploy: "skipped",
    });
    for (const key of ["build", "version", "deploy"]) {
      expect(row!.steps!.find((s) => s.key === key)!.reason).toContain("assistant");
    }
    expect(deps.checkBuild).not.toHaveBeenCalled();
    expect(deps.commitToDefaultBranch).toHaveBeenCalledOnce();
    expect(await store.drafts.listByProject(PROJECT)).toEqual([]);
    expect(await store.releases.findByCommit("agent_ivy", SHA)).toBeNull();

    const jobs = await drainJobs();
    expect(jobs.map((j) => j.kind)).toEqual(["assistant_restart"]);
    expect(jobs[0].payload.projectId).toBe(PROJECT);
  });
});

describe("runPublish — CAS conflict on the commit", () => {
  it("rebuilds and retries once, then succeeds", async () => {
    seedTeam();
    await stageDrafts({ "agents/ivy/agent/agent.ts": "export default {};" });
    const task = await seedTask();
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new NonFastForwardError("main"))
      .mockResolvedValue({ sha: SHA });
    const deps = makeDeps({ commitToDefaultBranch: commit });

    await runPublish(payload(task.id), deps, store);

    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
    expect(commit).toHaveBeenCalledTimes(2);
    // The rebuild ran the build again (one root, so two builds total)…
    expect(deps.checkBuild).toHaveBeenCalledTimes(2);
    // …and BOTH passes' provisional tags were cleaned up.
    expect(deps.removeProvisionalImages).toHaveBeenCalledWith([
      "eden/publish-task:agents/ivy/agent",
      "eden/publish-task:agents/ivy/agent",
    ]);
  });

  it("fails with the clear message when the retry also loses the race", async () => {
    seedTeam();
    await stageDrafts({ "agents/ivy/agent/agent.ts": "export default {};" });
    const task = await seedTask();
    const deps = makeDeps({
      commitToDefaultBranch: vi.fn().mockRejectedValue(new NonFastForwardError("main")),
    });

    await runPublish(payload(task.id), deps, store);

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(
      "Someone else changed this repository while we were publishing. Try publishing again.",
    );
    expect(await stepStatuses(task.id)).toMatchObject({
      commit: "failed",
      version: "pending",
      deploy: "pending",
    });
    // Drafts survive a failed publish.
    expect((await store.drafts.listByProject(PROJECT)).length).toBe(1);
    expect(await drainJobs()).toEqual([]);
  });
});

describe("runPublish — §2.8 environment resolution", () => {
  it("a single env auto-resolves and persists as the live environment", async () => {
    seedTeam({ envNames: ["production"] });
    await stageDrafts({ "agents/ivy/agent/agent.ts": "export default {};" });
    const task = await seedTask();

    await runPublish(payload(task.id), makeDeps(), store);

    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
    expect((await store.projects.findById(PROJECT))?.liveEnvironmentName).toBe("production");
  });

  it("a persisted live environment never asks, even with multiple envs", async () => {
    seedTeam({ envNames: ["production", "preview"], live: "preview" });
    await stageDrafts({ "agents/ivy/agent/agent.ts": "export default {};" });
    const task = await seedTask();

    await runPublish(payload(task.id), makeDeps(), store);

    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
    expect((await store.deployments.listByEnvironment("env_ivy_preview")).length).toBe(1);
    expect((await store.deployments.listByEnvironment("env_ivy_production")).length).toBe(0);
  });

  it("multiple envs with nothing persisted and no answer fails at check", async () => {
    seedTeam({ envNames: ["production", "preview"] });
    await stageDrafts({ "agents/ivy/agent/agent.ts": "export default {};" });
    const task = await seedTask();
    const deps = makeDeps();

    await runPublish(payload(task.id), deps, store);

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("more than one environment");
    expect(await stepStatuses(task.id)).toMatchObject({ check: "failed", build: "pending" });
    expect(deps.checkBuild).not.toHaveBeenCalled();
  });

  it("the panel's one-time answer is used and persisted", async () => {
    seedTeam({ envNames: ["production", "preview"] });
    await stageDrafts({ "agents/ivy/agent/agent.ts": "export default {};" });
    const task = await seedTask();

    await runPublish(payload(task.id, { envName: "preview" }), makeDeps(), store);

    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
    expect((await store.projects.findById(PROJECT))?.liveEnvironmentName).toBe("preview");
    expect((await store.deployments.listByEnvironment("env_ivy_preview")).length).toBe(1);
  });
});

describe("startPublish — §2.9 one publish per project", () => {
  it("creates the task with every step visible, enqueues the job, and dedupes re-runs", async () => {
    seedTeam();
    await stageDrafts({ "agents/ivy/agent/agent.ts": "export default {};" });

    const first = await startPublish(
      { projectId: PROJECT, originUrl: "/repos/proj_1", createdBy: "user_1" },
      store,
    );
    expect(first.alreadyRunning).toBe(false);
    const task = await store.workspaceTasks.findById(first.taskId);
    expect(task?.subjectKey).toBe("publish");
    expect(task?.label).toBe("Publishing 1 change");
    expect(task?.steps?.map((s) => s.status)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    const second = await startPublish(
      { projectId: PROJECT, originUrl: "/repos/proj_1" },
      store,
    );
    expect(second).toEqual({ taskId: first.taskId, alreadyRunning: true });

    const jobs = await drainJobs();
    expect(jobs.filter((j) => j.kind === "publish").length).toBe(1);
    expect(jobs[0].payload.taskId).toBe(first.taskId);
    expect(task?.jobId).not.toBeNull();
  });

  it("refuses to publish nothing", async () => {
    seedTeam();
    await expect(
      startPublish({ projectId: PROJECT, originUrl: "/repos/proj_1" }, store),
    ).rejects.toThrow(/Nothing to publish/);
  });
});

describe("runPublish — queue-error policy", () => {
  it("rethrows when the task is missing", async () => {
    seedTeam();
    await expect(runPublish(payload("gone"), makeDeps(), store)).rejects.toThrow(
      /task gone not found/,
    );
  });

  it("rethrows when the project has no connected repo", async () => {
    store.seedProject({ id: "bare", orgId: "org_1" });
    await expect(
      runPublish({ projectId: "bare", taskId: "irrelevant" }, makeDeps(), store),
    ).rejects.toThrow(/no connected repo/);
  });
});
