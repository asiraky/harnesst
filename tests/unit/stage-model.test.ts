/**
 * Model staging for Settings' "Model" section — against the in-memory store with GitHub and the
 * model catalog stubbed. Pins the two module generations: a workspace-resolver module
 * (`edenAgentModel(...)`) routes a model save into the org override map with zero repo churn,
 * while a legacy module gets the dynamic wrapper staged (per-conversation directives work) with
 * package.json normalized alongside.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDraft, listDrafts } from "~/drafts/drafts.server";
import { hasDynamicModel, readModel } from "~/eve/agentModule";
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
import { edenAgentModel } from './eden-model';

export default defineAgent({
  model: edenAgentModel('bookkeeping'),
  modelContextWindowTokens: 200000,
});
`;

/** Repo reads and the catalog lookups, keyed by path — no GitHub, no network. */
function fakeDeps(files: Record<string, string>): StageModelDeps {
  return {
    readFile: async (_installationId, _repo, path) => files[path] ?? null,
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
    // The override is keyed by the agent NAME the module resolves itself by.
    expect(setOverride).toHaveBeenCalledWith("org_1", "bookkeeping", {
      model: "openai/abcdefghijkl/gpt-5.1",
      effort: null,
    });
    expect(await listDrafts(PROJECT.id, store)).toEqual([]);
  });
});
