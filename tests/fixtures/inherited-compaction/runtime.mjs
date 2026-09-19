import assert from "node:assert/strict";
import { harnesstAgentModel } from "./model.mjs";
import { createToolLoopHarness } from "./node_modules/eve/dist/src/harness/tool-loop.js";
import {
  ContextContainer,
  contextStorage,
} from "./node_modules/eve/dist/src/context/container.js";
import { LiveStepDynamicModelSelectionKey } from "./node_modules/eve/dist/src/context/keys.js";
import { normalizeDynamicRuntimeModelResult } from "./node_modules/eve/dist/src/runtime/agent/resolve-model.js";
process.env.HARNESST_MODEL_GATEWAY_URL = "https://fixture.test/gateway";
process.env.HARNESST_MODEL_GATEWAY_TOKEN = "isolated";
let now = Date.now();
Date.now = () => now;
let selected = {
  model: "codex/abcdefghijkl/first",
  contextWindowTokens: 128000,
};
globalThis.fetch = async () => new Response(JSON.stringify(selected));
const dynamic = harnesstAgentModel("intake");
const fakeModel = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: "text", text: "OK" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
};
const ctx = new ContextContainer();
const fallback = {
  id: "openrouter/harnesst/unconfigured",
  contextWindowTokens: 128000,
};
const step = createToolLoopHarness({
  mode: "conversation",
  tools: new Map(),
  resolveModel: async () => {
    throw Error("Fallback must never serve");
  },
  dispatchDynamicModelEvent: async ({ ctx, event, messages }) => {
    const result = await dynamic.events["step.started"](event, { messages });
    const normalized = normalizeDynamicRuntimeModelResult({ fallback, result });
    ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, {
      ...normalized,
      model: fakeModel,
    });
  },
});
let session = {
  agent: {
    modelReference: fallback,
    dynamicModelDefaultReference: fallback,
    system: "Test",
    tools: [],
  },
  compaction: { threshold: 96000, recentWindowSize: 10 },
  continuationToken: "test",
  history: [],
  sessionId: "isolated",
};
for (const [model, window, expected] of [
  ["first", 128000, 96000],
  ["second", 64000, 48000],
  ["third", 200000, 150000],
]) {
  selected = {
    model: "codex/abcdefghijkl/" + model,
    contextWindowTokens: window,
  };
  now += 30000;
  const result = await contextStorage.run(ctx, () =>
    step(session, { message: "Say OK" }),
  );
  session = result.session;
  assert.equal(session.agent.modelReference.contextWindowTokens, window);
  assert.equal(session.compaction.threshold, expected);
  assert.ok(session.agent.modelReference.id.endsWith(model));
  console.log(
    JSON.stringify({
      model,
      contextWindow: window,
      threshold: session.compaction.threshold,
    }),
  );
}
