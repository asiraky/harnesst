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

/** The install this incident came from: a catalog skill whose SKILL.md failed eve's discovery. */
const LEGAL_ADVISOR = {
  id: "legal-advisor",
  type: "skill" as const,
  name: "Legal Advisor",
  version: "0.1.0",
  hash: "abc123",
  registry: "fixture",
  member: "ivy",
  files: [
    "agents/ivy/agent/skills/legal-advisor/SKILL.md",
    "agents/ivy/agent/skills/legal-advisor/references/templates.md",
  ],
};

const lockWith = (...installs: object[]) =>
  JSON.stringify({ version: 1, installs: installs.flat() });

function harness(opts?: {
  repoFiles?: Record<string, string>;
  /** Catalog index rows, or a throw to stand in for a catalog outage. */
  catalogIndex?: () => Promise<{ templates: unknown[] }>;
}) {
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
      // Eagerly-read files on the real source include harnesst-lock.json — project-context reads
      // the lock from here, exactly as the Settings loader does.
      files: repoFiles,
      ref: "main",
      truncated: false,
    }),
    listDrafts: (pid) => listDrafts(pid, store),
    readPublished: async (_p, path) => repoFiles[path] ?? null,
    secretKeys: async () => [],
    catalog: {
      name: "fake",
      index: (opts?.catalogIndex ??
        (async () => ({ templates: [{ id: "x" }] }))) as never,
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
      expect(ctx.marketplaceInstalls).toEqual([]);
    }
  });

  // The assistant used to have no way to tell a template-owned file from a hand-authored one, so
  // a broken catalog template read as a repo problem and got "fixed" by hand.
  it("names the marketplace install that owns each file, and flags a newer catalog version", async () => {
    const { deps } = harness({
      repoFiles: { "harnesst-lock.json": lockWith(LEGAL_ADVISOR) },
      catalogIndex: async () => ({
        templates: [{ id: "legal-advisor", type: "skill", version: "0.1.1" }],
      }),
    });
    const ctx = await projectContext(project, deps);
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    expect(ctx.marketplaceInstalls).toEqual([
      {
        id: "legal-advisor",
        type: "skill",
        name: "Legal Advisor",
        version: "0.1.0",
        member: "ivy",
        files: [
          "agents/ivy/agent/skills/legal-advisor/SKILL.md",
          "agents/ivy/agent/skills/legal-advisor/references/templates.md",
        ],
        catalogVersion: "0.1.1",
        updateAvailable: true,
      },
    ]);
  });

  it("keeps ownership when the catalog is unreachable — only the version signal is lost", async () => {
    const { deps } = harness({
      repoFiles: { "harnesst-lock.json": lockWith(LEGAL_ADVISOR) },
      catalogIndex: async () => {
        throw new Error("catalog down");
      },
    });
    const ctx = await projectContext(project, deps);
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    expect(ctx.marketplaceInstalls).toMatchObject([
      {
        id: "legal-advisor",
        files: LEGAL_ADVISOR.files,
        catalogVersion: null,
        updateAvailable: false,
      },
    ]);
  });

  it("reads a staged install's lock draft over the branch's file", async () => {
    const { store, deps } = harness({
      repoFiles: { "harnesst-lock.json": lockWith([]) },
    });
    await store.drafts.upsert({
      projectId: "p",
      agentId: "m1",
      path: "harnesst-lock.json",
      content: lockWith(LEGAL_ADVISOR),
    });
    const ctx = await projectContext(project, deps);
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    expect(ctx.marketplaceInstalls.map((i) => i.id)).toEqual(["legal-advisor"]);
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
