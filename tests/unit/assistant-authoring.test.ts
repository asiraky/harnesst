import { describe, expect, it } from "vitest";

import {
  assembleBundle,
  catalogOp,
  projectContext,
  resolveAssistantContext,
  type AuthoringDeps,
  type AuthoringProject,
} from "~/assistant/authoring.server";
import { listDrafts } from "~/drafts/drafts.server";
import { makeFakeStore } from "../fakes/store";

const project: AuthoringProject = {
  id: "p",
  orgId: "o",
  name: "repo",
  slug: "repo",
  layout: "single",
  teamId: null,
  repoOwner: "acme",
  repoName: "repo",
  repoInstallationId: "inst",
  defaultBranch: "main",
  liveEnvironmentName: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function harness(opts?: { repoFiles?: Record<string, string> }) {
  const store = makeFakeStore();
  store.seedProject({
    id: "p",
    orgId: "o",
    repoOwner: "acme",
    repoName: "repo",
  });
  store.seedAgent({ id: "m1", projectId: "p", name: "agent", root: "agent" });
  const repoFiles = opts?.repoFiles ?? {};

  const deps: AuthoringDeps = {
    store,
    getSource: async () => ({
      paths: Object.keys(repoFiles),
      files: {},
      ref: "main",
      truncated: false,
    }),
    listDrafts: (pid) => listDrafts(pid, store),
    readPublished: async (_p, path) => repoFiles[path] ?? null,
    secretKeys: async () => [],
    catalog: {
      name: "fake",
      index: async () => ({ templates: [{ id: "x" }] }) as never,
      template: async () =>
        ({ manifest: { id: "x" }, files: { "a.ts": "1" } }) as never,
    },
  };
  return { store, deps, repoFiles };
}

describe("assistant authoring: bundle", () => {
  it("assembles published config into the entrypoint bundle shape", async () => {
    const { deps } = harness({
      repoFiles: {
        ".harnesst/assistant/instructions.md": "Be helpful.",
        ".harnesst/assistant/skills/deploys.md": "# deploys",
        ".harnesst/assistant/schedules/daily.md": "# daily",
        ".harnesst/assistant/assistant.json": JSON.stringify({
          model: "anthropic/claude-sonnet-5",
          effort: "high",
        }),
      },
    });
    const bundle = await assembleBundle(project, deps);
    expect(bundle.instructions).toBe("Be helpful.");
    expect(bundle.model).toBe("anthropic/claude-sonnet-5");
    expect(bundle.effort).toBe("high");
    expect(bundle.files).toEqual({
      "skills/user/deploys.md": "# deploys",
      "schedules/user/daily.md": "# daily",
    });
  });

  it("ignores an unrecognized effort in manually edited published config", async () => {
    const { deps } = harness({
      repoFiles: {
        ".harnesst/assistant/assistant.json": JSON.stringify({
          model: "anthropic/claude-sonnet-5",
          effort: "maximum-plus",
        }),
      },
    });
    await expect(assembleBundle(project, deps)).resolves.toMatchObject({
      model: "anthropic/claude-sonnet-5",
      effort: null,
    });
  });
});

describe("assistant authoring: project-context", () => {
  it("lists members, config, and staged human drafts", async () => {
    const { store, deps } = harness({
      repoFiles: { ".harnesst/assistant/instructions.md": "hi" },
    });
    await store.drafts.upsert({
      projectId: "p",
      agentId: "m1",
      path: "agent/tools/foo.ts",
      content: "x",
    });
    const ctx = await projectContext(project, deps);
    expect(ctx).toMatchObject({ ok: true, isTeam: false });
    if (ctx.ok) {
      expect(ctx.members.map((m) => m.name)).toEqual(["agent"]);
      expect(ctx.assistantConfig.instructions).toBe(true);
      expect(ctx.stagedDrafts).toEqual([
        { path: "agent/tools/foo.ts", deletion: false },
      ]);
    }
  });
});

describe("assistant authoring: catalog", () => {
  it("returns the index and a template", async () => {
    const { deps } = harness();
    expect(await catalogOp({ op: "index" }, deps)).toMatchObject({ ok: true });
    expect(
      await catalogOp({ op: "template", type: "tool", id: "x" }, deps),
    ).toMatchObject({ ok: true });
    expect(await catalogOp({ op: "template" }, deps)).toMatchObject({
      ok: false,
    });
    expect(
      await catalogOp({ op: "template", type: "connection", id: "../x" }, deps),
    ).toMatchObject({ ok: false });
    expect(await catalogOp({ op: "bogus" }, deps)).toMatchObject({ ok: false });
  });
});

describe("assistant authoring: caller resolution", () => {
  it("rejects a deployment whose agent is not the assistant", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    store.seedAgent({ id: "m1", projectId: "p", name: "agent", root: "agent" }); // kind member
    const env = store.seedEnvironment({
      id: "e1",
      projectId: "p",
      agentId: "m1",
      name: "default",
    });
    const dep = await store.deployments.insert({
      environmentId: env.id,
      releaseId: "rel",
      status: "live",
      trafficWeight: 100,
    });
    expect(await resolveAssistantContext(dep.id, store)).toBeNull();
  });

  it("resolves an assistant deployment to its project", async () => {
    const store = makeFakeStore();
    store.seedProject({
      id: "p",
      orgId: "o",
      repoOwner: "a",
      repoName: "r",
      repoInstallationId: "i",
    });
    const assistant = await store.agents.createAssistant({
      projectId: "p",
      name: "assistant",
      root: ".harnesst/assistant",
    });
    const env = store.seedEnvironment({
      id: "e1",
      projectId: "p",
      agentId: assistant.id,
      name: "assistant",
    });
    const dep = await store.deployments.insert({
      environmentId: env.id,
      releaseId: "rel",
      status: "live",
      trafficWeight: 100,
    });
    const ctx = await resolveAssistantContext(dep.id, store);
    expect(ctx).toMatchObject({ agentId: assistant.id, deploymentId: dep.id });
    expect(ctx?.project.id).toBe("p");
  });
});
