import { describe, expect, it } from "vitest";

import {
  installMarketplaceTemplate,
  type AssistantInstallDeps,
} from "~/assistant/install.server";
import type { AuthoringProject } from "~/assistant/authoring.server";
import { listDrafts, stageDeletions, stageDraft } from "~/drafts/drafts.server";
import { parseLock } from "~/marketplace/lock";
import type { InstallSecretOp } from "~/project/secrets.server";
import type { CatalogSource, CatalogTemplate } from "~/seams/types";
import { makeFakeStore } from "../fakes/store";

const connection: CatalogTemplate = {
  assistantSkill: null,
  manifest: {
    id: "example-api",
    type: "connection",
    name: "Example API",
    description: "Connects to Example.",
    version: "1.0.0",
    eve: ">=0.22.0",
    subagentCompatible: true,
    files: ["tools/example-api.ts"],
    dependencies: { "example-sdk": "^2.0.0" },
    secrets: [{ name: "EXAMPLE_TOKEN", sandbox: true }],
    auth: {
      provider: "example",
      kind: "oauth2",
      scopes: ["records.read"],
      scopeGroups: [
        {
          id: "read",
          label: "Read",
          description: "Read Example records.",
          scopes: ["records.read"],
          default: true,
        },
        {
          id: "write",
          label: "Write",
          description: "Write Example records.",
          scopes: ["records.write"],
        },
      ],
    },
    sandbox: {
      bootstrap: ["example-cli setup"],
      revalidationKey: "example-cli-v1",
    },
  },
  files: { "tools/example-api.ts": "export default {};\n" },
};

const bundle: CatalogTemplate = {
  assistantSkill: null,
  manifest: {
    id: "example-bundle",
    type: "bundle",
    name: "Example Bundle",
    description: "The full Example integration.",
    version: "1.0.0",
    eve: ">=0.22.0",
    subagentCompatible: true,
    files: [],
    includes: [{ type: "connection", id: "example-api" }],
  },
  files: {},
};

const agent: CatalogTemplate = {
  assistantSkill: null,
  manifest: {
    id: "example-agent",
    type: "agent",
    name: "Example Agent",
    description: "A ready-made teammate.",
    version: "1.0.0",
    eve: ">=0.22.0",
    subagentCompatible: false,
    files: ["agent.ts"],
  },
  files: {
    "agent.ts": 'export default defineAgent({ model: "anthropic/x" });\n',
  },
};

function harness(options?: {
  occupied?: boolean;
  team?: boolean;
  model?: string | null;
}) {
  const store = makeFakeStore();
  const project = store.seedProject({
    id: "project",
    orgId: "org",
    layout: options?.team ? "team" : "single",
    repoOwner: "acme",
    repoName: "agents",
    repoInstallationId: "installation",
  }) as AuthoringProject;
  if (options?.team) {
    store.seedAgent({
      id: "member",
      projectId: project.id,
      name: "pm",
      root: "agents/pm/agent",
    });
  } else {
    store.seedAgent({
      id: "member",
      projectId: project.id,
      name: "agent",
      root: "agent",
    });
  }
  const templates = new Map([
    ["bundle/example-bundle", bundle],
    ["connection/example-api", connection],
    ["agent/example-agent", agent],
  ]);
  const catalog: CatalogSource = {
    name: "test",
    index: async () => ({ templates: [] }),
    template: async (type, id) => {
      const template = templates.get(`${type}/${id}`);
      if (!template) throw new Error("Template not found");
      return template;
    },
  };
  let appliedOps: InstallSecretOp[] = [];
  const deps: AssistantInstallDeps = {
    store,
    catalog,
    fetchSource: async () => ({
      paths: options?.team
        ? [
            "agents/pm/agent/agent.ts",
            "agents/pm/package.json",
            // A declared subagent of `pm`, so a subagent-targeted install has somewhere to land.
            "agents/pm/agent/subagents/reader/agent.ts",
          ]
        : [
            "agent/agent.ts",
            "package.json",
            ...(options?.occupied ? ["agent/tools/example-api.ts"] : []),
          ],
      files: {},
      ref: "main",
      truncated: false,
    }),
    readFile: async (_installation, _repo, path) =>
      path === "package.json"
        ? JSON.stringify({
            name: "agent",
            private: true,
            dependencies: { eve: "latest" },
          }) + "\n"
        : null,
    listDrafts,
    stageWrite: stageDraft,
    stageDeletes: stageDeletions,
    sharedSecretNames: async () => ["EXAMPLE_TOKEN"],
    workspaceModel: async () => ({
      model: options?.model ?? null,
      effort: null,
    }),
    credentialConflict: async () => null,
    applySecretOps: async ({ ops }) => {
      appliedOps = ops;
    },
  };
  return { project, store, deps, appliedOps: () => appliedOps };
}

