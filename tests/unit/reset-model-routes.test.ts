/** Exercise settings actions with the actual reset service, fake storage and no network. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeStore, type FakeStore } from "../fakes/store";
import { ensureModelProviderDependencies } from "~/eve/agentModule";
import {
  orgModelModuleSource,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";

const mocks = vi.hoisted(() => ({
  store: null as FakeStore | null,
  files: {} as Record<string, string>,
  workspaceModel: "openai/connection/gpt" as string | null,
  removeOverrides: vi.fn(),
  publish: vi.fn(),
  requireProject: vi.fn(),
}));
vi.mock("~/auth/session.server", () => ({
  getSessionAuth: async () => ({
    user: { id: "owner" },
    organizationId: "org",
  }),
  sessionLoader: vi.fn(),
}));
vi.mock("~/project/guard.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/project/guard.server")>()),
  requireProject: mocks.requireProject,
  requireRepo: (project: unknown) => project,
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: mocks.store }),
}));
vi.mock("~/github/repo.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/github/repo.server")>()),
  fetchAgentSource: async () => ({
    paths: Object.keys(mocks.files),
    files: mocks.files,
  }),
  readAgentFile: async (_id: unknown, _repo: unknown, path: string) =>
    mocks.files[path] ?? null,
}));
vi.mock("~/github/read-model-reset-file.server", () => ({
  readModelResetFile: async (_id: unknown, _repo: unknown, path: string) =>
    mocks.files[path] ?? null,
}));
vi.mock("~/github/cached.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/github/cached.server")>()),
  getAgentSource: async () => ({
    paths: Object.keys(mocks.files),
    files: mocks.files,
  }),
}));
vi.mock("~/org/workspace.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/org/workspace.server")>()),
  getWorkspaceAssistantSelection: async () => ({
    model: mocks.workspaceModel,
    effort: null,
  }),
}));
vi.mock("~/models/agent-model-config.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/models/agent-model-config.server")
  >()),
  removeAgentModelOverrides: mocks.removeOverrides,
}));
vi.mock("~/publish/pipeline.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/publish/pipeline.server")>()),
  startPublish: mocks.publish,
}));
vi.mock("~/jobs/worker.server", () => ({ ensureWorkerStarted: vi.fn() }));

const project = {
  id: "p",
  slug: "ledger-team",
  orgId: "org",
  layout: "team",
  repoInstallationId: "i",
  repoOwner: "owner",
  repoName: "repo",
  liveEnvironmentName: "default",
};
const root = "agents/ledger/agent";
const child = `${root}/subagents/qa`;
const nested = `${child}/subagents/reviewer`;
const legacy =
  'import { defineAgent } from "eve"; export default defineAgent({ model: "anthropic/connection/claude", description: "Keep this behaviour" });';

beforeEach(() => {
  const store = makeFakeStore();
  store.seedProject(project);
  store.seedAgent({ id: "ledger", projectId: "p", name: "ledger", root });
  store.seedAgent({
    id: "reporter",
    projectId: "p",
    name: "reporter",
    root: "agents/reporter/agent",
  });
  mocks.store = store;
  mocks.workspaceModel = "openai/connection/gpt";
  mocks.files = {
    [`${root}/agent.ts`]: legacy,
    [`${child}/agent.ts`]: legacy,
    [`${nested}/instructions.md`]: "Review the result.",
    "agents/reporter/agent/agent.ts": legacy,
    "agents/ledger/package.json": ensureModelProviderDependencies(null),
    "agents/reporter/package.json": ensureModelProviderDependencies(null),
    "agents/ledger/harnesst/model.ts": orgModelModuleSource(),
    "agents/reporter/harnesst/model.ts": orgModelModuleSource(),
  };
  mocks.requireProject.mockReset().mockResolvedValue(project);
  mocks.removeOverrides.mockReset().mockResolvedValue(undefined);
  mocks.publish
    .mockReset()
    .mockResolvedValue({ taskId: "publish-task", alreadyRunning: false });
});

async function post(
  params: { agentName?: string; subPath?: string },
  fields: Record<string, string>,
) {
  const { action } = await import("~/routes/projects.$projectId.settings");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const url = "https://h.example.com/repos/ledger-team/settings";
  return action({
    request: new Request(url, { method: "POST", body }),
    url: new URL(url),
    pattern: new URL(url).pathname,
    params: { projectId: "p", ...params },
    context: {} as never,
  });
}

function clearedTargets() {
  return mocks.removeOverrides.mock.calls[0]?.[1];
}

describe("reset model settings actions", () => {
  it("resets only the URL member despite a hostile form asking for its sibling", async () => {
    expect(
      await post(
        { agentName: "ledger" },
        {
          intent: "reset-model-default",
          member: "reporter",
          agentName: "reporter",
        },
      ),
    ).toMatchObject({ ok: true, mode: "publishing" });
    expect(clearedTargets()).toEqual([
      { projectId: "p", agentName: "ledger", subagentPath: "" },
    ]);
    const drafts = await mocks.store!.drafts.listByProject("p");
    expect(drafts.map((draft) => draft.path)).toEqual([`${root}/agent.ts`]);
  });

  it("team reset includes every member and every declared depth, even instruction-only subagents", async () => {
    expect(
      await post({}, { intent: "reset-all-model-defaults" }),
    ).toMatchObject({ ok: true, mode: "publishing" });
    expect(clearedTargets()).toEqual([
      { projectId: "p", agentName: "ledger", subagentPath: "" },
      { projectId: "p", agentName: "ledger", subagentPath: "qa" },
      { projectId: "p", agentName: "ledger", subagentPath: "qa/reviewer" },
      { projectId: "p", agentName: "reporter", subagentPath: "" },
    ]);
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("rejects team reset from a member URL", async () => {
    expect(
      await post(
        { agentName: "ledger" },
        { intent: "reset-all-model-defaults" },
      ),
    ).toMatchObject({ error: expect.stringContaining("team settings") });
    expect(mocks.removeOverrides).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rejects team reset from a declared subagent URL", async () => {
    await expect(
      post(
        { agentName: "ledger", subPath: "qa" },
        { intent: "reset-all-model-defaults" },
      ),
    ).rejects.toMatchObject({ init: { status: 404 } });
    expect(mocks.removeOverrides).not.toHaveBeenCalled();
  });

  it("requires the workspace default and leaves every file and override untouched", async () => {
    mocks.workspaceModel = null;
    expect(
      await post({}, { intent: "reset-all-model-defaults" }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("Org settings"),
    });
    expect(await mocks.store!.drafts.listByProject("p")).toEqual([]);
    expect(mocks.removeOverrides).not.toHaveBeenCalled();
  });

  it("unsupported custom logic on a later member prevents changes to earlier members", async () => {
    mocks.files["agents/reporter/agent/agent.ts"] =
      'import { defineAgent } from "eve"; export default defineAgent({ model: customModel() });';
    expect(
      await post({}, { intent: "reset-all-model-defaults" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("custom") });
    expect(await mocks.store!.drafts.listByProject("p")).toEqual([]);
    expect(mocks.removeOverrides).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("a nested reset addresses exactly the URL subagent", async () => {
    mocks.files[`${root}/agent.ts`] = scaffoldOrgModelAgentModule("ledger");
    expect(
      await post(
        { agentName: "ledger", subPath: "qa" },
        { intent: "reset-model-default", member: "reporter" },
      ),
    ).toMatchObject({ ok: true, mode: "publishing" });
    expect(clearedTargets()).toEqual([
      { projectId: "p", agentName: "ledger", subagentPath: "qa" },
    ]);
  });
  it("does not silently inherit workspace default beneath a legacy parent", async () => {
    expect(
      await post(
        { agentName: "ledger", subPath: "qa" },
        { intent: "reset-model-default" },
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("Reset ledger first"),
    });
    expect(await mocks.store!.drafts.listByProject("p")).toEqual([]);
    expect(mocks.removeOverrides).not.toHaveBeenCalled();
  });
});
