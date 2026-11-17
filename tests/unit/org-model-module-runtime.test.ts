import { createHmac, timingSafeEqual } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { orgModelModuleSource } from "~/eve/org-model-module";

interface Selection {
  model: string;
  effort?: string | null;
  contextWindowTokens?: number;
}

function runtime(
  resolve: (agent: string, subagent: string) => Selection | null,
) {
  let now = 0;
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input);
    const config = resolve(
      url.searchParams.get("agent")!,
      url.searchParams.get("subagent") ?? "",
    );
    return {
      ok: !!config,
      status: config ? 200 : 400,
      json: async () =>
        config ?? { error: { message: "Set a workspace default first." } },
    };
  });
  const provider = ({
    name,
    headers,
  }: {
    name: string;
    headers?: Record<string, string>;
  }) => ({
    chatModel: (modelId: string) => ({ provider: name, modelId, headers }),
  });
  const exports: Record<string, unknown> = {};
  const js = ts.transpileModule(orgModelModuleSource(), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  runInNewContext(js, {
    exports,
    require: (name: string) => {
      if (name === "node:crypto") return { createHmac, timingSafeEqual };
      if (name === "@ai-sdk/openai-compatible")
        return { createOpenAICompatible: provider };
      if (name === "@ai-sdk/anthropic" || name === "@ai-sdk/openai") return {};
      if (name === "eve") return { defineDynamic: (value: unknown) => value };
      if (name === "ai")
        return {
          wrapLanguageModel: ({
            model,
            middleware,
          }: Record<string, unknown>) => ({ ...(model as object), middleware }),
        };
      throw new Error(`Unexpected dependency ${name}`);
    },
    process: {
      env: {
        HARNESST_MODEL_GATEWAY_URL: "https://control.test/api/gateway/v1",
        HARNESST_MODEL_GATEWAY_TOKEN: "test-token",
        HARNESST_PROJECT_ID: "project-392",
      },
    },
    Date: { now: () => now },
    fetch,
  });
  const create = exports.harnesstAgentModel as (
    agent: string,
    subagent?: string,
  ) => {
    events: {
      "step.started": (
        event: unknown,
        ctx: { messages: unknown[] },
      ) => Promise<{
        model: { modelId: string; headers?: Record<string, string> };
        modelContextWindowTokens?: number;
      }>;
    };
  };
  return {
    fetch,
    advance: (ms: number) => {
      now += ms;
    },
    step: (agent: string, subagent?: string) =>
      create(agent, subagent).events["step.started"]({}, { messages: [] }),
    stepWith: (
      agent: string,
      subagent: string | undefined,
      event: unknown,
      ctx: { messages: unknown[]; session?: { id: string } },
    ) => create(agent, subagent).events["step.started"](event, ctx),
  };
}

describe("generated workspace resolver at runtime", () => {
  it("observes default changes after 30 seconds while independent agent and subagent pins remain fixed", async () => {
    let workspace = "codex/abcdefghijkl/first";
    let contextWindow = 200000;
    const pins = new Map([
      ["pinned#", "codex/abcdefghijkl/pinned"],
      ["ledger#qa", "codex/abcdefghijkl/qa-pin"],
    ]);
    const env = runtime((agent, subagent) => ({
      model:
        pins.get(`${agent}#${subagent}`) ?? pins.get(`${agent}#`) ?? workspace,
      contextWindowTokens: contextWindow,
    }));
    expect((await env.step("ledger")).model.modelId).toBe(workspace);
    expect((await env.step("ledger", "reviewer")).model.modelId).toBe(
      workspace,
    );
    expect((await env.step("ledger", "qa")).model.modelId).toContain("qa-pin");
    expect((await env.step("pinned", "reviewer")).model.modelId).toContain(
      "/pinned",
    );
    workspace = "codex/abcdefghijkl/second";
    contextWindow = 128000;
    env.advance(29_999);
    expect((await env.step("ledger")).model.modelId).toContain("/first");
    expect(env.fetch).toHaveBeenCalledTimes(4);
    env.advance(1);
    expect(await env.step("ledger")).toMatchObject({
      model: { modelId: workspace },
      modelContextWindowTokens: 128000,
    });
    expect((await env.step("ledger", "reviewer")).model.modelId).toBe(
      workspace,
    );
    expect((await env.step("ledger", "qa")).model.modelId).toContain("qa-pin");
    expect((await env.step("pinned", "reviewer")).model.modelId).toContain(
      "/pinned",
    );
    const request = new URL(env.fetch.mock.calls[1][0]);
    expect(Object.fromEntries(request.searchParams)).toEqual({
      agent: "ledger",
      subagent: "reviewer",
      project: "project-392",
    });
  });

  it("rejects missing context metadata without caching it and recovers on the next step", async () => {
    let selection: Selection = { model: "codex/abcdefghijkl/default" };
    const env = runtime(() => selection);
    await expect(env.step("ledger")).rejects.toThrow("context window");
    selection = { ...selection, contextWindowTokens: 64000 };
    expect(await env.step("ledger")).toMatchObject({
      modelContextWindowTokens: 64000,
    });
    expect(env.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache missing configuration or serve an expired selection when the lookup fails", async () => {
    let selection: Selection | null = null;
    const env = runtime(() => selection);
    await expect(env.step("ledger")).rejects.toThrow(
      "Set a workspace default first",
    );
    selection = {
      model: "codex/abcdefghijkl/default",
      contextWindowTokens: 128000,
    };
    expect((await env.step("ledger")).model.modelId).toBe(selection.model);
    selection = null;
    env.advance(30_000);
    await expect(env.step("ledger")).rejects.toThrow(
      "Set a workspace default first",
    );
    expect(env.fetch).toHaveBeenCalledTimes(3);
  });

  it("labels each Codex step with the agent, session, turn, step and project for the call log", async () => {
    const env = runtime(() => ({
      model: "codex/abcdefghijkl/default",
      contextWindowTokens: 128000,
    }));
    const result = await env.stepWith(
      "ledger bot",
      "qa/fact-checker",
      { type: "step.started", data: { turnId: "turn_9", stepIndex: 3 } },
      { messages: [], session: { id: "sess/1" } },
    );
    expect(result.model.headers).toEqual({
      "x-harnesst-agent": "ledger%20bot",
      "x-harnesst-subagent": "qa%2Ffact-checker",
      "x-harnesst-session": "sess%2F1",
      "x-harnesst-turn": "turn_9",
      "x-harnesst-step": "3",
      "x-harnesst-project": "project-392",
    });
  });

  it("omits labels the step event does not carry", async () => {
    const env = runtime(() => ({
      model: "codex/abcdefghijkl/default",
      contextWindowTokens: 128000,
    }));
    const result = await env.stepWith("ledger", undefined, null, {
      messages: [],
    });
    expect(result.model.headers).toEqual({
      "x-harnesst-agent": "ledger",
      "x-harnesst-project": "project-392",
    });
  });

  it("sends no call-log labels to providers other than the Codex gateway", async () => {
    const env = runtime(() => ({
      model: "openrouter/abcdefghijkl/some-model",
      contextWindowTokens: 128000,
    }));
    const result = await env.stepWith(
      "ledger",
      undefined,
      { data: { turnId: "t", stepIndex: 0 } },
      { messages: [], session: { id: "s" } },
    );
    expect(result.model.headers).toBeUndefined();
  });
});
