/**
 * Publish-a-change runner (issue #142) — pins runPublishChange, the body that moved off the
 * synchronous deployments route onto the durable job queue. publishDrafts (directly imported) is
 * mocked; progress and outcome are read back off the fake store's workspace task. Contract:
 *   - success completes the task with resultUrl = the task's originUrl and hands publishDrafts the
 *     project fields, paths, title and createdBy;
 *   - ANY publishDrafts throw (gate failure or GitHub error) fails the task and resolves WITHOUT
 *     rethrowing, since a gate failure is the user's outcome, not a queue error;
 *   - a missing task or unconnected project is a real infrastructure error (rethrow).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishDrafts } from "~/drafts/drafts.server";
import { runPublishChange } from "~/drafts/publish-change.server";
import { createTask } from "~/tasks/tasks.server";
import type { WorkspaceTask } from "~/data/ports";
import { makeFakeStore, type FakeStore } from "../fakes/store";

vi.mock("~/drafts/drafts.server", () => ({ publishDrafts: vi.fn() }));
const publishDraftsMock = vi.mocked(publishDrafts);

let store: FakeStore;
const PROJECT = "proj_1";

async function seedTask(): Promise<WorkspaceTask> {
  return createTask(
    {
      projectId: PROJECT,
      kind: "publish_change",
      subjectKey: "publish",
      label: 'Publishing "Update agent files"',
      originUrl: "/repos/proj_1/agents/x/deployment",
    },
    store,
  );
}

beforeEach(() => {
  publishDraftsMock.mockReset();
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

describe("runPublishChange", () => {
  it("completes the task at the origin URL and passes publishDrafts the project + inputs", async () => {
    publishDraftsMock.mockResolvedValue({} as never);
    const task = await seedTask();

    await runPublishChange(
      {
        projectId: PROJECT,
        taskId: task.id,
        paths: ["agent/a.md"],
        title: "Update agent files",
        createdBy: "user_1",
      },
      store,
    );

    expect(publishDraftsMock).toHaveBeenCalledOnce();
    const input = publishDraftsMock.mock.calls[0][0];
    expect(input.project).toMatchObject({
      id: PROJECT,
      repoInstallationId: "inst_1",
      repoOwner: "acme",
      repoName: "agent",
      defaultBranch: "main",
    });
    expect(input.paths).toEqual(["agent/a.md"]);
    expect(input.title).toBe("Update agent files");
    expect(input.createdBy).toBe("user_1");

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("succeeded");
    expect(row?.resultUrl).toBe("/repos/proj_1/agents/x/deployment");
  });

  it("fails the task and does not rethrow when publishDrafts rejects", async () => {
    publishDraftsMock.mockRejectedValue(new Error("Build check failed — fix and publish again"));
    const task = await seedTask();

    await expect(
      runPublishChange(
        { projectId: PROJECT, taskId: task.id, paths: ["agent/a.md"] },
        store,
      ),
    ).resolves.toBeUndefined();

    const row = await store.workspaceTasks.findById(task.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("Build check failed");
  });

  it("rethrows when the task is missing", async () => {
    await expect(
      runPublishChange(
        { projectId: PROJECT, taskId: "gone", paths: ["agent/a.md"] },
        store,
      ),
    ).rejects.toThrow(/task gone not found/);
  });

  it("rethrows when the project is not connected", async () => {
    store.seedProject({ id: "bare", orgId: "org_1" });
    const task = await createTask(
      {
        projectId: "bare",
        kind: "publish_change",
        subjectKey: "publish",
        label: "x",
        originUrl: "/repos/bare",
      },
      store,
    );
    await expect(
      runPublishChange(
        { projectId: "bare", taskId: task.id, paths: ["agent/a.md"] },
        store,
      ),
    ).rejects.toThrow(/no connected repo/);
  });
});
