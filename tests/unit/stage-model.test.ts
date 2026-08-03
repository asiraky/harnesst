/**
 * Model staging for Settings' "Model" section — against the in-memory store with GitHub and the
 * model catalog stubbed. Pins the two module generations: a workspace-resolver module
 * (`harnesstAgentModel(...)`) routes a model save into the org override map with zero repo churn,
 * while a legacy module gets the dynamic wrapper staged (per-conversation directives work) with
 * package.json normalized alongside.
 *
 * And the declared-subagent target (issue #344): the row is keyed by the member's resolver name
 * plus the subagent path, "same as what I inherit" compares against the PARENT (never the
 * workspace default), dependencies still land in the MEMBER's package.json, and a subagent whose
 * module still makes the pre-#344 one-argument call gets that call upgraded as a draft.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDraft, listDrafts } from "~/drafts/drafts.server";
import {
  hasDynamicModel,
  orgResolverTarget,
  readModel,
} from "~/eve/agentModule";
import {
  stageModelChange,
  type StageModelDeps,
} from "~/models/stage-model.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = {
  id: "proj_1",
  orgId: "org_1",
  repoInstallationId: "inst_1",
  repoOwner: "acme",
  repoName: "agent",
};

/** A pre-wrapper module, as shipped by older catalog templates — ignores model directives. */
const STATIC_AGENT_TS = `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

export default defineAgent({
  model: openrouter.chatModel("z-ai/glm-5.2"),
  modelContextWindowTokens: 1000000,
});
`;

const PKG =
  JSON.stringify({ dependencies: { eve: "^0.20.0", zod: "^4.4.3" } }, null, 2) +
  "\n";

/** A workspace-resolver module — no model in the file; org config is the source of truth. */
const RESOLVER_AGENT_TS = `import { defineAgent } from 'eve';
import { harnesstAgentModel } from './harnesst-model';

export default defineAgent({
  model: harnesstAgentModel('bookkeeping'),
  modelContextWindowTokens: 200000,
});
`;

/** Repo reads and the catalog lookups, keyed by path — no GitHub, no network. */
function fakeDeps(files: Record<string, string>): StageModelDeps {
  return {
    readFile: async (_installationId, _repo, path) => files[path] ?? null,
    getWorkspaceSelection: async () => ({ model: null, effort: null }),
    lookupModel: async (_orgId, model) =>
      model.startsWith("openrouter/") || model.startsWith("openai/")
        ? {
            id: model,
            name: model,
            description: null,
            contextWindow: null,
            maxOutputTokens: null,
            tags: [],
            inputPerMTok: null,
            outputPerMTok: null,
            providers: [],
            upstreamModelId: model.split("/").slice(2).join("/"),
            provider: model.startsWith("openai/") ? "openai" : "openrouter",
            providerName: model.startsWith("openai/")
              ? "OpenAI Platform"
              : "OpenRouter",
            connectionId: "abcdefghijkl",
            connectionLabel: "Test",
          }
        : null,
  };
}

let store: FakeStore;

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT.id, orgId: "org_1" });
  store.seedAgent({ id: "agent_1", projectId: PROJECT.id });
});

