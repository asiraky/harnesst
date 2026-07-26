/**
 * Workspace task projection (issue #142) — pins tasks.server.ts and the WorkspaceTaskRepo contract
 * behind the persistent task-progress indicator. A task is the small, project-scoped, user-facing
 * record a runner records its pipeline steps into and resolves to a terminal state; the
 * indicator polls listActive for it. These tests run entirely against the in-memory fake store.
 *
 * Note on the window test: the fake timestamps rows with a tiny seq-based epoch (~0), so going
 * through listWorkspaceTasks (which cuts at the real Date.now()-24h) would exclude every terminal
 * row. The window contract is therefore pinned by calling store.workspaceTasks.listActive directly
 * with an explicit terminalSince.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { PipelineStep } from "~/data/ports";
import {
  completeTask,
  createTask,
  dismissTask,
  failTask,
  findRunningTask,
  updateTaskSteps,
} from "~/tasks/tasks.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT = "proj_1";

const base = {
  projectId: PROJECT,
  kind: "publish",
  subjectKey: "publish",
  label: "Publishing 1 change",
  originUrl: "/repos/proj_1",
};

const steps = (status: PipelineStep["status"]): PipelineStep[] => [
  { key: "check", label: "Checking your changes", status },
];

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT, orgId: "org_1" });
});

describe("task lifecycle", () => {
  it("createTask starts a task running with its initial steps", async () => {
    const task = await createTask({ ...base, steps: steps("pending") }, store);
    expect(task.status).toBe("running");
    expect(task.projectId).toBe(PROJECT);
    expect(task.subjectKey).toBe("publish");
    expect(task.steps?.[0]).toMatchObject({ key: "check", status: "pending" });
    expect(task.resultUrl).toBeNull();
    expect(task.dismissedAt).toBeNull();
  });

  it("updateTaskSteps records the pipeline's current step list", async () => {
    const task = await createTask(base, store);
    await updateTaskSteps(task.id, steps("running"), store);
    expect((await store.workspaceTasks.findById(task.id))?.steps?.[0]).toMatchObject({
      key: "check",
      status: "running",
    });
  });

  it("completeTask resolves succeeded, keeps the steps, records the result URL", async () => {
    const task = await createTask({ ...base, steps: steps("succeeded") }, store);
    await completeTask(task.id, { resultUrl: "/repos/proj_1?released=v3" }, store);

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("succeeded");
    expect(row?.steps?.[0]).toMatchObject({ key: "check", status: "succeeded" });
    expect(row?.resultUrl).toBe("/repos/proj_1?released=v3");
    expect(row?.error).toBeNull();
  });

  it("keeps a step's detail through completion (the panel's Live · vN reads it off the steps)", async () => {
    const task = await createTask(base, store);
    await updateTaskSteps(
      task.id,
      [{ key: "version", label: "Creating version", status: "succeeded", detail: "v13" }],
      store,
    );
    await completeTask(task.id, {}, store);
    expect((await store.workspaceTasks.findById(task.id))?.steps?.[0]).toMatchObject({
      key: "version",
      status: "succeeded",
      detail: "v13",
    });
  });

  it("failTask resolves failed with the error and keeps the steps", async () => {
    const task = await createTask({ ...base, steps: steps("failed") }, store);
    await failTask(task.id, "This change doesn't build yet", store);

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.steps?.[0]).toMatchObject({ key: "check", status: "failed" });
    expect(row?.error).toBe("This change doesn't build yet");
  });
});

describe("dismissTask", () => {
  it("refuses to dismiss a running task", async () => {
    const task = await createTask(base, store);
    expect(await dismissTask(task.id, store)).toBe(false);
    expect((await store.workspaceTasks.findById(task.id))?.dismissedAt).toBeNull();
  });

  it("dismisses a terminal task", async () => {
    const task = await createTask(base, store);
    await completeTask(task.id, { resultUrl: "/x" }, store);
    expect(await dismissTask(task.id, store)).toBe(true);
    expect((await store.workspaceTasks.findById(task.id))?.dismissedAt).not.toBeNull();
  });

  it("returns false for an unknown id", async () => {
    expect(await dismissTask("nope", store)).toBe(false);
  });
});

describe("findRunningTask", () => {
  it("matches only a running task with the same project and subjectKey", async () => {
    const task = await createTask(base, store);
    expect((await findRunningTask(PROJECT, "publish", store))?.id).toBe(task.id);

    // Different subject / project / terminal state → no match.
    expect(await findRunningTask(PROJECT, "other", store)).toBeNull();
    expect(await findRunningTask("other_proj", "publish", store)).toBeNull();

    await completeTask(task.id, { resultUrl: "/x" }, store);
    expect(await findRunningTask(PROJECT, "publish", store)).toBeNull();
  });
});

describe("listActive window contract", () => {
  it("always includes running rows, includes terminal rows only within the window, oldest-first", async () => {
    // Row timestamps come from the fake's seq counter — small integers we can reason about.
    const running = await createTask({ ...base, subjectKey: "a" }, store);

    const oldTerminal = await createTask({ ...base, subjectKey: "b" }, store);
    await completeTask(oldTerminal.id, { resultUrl: "/x" }, store);
    const oldUpdatedAt = (await store.workspaceTasks.findById(oldTerminal.id))!.updatedAt;

    const recentTerminal = await createTask({ ...base, subjectKey: "c" }, store);
    await failTask(recentTerminal.id, "boom", store);

    const dismissed = await createTask({ ...base, subjectKey: "d" }, store);
    await completeTask(dismissed.id, { resultUrl: "/x" }, store);
    await dismissTask(dismissed.id, store);

    // Cut just after the old terminal row so only it falls out of the window.
    const terminalSince = new Date(oldUpdatedAt.getTime() + 1);
    const active = await store.workspaceTasks.listActive(PROJECT, terminalSince);

    const ids = active.map((t) => t.subjectKey);
    expect(ids).toContain("a"); // running always shown
    expect(ids).toContain("c"); // recent terminal shown
    expect(ids).not.toContain("b"); // aged-out terminal excluded
    expect(ids).not.toContain("d"); // dismissed excluded

    // Oldest-first by createdAt.
    const sorted = [...active].sort(
      (x, y) => x.createdAt.getTime() - y.createdAt.getTime(),
    );
    expect(active).toEqual(sorted);
  });

  it("is scoped to the project", async () => {
    store.seedProject({ id: "other_proj", orgId: "org_1" });
    await createTask({ ...base, subjectKey: "mine" }, store);
    await createTask({ ...base, projectId: "other_proj", subjectKey: "theirs" }, store);

    const active = await store.workspaceTasks.listActive(PROJECT, new Date(0));
    expect(active.map((t) => t.subjectKey)).toEqual(["mine"]);
  });
});