describe("assistant marketplace install", () => {
  it("composes a bundle and stages lock, dependencies, sandbox setup, and shared secrets", async () => {
    const { project, store, deps, appliedOps } = harness();
    const result = await installMarketplaceTemplate(
      project,
      { type: "bundle", id: "example-bundle", member: "agent" },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      type: "bundle",
      id: "example-bundle",
      member: "agent",
      conflicts: [],
      secrets: {
        required: ["EXAMPLE_TOKEN"],
        attached: ["EXAMPLE_TOKEN"],
      },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.writes).toEqual(
      expect.arrayContaining([
        "agent/tools/example-api.ts",
        "agent/sandbox/addons/example-bundle.ts",
        "agent/sandbox/sandbox.ts",
        "package.json",
        "harnesst-lock.json",
      ]),
    );
    expect(appliedOps()).toEqual([
      { kind: "attach", name: "EXAMPLE_TOKEN", sandbox: true },
    ]);

    const drafts = await listDrafts(project.id, store);
    const lockDraft = drafts.find(
      (draft) => draft.path === "harnesst-lock.json",
    );
    const lock = parseLock(JSON.parse(lockDraft?.content ?? "null"));
    expect(lock.installs[0]).toMatchObject({
      id: "example-bundle",
      type: "bundle",
      member: null,
      includes: [{ id: "example-api", type: "connection" }],
      auth: [{ provider: "example", scopes: ["records.read"] }],
      sandbox: {
        bootstrap: ["example-cli setup"],
        revalidationKey: "example-cli-v1",
      },
    });
    const packageDraft = drafts.find((draft) => draft.path === "package.json");
    expect(JSON.parse(packageDraft?.content ?? "null").dependencies).toEqual({
      eve: "latest",
      "example-sdk": "^2.0.0",
    });
  });

  it("returns the full change set and stages nothing when a path conflicts", async () => {
    const { project, store, deps } = harness({ occupied: true });
    const result = await installMarketplaceTemplate(
      project,
      { type: "connection", id: "example-api", member: "agent" },
      deps,
    );

    expect(result).toMatchObject({
      ok: false,
      conflicts: ["agent/tools/example-api.ts"],
      writes: expect.arrayContaining(["harnesst-lock.json", "package.json"]),
    });
    expect(await listDrafts(project.id, store)).toEqual([]);
  });

  it("keeps an installed OAuth scope selection when an update omits selections", async () => {
    const { project, store, deps } = harness();
    const first = await installMarketplaceTemplate(
      project,
      {
        type: "connection",
        id: "example-api",
        member: "agent",
        authSelections: { example: ["write"] },
      },
      deps,
    );
    expect(first.ok).toBe(true);

    const update = await installMarketplaceTemplate(
      project,
      { type: "connection", id: "example-api", member: "agent" },
      deps,
    );
    expect(update).toMatchObject({ ok: true, isUpdate: true });

    const drafts = await listDrafts(project.id, store);
    const lockDraft = drafts.find(
      (draft) => draft.path === "harnesst-lock.json",
    );
    const lock = parseLock(JSON.parse(lockDraft?.content ?? "null"));
    expect(lock.installs[0].auth?.[0].selectedGroups).toEqual(["write"]);
  });

  it("plans a set op carrying the manifest sandbox flag when a value is supplied", async () => {
    const { project, store, deps, appliedOps } = harness();
    const result = await installMarketplaceTemplate(
      project,
      {
        type: "connection",
        id: "example-api",
        member: "agent",
        secretValues: { EXAMPLE_TOKEN: "s3cr3t" },
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      secrets: { required: ["EXAMPLE_TOKEN"], set: ["EXAMPLE_TOKEN"] },
    });
    expect(appliedOps()).toEqual([
      { kind: "set", name: "EXAMPLE_TOKEN", value: "s3cr3t", sandbox: true },
    ]);
    const drafts = await listDrafts(project.id, store);
    expect(drafts.some((draft) => draft.path === "harnesst-lock.json")).toBe(
      true,
    );
  });

  it("stages nothing when the GitHub-App credential guard rejects the install", async () => {
    const { project, store, deps } = harness();
    const result = await installMarketplaceTemplate(
      project,
      { type: "connection", id: "example-api", member: "agent" },
      {
        ...deps,
        credentialConflict: async () => "Another agent uses this App.",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Another agent uses this App.",
    });
    expect(await listDrafts(project.id, store)).toEqual([]);
  });

  it("refuses an agent template in a single-agent repo", async () => {
    const { project, deps } = harness();
    await expect(
      installMarketplaceTemplate(
        project,
        { type: "agent", id: "example-agent", member: "deployer" },
        deps,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("single-agent repo"),
    });
  });

  it("refuses an agent template when no workspace default model is set", async () => {
    const { project, deps } = harness({ team: true, model: null });
    await expect(
      installMarketplaceTemplate(
        project,
        { type: "agent", id: "example-agent", member: "deployer" },
        deps,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("workspace default model"),
    });
  });

  it("blocks an agent template whose new-member name collides with the roster", async () => {
    const { project, store, deps } = harness({
      team: true,
      model: "anthropic/x",
    });
    const result = await installMarketplaceTemplate(
      project,
      { type: "agent", id: "example-agent", member: "pm" },
      deps,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("block this install"),
      conflicts: expect.arrayContaining([
        expect.stringContaining('agent named "pm"'),
      ]),
    });
    expect(await listDrafts(project.id, store)).toEqual([]);
  });

  it("rejects types outside the complete marketplace type set", async () => {
    const { project, deps } = harness();
    await expect(
      installMarketplaceTemplate(
        project,
        { type: "prompt", id: "example-bundle", member: "agent" },
        deps,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("type"),
    });
  });

  it("installs into a declared subagent, with dependencies at the member", async () => {
    const { project, store, deps } = harness({ team: true });
    const result = await installMarketplaceTemplate(
      project,
      {
        type: "connection",
        id: "example-api",
        member: "pm",
        subagent: "reader",
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // A declared subagent is its own agent root — the tool belongs inside it, the npm dependency
    // belongs to the deployment that runs it.
    expect(result.writes).toContain(
      "agents/pm/agent/subagents/reader/tools/example-api.ts",
    );
    expect(result.writes).toContain("agents/pm/package.json");
    const drafts = await listDrafts(project.id, store);
    const lock = parseLock(
      JSON.parse(
        drafts.find((draft) => draft.path === "harnesst-lock.json")?.content ??
          "null",
      ),
    );
    expect(lock.installs).toMatchObject([
      {
        id: "example-api",
        member: "pm",
        subagent: "reader",
        files: expect.arrayContaining([
          "agents/pm/agent/subagents/reader/tools/example-api.ts",
          // The sandbox the tool runs in is the member's, so its add-on stays at the member root.
          "agents/pm/agent/subagents/reader/sandbox/addons/example-api.ts",
        ]),
      },
    ]);
  });

  it.each(["ghost", "../../sam", "reader/ghost"])(
    "refuses the undeclared subagent path %s rather than creating it",
    async (subagent) => {
      const { project, store, deps } = harness({ team: true });
      const result = await installMarketplaceTemplate(
        project,
        { type: "connection", id: "example-api", member: "pm", subagent },
        deps,
      );

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("No subagent named"),
      });
      expect(await listDrafts(project.id, store)).toEqual([]);
    },
  );
});