describe("stageModelChange", () => {
  it("stages agent.ts with the dynamic wrapper and the package.json dependency bumps", async () => {
    const result = await stageModelChange(
      {
        project: PROJECT,
        root: "agent",
        model: "openai/abcdefghijkl/gpt-5.1",
        createdBy: "user_1",
      },
      store,
      fakeDeps({ "agent/agent.ts": STATIC_AGENT_TS, "package.json": PKG }),
    );

    expect(result).toEqual({ ok: true, mode: "staged" });
    const agentDraft = await getDraft(PROJECT.id, "agent/agent.ts", store);
    expect(hasDynamicModel(agentDraft?.content)).toBe(true);
    expect(readModel(agentDraft!.content!)).toBe("openai/abcdefghijkl/gpt-5.1");
    const pkg = JSON.parse(
      (await getDraft(PROJECT.id, "package.json", store))!.content!,
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBe("^4.0.12");
    expect(pkg.dependencies["@ai-sdk/openai"]).toBe("^4.0.11");
    expect(pkg.dependencies["@ai-sdk/openai-compatible"]).toBe("^3.0.7");
    expect(pkg.dependencies.eve).toBe("^0.22.0"); // < 0.22 can't provide defineDynamic
  });

  it("reports invalid package.json instead of staging half a change", async () => {
    const result = await stageModelChange(
      {
        project: PROJECT,
        root: "agent",
        model: "openai/abcdefghijkl/gpt-5.1",
        createdBy: null,
      },
      store,
      fakeDeps({ "agent/agent.ts": STATIC_AGENT_TS, "package.json": "{ nope" }),
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(await getDraft(PROJECT.id, "agent/agent.ts", store)).toBeNull();
  });

  it("rejects a model that is not owned by an active workspace connection", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": STATIC_AGENT_TS,
      "package.json": PKG,
    });
    deps.lookupModel = async () => null;
    const result = await stageModelChange(
      {
        project: PROJECT,
        root: "agent",
        model: "openai/zzzzzzzzzzzz/gpt-5.1",
        createdBy: "user_1",
      },
      store,
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("active provider connection"),
    });
    expect(await getDraft(PROJECT.id, "agent/agent.ts", store)).toBeNull();
  });

  it("writes the org override map for a workspace-resolver module — no drafts, no repo churn", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "package.json": PKG,
    });
    const setOverride = vi.fn().mockResolvedValue(undefined);
    deps.setOverride = setOverride;

    const result = await stageModelChange(
      {
        project: PROJECT,
        root: "agent",
        model: "openai/abcdefghijkl/gpt-5.1",
        effort: null,
        createdBy: "user_1",
      },
      store,
      deps,
    );

    expect(result).toEqual({ ok: true, mode: "applied" });
    // The override is keyed by the TARGET: the name the module resolves itself by, the agent's
    // own (empty) subagent path, and the repo it lives in.
    expect(setOverride).toHaveBeenCalledWith(
      "org_1",
      { agentName: "bookkeeping", subagentPath: "", projectId: PROJECT.id },
      { model: "openai/abcdefghijkl/gpt-5.1", effort: null },
    );
    expect(await listDrafts(PROJECT.id, store)).toEqual([]);
  });

  it("removes the override when the agent chooses the workspace default", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "package.json": PKG,
    });
    deps.getWorkspaceSelection = async () => ({
      model: "openai/abcdefghijkl/gpt-5.1",
      effort: null,
    });
    const setOverride = vi.fn().mockResolvedValue(undefined);
    const removeOverride = vi.fn().mockResolvedValue(undefined);
    deps.setOverride = setOverride;
    deps.removeOverride = removeOverride;

    const result = await stageModelChange(
      {
        project: PROJECT,
        root: "agent",
        model: "openai/abcdefghijkl/gpt-5.1",
        effort: null,
        createdBy: "user_1",
      },
      store,
      deps,
    );

    expect(result).toEqual({ ok: true, mode: "applied" });
    expect(removeOverride).toHaveBeenCalledWith("org_1", {
      agentName: "bookkeeping",
      subagentPath: "",
      projectId: PROJECT.id,
    });
    expect(setOverride).not.toHaveBeenCalled();
  });
});

/** A subagent module that still asks with only its parent's name — the pre-#344 shape. */
const LEGACY_SUBAGENT_TS = `import { defineAgent } from 'eve';
import { harnesstAgentModel } from '../../../harnesst/model.js';

export default defineAgent({
  description: 'Researches things',
  model: harnesstAgentModel('bookkeeping'),
});
`;

const SUBAGENT_INPUT = {
  project: PROJECT,
  root: "agent/subagents/researcher",
  deploymentRoot: "agent",
  subagentPath: "researcher",
  model: "openai/abcdefghijkl/gpt-5.1",
  effort: null,
  createdBy: "user_1",
} as const;

