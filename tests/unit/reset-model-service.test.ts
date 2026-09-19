import { describe, expect, it, vi } from "vitest";
import { ensureModelProviderDependencies } from "~/eve/agentModule";
import {
  orgModelModuleSource,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";
import {
  resetModelsToWorkspaceDefault,
  type ModelResetTarget,
  type ResetModelsDeps,
} from "~/models/reset-model.server";
import { resetAgentModelSource } from "~/eve/reset-model";
import { makeFakeStore } from "../fakes/store";

const project = {
  id: "p",
  orgId: "org",
  repoInstallationId: "i",
  repoOwner: "owner",
  repoName: "repo",
  liveEnvironmentName: "default",
};
const target: ModelResetTarget = {
  root: "agents/ledger/agent",
  deploymentRoot: "agents/ledger/agent",
  memberName: "ledger",
};
const legacy =
  'import { defineAgent } from "eve";\nexport default defineAgent({ model: "anthropic/connection/claude", description: "Keeps the ledger" });\n';
function setup(resolver = false) {
  const store = makeFakeStore();
  store.seedProject(project);
  store.seedAgent({
    id: "a",
    projectId: "p",
    name: "ledger",
    root: target.root,
  });
  const files: Record<string, string> = {
    [`${target.root}/agent.ts`]: resolver
      ? resetAgentModelSource(scaffoldOrgModelAgentModule("ledger"), "ledger")
      : legacy,
    "agents/ledger/package.json": ensureModelProviderDependencies(null),
    "agents/ledger/harnesst/model.ts": orgModelModuleSource(),
  };
  const deps: ResetModelsDeps = {
    readFile: vi.fn(async (_id, _repo, path) => files[path] ?? null),
    getWorkspaceSelection: vi.fn(async () => ({
      model: "openai/connected/gpt",
      effort: null,
    })),
    removeOverrides: vi.fn(async () => {}),
    publish: vi.fn(async () => ({
      taskId: "publish-task",
      alreadyRunning: false,
    })),
    startWorker: vi.fn(),
  };
  const run = (targets = [target]) =>
    resetModelsToWorkspaceDefault(
      { project, targets, createdBy: "user", originUrl: "/repos/p/settings" },
      store,
      deps,
    );
  return { store, files, deps, run };
}

describe("explicit model reset", () => {
  it("requires a workspace default before any writes", async () => {
    const { run, deps, store } = setup();
    deps.getWorkspaceSelection = async () => ({ model: null, effort: null });
    expect(await run()).toMatchObject({
      ok: false,
      error: expect.stringContaining("Org settings"),
    });
    expect(await store.drafts.listByProject("p")).toEqual([]);
    expect(deps.removeOverrides).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("clears only the requested member and awaits a publish for legacy source", async () => {
    const { run, deps, store } = setup();
    expect(await run()).toEqual({
      ok: true,
      mode: "publishing",
      taskId: "publish-task",
      cacheSeconds: 30,
    });
    expect(deps.removeOverrides).toHaveBeenCalledWith("org", [
      { projectId: "p", agentName: "ledger", subagentPath: "" },
    ]);
    expect(await store.drafts.listByProject("p")).toHaveLength(1);
    expect(deps.publish).toHaveBeenCalledOnce();
  });

  it("clears a resolver pin without publishing and remains idempotent", async () => {
    const { run, deps, store } = setup(true);
    expect(await run()).toEqual({
      ok: true,
      mode: "applied",
      cacheSeconds: 30,
    });
    expect(await run()).toEqual({
      ok: true,
      mode: "applied",
      cacheSeconds: 30,
    });
    expect(await store.drafts.listByProject("p")).toEqual([]);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("includes declared and nested targets only when explicitly in the team scope", async () => {
    const { run, deps } = setup();
    const child = {
      ...target,
      root: `${target.root}/subagents/qa`,
      subagentPath: "qa",
    };
    const nested = {
      ...target,
      root: `${child.root}/subagents/review`,
      subagentPath: "qa/review",
    };
    expect((await run([target, child, nested])).ok).toBe(true);
    expect(deps.removeOverrides).toHaveBeenCalledWith("org", [
      { projectId: "p", agentName: "ledger", subagentPath: "" },
      { projectId: "p", agentName: "ledger", subagentPath: "qa" },
      { projectId: "p", agentName: "ledger", subagentPath: "qa/review" },
    ]);
  });

  it("validates every team member before staging or clearing any pin", async () => {
    const { run, files, deps, store } = setup();
    const custom = {
      root: "agents/custom/agent",
      deploymentRoot: "agents/custom/agent",
      memberName: "custom",
    };
    files[`${custom.root}/agent.ts`] =
      'import { defineAgent } from "eve"; export default defineAgent({ model: selectCustomModel() });';
    expect(await run([target, custom])).toMatchObject({
      ok: false,
      error: expect.stringContaining("custom"),
    });
    expect(await store.drafts.listByProject("p")).toEqual([]);
    expect(deps.removeOverrides).not.toHaveBeenCalled();
  });

  it("does not automatically publish unrelated saved work", async () => {
    const { run, deps, store } = setup();
    await store.drafts.upsert({
      projectId: "p",
      agentId: "a",
      path: `${target.root}/instructions.md`,
      content: "Unreviewed change",
    });
    expect(await run()).toMatchObject({
      ok: false,
      error: expect.stringContaining("existing saved changes"),
    });
    expect(await store.drafts.listByProject("p")).toHaveLength(1);
    expect(deps.removeOverrides).not.toHaveBeenCalled();
  });

  it("retains reset drafts on publish failure and retries without falsely reporting applied", async () => {
    const { run, deps, store } = setup();
    vi.mocked(deps.publish).mockRejectedValueOnce(
      new Error("Queue unavailable"),
    );
    expect(await run()).toMatchObject({
      ok: false,
      error: expect.stringContaining("Queue unavailable"),
    });
    expect(await store.drafts.listByProject("p")).toHaveLength(1);
    expect(await run()).toMatchObject({ ok: true, mode: "publishing" });
    expect(await store.drafts.listByProject("p")).toHaveLength(1);
  });

  it("rebuilds when a committed conversion has not reached the serving release", async () => {
    const { run, deps, store } = setup(true);
    store.seedEnvironment({
      id: "env",
      projectId: "p",
      agentId: "a",
      name: "default",
    });
    const release = await store.releases.insert({
      projectId: "p",
      agentId: "a",
      version: "v1",
      gitSha: "old",
    });
    await store.deployments.insert({
      environmentId: "env",
      releaseId: release.id,
      status: "live",
      trafficWeight: 100,
    });
    const read = deps.readFile;
    deps.readFile = async (id, repo, path) =>
      repo.ref === "old" && path === `${target.root}/agent.ts`
        ? legacy
        : read(id, repo, path);
    expect(await run()).toMatchObject({ ok: true, mode: "publishing" });
    expect(deps.publish).toHaveBeenCalledOnce();
  });
  it("requires legacy ancestors outside the reset scope to be reset first", async () => {
    const { run, deps, store } = setup();
    const child = {
      ...target,
      root: `${target.root}/subagents/qa`,
      subagentPath: "qa",
    };
    expect(await run([child])).toMatchObject({
      ok: false,
      error: expect.stringContaining("Reset ledger first"),
    });
    expect(await store.drafts.listByProject("p")).toEqual([]);
    expect(deps.removeOverrides).not.toHaveBeenCalled();
  });

  it("checks intermediate ancestors as well as the member", async () => {
    const { run, files, deps } = setup(true);
    const child = {
      ...target,
      root: `${target.root}/subagents/qa`,
      subagentPath: "qa",
    };
    files[`${child.root}/agent.ts`] = legacy;
    const nested = {
      ...target,
      root: `${child.root}/subagents/review`,
      subagentPath: "qa/review",
    };
    expect(await run([nested])).toMatchObject({
      ok: false,
      error: expect.stringContaining("Reset ledger / qa first"),
    });
    expect(deps.removeOverrides).not.toHaveBeenCalled();
    expect(await run([child, nested])).toMatchObject({
      ok: true,
      mode: "publishing",
    });
  });

  it("atomically rejects a racing saved edit instead of overwriting it", async () => {
    const { run, deps, store } = setup();
    const compare = store.drafts.compareAndStage;
    store.drafts.compareAndStage = async (projectId, expected, writes) => {
      await store.drafts.upsert({
        projectId,
        agentId: "a",
        path: `${target.root}/agent.ts`,
        content: "A new user edit",
      });
      return compare(projectId, expected, writes);
    };
    expect(await run()).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed while preparing"),
    });
    expect(
      (await store.drafts.get("p", `${target.root}/agent.ts`))?.content,
    ).toBe("A new user edit");
    expect(deps.removeOverrides).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });
});
