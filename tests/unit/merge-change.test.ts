/**
 * Merge-a-change runner (issue #142) — pins runMergeChange, the body that moved off the synchronous
 * deployments route onto the durable job queue. All GitHub/runtime seams are injected as vi.fn()s so
 * no test touches the network or docker; progress and outcome are read back off the fake store's
 * workspace task. The contract under test:
 *   - conversation branches gate on a pre-merge build of EVERY affected member root (recomputed
 *     server-side from the PR's changed files — issue #137, via the real runConversationMergeGate);
 *     a failing gate is the task's OUTCOME (fail the task, DO NOT merge, resolve without throwing
 *     so the job is `done`);
 *   - a passing merge cuts releases, discards the conversation checkout, and completes with a
 *     result URL carrying the new version;
 *   - non-conversation branches skip the gate and the checkout discard;
 *   - roster sync is warn-only (a throw there still completes the task);
 *   - a thrown merge/release error fails the task AND rethrows so the queue records it;
 *   - a project with no connected repo throws before touching the task.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMergeChange, type MergeChangeDeps } from "~/deploy/merge-change.server";
import { createTask } from "~/tasks/tasks.server";
import type { WorkspaceTask } from "~/data/ports";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT = "proj_1";

function makeDeps(over: Partial<MergeChangeDeps> = {}): MergeChangeDeps {
  return {
    checkBuild: vi.fn().mockResolvedValue({ ok: true }),
    listPullRequestFilePaths: vi.fn().mockResolvedValue(["agent/agent.ts"]),
    mergePullRequest: vi.fn().mockResolvedValue({ mergeSha: "sha123" }),
    fetchAgentSource: vi.fn().mockResolvedValue({ paths: ["agent/agent.ts"] }),
    detectAgentRoots: vi.fn().mockReturnValue([]),
    syncProjectAgents: vi.fn().mockResolvedValue(undefined),
    invalidateRepoSource: vi.fn(),
    warmAgentSource: vi.fn(),
    ensureReleasesForCommit: vi
      .fn()
      .mockResolvedValue([{ release: { version: "v3" }, created: true }]),
    discardConversationCheckoutByBranch: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as MergeChangeDeps;
}

async function seedTask(subjectKey = "merge:5"): Promise<WorkspaceTask> {
  return createTask(
    {
      projectId: PROJECT,
      kind: "merge_change",
      subjectKey,
      label: "Merging change #5",
      originUrl: "/repos/proj_1/agents/x/deployment",
    },
    store,
  );
}

function payload(over: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    taskId: "",
    pullNumber: 5,
    title: "Add a tool",
    backUrl: "/repos/proj_1/agents/x/deployment",
    ...over,
  } as Parameters<typeof runMergeChange>[0];
}

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({
    id: PROJECT,
    orgId: "org_1",
    repoOwner: "acme",
    repoName: "agent",
    repoInstallationId: "inst_1",
    defaultBranch: "main",
  });
});

describe("runMergeChange", () => {
  it("fails the task and does not merge when a conversation branch fails the build gate", async () => {
    const task = await seedTask();
    const deps = makeDeps({
      checkBuild: vi.fn().mockResolvedValue({ ok: false, output: "boom" }),
    });

    await expect(
      runMergeChange(payload({ taskId: task.id, branch: "eden/conv-abc" }), deps, store),
    ).resolves.toBeUndefined();

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("boom");
    expect(row?.error).toContain("can't be merged");
    expect(deps.mergePullRequest).not.toHaveBeenCalled();
  });

  it("merges, cuts releases, discards the checkout, and completes with a versioned result URL", async () => {
    const task = await seedTask();
    const deps = makeDeps();

    await runMergeChange(
      payload({ taskId: task.id, branch: "eden/conv-abc" }),
      deps,
      store,
    );

    expect(deps.checkBuild).toHaveBeenCalledOnce();
    expect(deps.mergePullRequest).toHaveBeenCalledWith(
      "inst_1",
      { owner: "acme", repo: "agent" },
      5,
      "eden/conv-abc",
    );
    expect(deps.ensureReleasesForCommit).toHaveBeenCalledOnce();
    expect(deps.discardConversationCheckoutByBranch).toHaveBeenCalledWith("eden/conv-abc");

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("succeeded");
    expect(row?.resultUrl).toBe("/repos/proj_1/agents/x/deployment?released=v3");
  });

  it("builds every affected member root on a team layout", async () => {
    store.seedProject({
      id: "team_1",
      orgId: "org_1",
      repoOwner: "acme",
      repoName: "team",
      repoInstallationId: "inst_1",
      defaultBranch: "main",
      layout: "team",
    });
    const task = await createTask(
      {
        projectId: "team_1",
        kind: "merge_change",
        subjectKey: "merge:5",
        label: "Merging change #5",
        originUrl: "/repos/team_1/deployment",
      },
      store,
    );
    const checkBuild = vi.fn().mockResolvedValue({ ok: true });
    const deps = makeDeps({
      checkBuild,
      listPullRequestFilePaths: vi
        .fn()
        .mockResolvedValue([
          "agents/pm/agent/channels/github.ts",
          "agents/reviewer/agent/index.ts",
          ".eden/config.json",
        ]),
    });

    await runMergeChange(
      payload({ projectId: "team_1", taskId: task.id, branch: "eden/conv-abc" }),
      deps,
      store,
    );

    // One build per member root the PR spans (`.eden/**` maps to none).
    expect(checkBuild).toHaveBeenCalledTimes(2);
    expect(checkBuild.mock.calls.map((c) => c[0].agentRoot)).toEqual([
      "agents/pm/agent",
      "agents/reviewer/agent",
    ]);
    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
  });

  it("skips the gate and the checkout discard for a non-conversation branch", async () => {
    const task = await seedTask();
    const deps = makeDeps();

    await runMergeChange(payload({ taskId: task.id, branch: "feature/x" }), deps, store);

    expect(deps.checkBuild).not.toHaveBeenCalled();
    expect(deps.listPullRequestFilePaths).not.toHaveBeenCalled();
    expect(deps.mergePullRequest).toHaveBeenCalledOnce();
    expect(deps.discardConversationCheckoutByBranch).not.toHaveBeenCalled();
    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
  });

  it("still completes the task when the warn-only roster sync throws", async () => {
    const task = await seedTask();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      fetchAgentSource: vi.fn().mockRejectedValue(new Error("tree read hiccup")),
    });

    await runMergeChange(payload({ taskId: task.id, branch: "feature/x" }), deps, store);

    expect(deps.ensureReleasesForCommit).toHaveBeenCalledOnce();
    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("succeeded");
    warn.mockRestore();
  });

  it("fails the task and rethrows when the merge itself rejects", async () => {
    const task = await seedTask();
    const deps = makeDeps({
      mergePullRequest: vi.fn().mockRejectedValue(new Error("merge conflict")),
    });

    await expect(
      runMergeChange(payload({ taskId: task.id, branch: "feature/x" }), deps, store),
    ).rejects.toThrow("merge conflict");

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("merge conflict");
  });

  it("throws (leaving no task work) when the project has no connected repo", async () => {
    store.seedProject({ id: "bare", orgId: "org_1" }); // repo fields null
    const task = await createTask(
      {
        projectId: "bare",
        kind: "merge_change",
        subjectKey: "merge:9",
        label: "x",
        originUrl: "/repos/bare",
      },
      store,
    );

    await expect(
      runMergeChange(payload({ projectId: "bare", taskId: task.id }), makeDeps(), store),
    ).rejects.toThrow(/no connected repo/);

    expect((await store.workspaceTasks.findById(task.id))?.status).toBe("running");
  });
});