describe("stageModelChange — declared subagent targets", () => {
  it("keys the row by the member's resolver name plus the subagent path", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "agent/subagents/researcher/agent.ts": LEGACY_SUBAGENT_TS,
      "package.json": PKG,
    });
    const setOverride = vi.fn().mockResolvedValue(undefined);
    deps.setOverride = setOverride;
    // The parent inherits the workspace default (nothing configured) — so this is a real pin.
    deps.resolveTarget = vi.fn().mockResolvedValue(null);

    const result = await stageModelChange({ ...SUBAGENT_INPUT }, store, deps);

    expect(result.ok).toBe(true);
    expect(setOverride).toHaveBeenCalledWith(
      "org_1",
      {
        agentName: "bookkeeping",
        subagentPath: "researcher",
        projectId: PROJECT.id,
      },
      { model: "openai/abcdefghijkl/gpt-5.1", effort: null },
    );
    // Never the subagent's own directory: `agent/subagents/package.json` does not exist.
    expect(await getDraft(PROJECT.id, "package.json", store)).toBeNull();
    expect(
      await getDraft(PROJECT.id, "agent/subagents/package.json", store),
    ).toBeNull();
  });

  it("upgrades the subagent's one-argument resolver call as a draft", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "agent/subagents/researcher/agent.ts": LEGACY_SUBAGENT_TS,
      "package.json": PKG,
    });
    deps.setOverride = vi.fn().mockResolvedValue(undefined);
    deps.resolveTarget = vi.fn().mockResolvedValue(null);

    const result = await stageModelChange({ ...SUBAGENT_INPUT }, store, deps);

    // The row is live immediately; the running deployment needs the publish.
    expect(result).toEqual({ ok: true, mode: "applied", upgraded: true });
    const draft = await getDraft(
      PROJECT.id,
      "agent/subagents/researcher/agent.ts",
      store,
    );
    expect(orgResolverTarget(draft!.content!)).toEqual({
      agentName: "bookkeeping",
      subagentPath: "researcher",
    });
    // The rest of the subagent's module is untouched.
    expect(draft!.content).toContain("description: 'Researches things'");
  });

  it("writes the row only AFTER the module draft is staged", async () => {
    // Ordering matters: a saved pin the deployed module can never ask for is worse than no pin.
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "agent/subagents/researcher/agent.ts": LEGACY_SUBAGENT_TS,
      "package.json": PKG,
    });
    const setOverride = vi.fn().mockResolvedValue(undefined);
    deps.setOverride = setOverride;
    deps.resolveTarget = vi.fn().mockResolvedValue(null);
    vi.spyOn(store.drafts, "upsert").mockRejectedValue(new Error("db down"));

    await expect(
      stageModelChange({ ...SUBAGENT_INPUT }, store, deps),
    ).rejects.toThrow("db down");
    expect(setOverride).not.toHaveBeenCalled();
  });

  it("leaves an already-upgraded module alone", async () => {
    const upgraded = LEGACY_SUBAGENT_TS.replace(
      "harnesstAgentModel('bookkeeping')",
      "harnesstAgentModel('bookkeeping', 'researcher')",
    );
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "agent/subagents/researcher/agent.ts": upgraded,
      "package.json": PKG,
    });
    deps.setOverride = vi.fn().mockResolvedValue(undefined);
    deps.resolveTarget = vi.fn().mockResolvedValue(null);

    const result = await stageModelChange({ ...SUBAGENT_INPUT }, store, deps);

    expect(result).toEqual({ ok: true, mode: "applied" });
    expect(await listDrafts(PROJECT.id, store)).toEqual([]);
  });

  it("scaffolds a resolver module for a subagent that has none", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "package.json": PKG,
    });
    deps.setOverride = vi.fn().mockResolvedValue(undefined);
    deps.resolveTarget = vi.fn().mockResolvedValue(null);

    const result = await stageModelChange({ ...SUBAGENT_INPUT }, store, deps);

    expect(result).toEqual({ ok: true, mode: "applied", upgraded: true });
    const draft = await getDraft(
      PROJECT.id,
      "agent/subagents/researcher/agent.ts",
      store,
    );
    expect(draft!.content).toContain(
      "model: harnesstAgentModel('bookkeeping', 'researcher')",
    );
    // Depth 2 below the agent root — the module is the root's sibling.
    expect(draft!.content).toContain("from '../../../harnesst/model.js'");
  });

  it("drops the row when the subagent picks exactly what its PARENT resolves to", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "agent/subagents/researcher/agent.ts": LEGACY_SUBAGENT_TS.replace(
        "harnesstAgentModel('bookkeeping')",
        "harnesstAgentModel('bookkeeping', 'researcher')",
      ),
      "package.json": PKG,
    });
    const setOverride = vi.fn().mockResolvedValue(undefined);
    const removeOverride = vi.fn().mockResolvedValue(undefined);
    deps.setOverride = setOverride;
    deps.removeOverride = removeOverride;
    // The parent is pinned to this very model — and deliberately NOT the workspace default,
    // which stays empty: the comparison must be against the parent, not the default.
    deps.resolveTarget = vi.fn().mockResolvedValue({
      model: "openai/abcdefghijkl/gpt-5.1",
      effort: null,
      source: "override",
    });

    const result = await stageModelChange({ ...SUBAGENT_INPUT }, store, deps);

    expect(result).toEqual({ ok: true, mode: "applied" });
    expect(removeOverride).toHaveBeenCalledWith("org_1", {
      agentName: "bookkeeping",
      subagentPath: "researcher",
      projectId: PROJECT.id,
    });
    expect(setOverride).not.toHaveBeenCalled();
    // The parent chain is what was consulted.
    expect(deps.resolveTarget).toHaveBeenCalledWith("org_1", {
      agentName: "bookkeeping",
      subagentPath: "",
      projectId: PROJECT.id,
    });
  });

  it("stages a nested subagent's own two-argument call and asks its immediate parent", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "agent/subagents/researcher/subagents/checker/agent.ts": LEGACY_SUBAGENT_TS,
      "package.json": PKG,
    });
    deps.setOverride = vi.fn().mockResolvedValue(undefined);
    deps.resolveTarget = vi.fn().mockResolvedValue(null);

    const result = await stageModelChange(
      {
        ...SUBAGENT_INPUT,
        root: "agent/subagents/researcher/subagents/checker",
        subagentPath: "researcher/checker",
      },
      store,
      deps,
    );

    expect(result).toEqual({ ok: true, mode: "applied", upgraded: true });
    expect(deps.resolveTarget).toHaveBeenCalledWith("org_1", {
      agentName: "bookkeeping",
      subagentPath: "researcher",
      projectId: PROJECT.id,
    });
    const draft = await getDraft(
      PROJECT.id,
      "agent/subagents/researcher/subagents/checker/agent.ts",
      store,
    );
    expect(draft!.content).toContain(
      "harnesstAgentModel('bookkeeping', 'researcher/checker')",
    );
  });

  it("rewrites a subagent that carries its OWN baked model, member package.json and all", async () => {
    const deps = fakeDeps({
      "agent/agent.ts": RESOLVER_AGENT_TS,
      "agent/subagents/researcher/agent.ts": STATIC_AGENT_TS,
      "package.json": PKG,
    });
    const setOverride = vi.fn().mockResolvedValue(undefined);
    deps.setOverride = setOverride;

    const result = await stageModelChange({ ...SUBAGENT_INPUT }, store, deps);

    expect(result).toEqual({ ok: true, mode: "staged" });
    expect(setOverride).not.toHaveBeenCalled();
    const draft = await getDraft(
      PROJECT.id,
      "agent/subagents/researcher/agent.ts",
      store,
    );
    expect(readModel(draft!.content!)).toBe("openai/abcdefghijkl/gpt-5.1");
    // The MEMBER's package.json carries the dependency bump — a subagent has none.
    expect(await getDraft(PROJECT.id, "package.json", store)).not.toBeNull();
  });
});
