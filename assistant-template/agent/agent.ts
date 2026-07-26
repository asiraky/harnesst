import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

// harnesst's built-in project assistant. This is the FIXED, harnesst-owned layer — do not edit it in a
// user repo; the user layer arrives as instructions/skills/schedules materialized by the
// container entrypoint before `eve build`. The model is env-driven so a
// per-project override needs only a restart, not a rebuilt image.
const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});
// harnesst's model gateway is Codex-OAuth-only. API-key providers connect directly below.
const harnesstGateway = createOpenAICompatible({
  name: "harnesst",
  baseURL: process.env.HARNESST_MODEL_GATEWAY_URL ?? "",
  apiKey: process.env.HARNESST_MODEL_GATEWAY_TOKEN ?? "",
});

// Keep the fixed template build-safe; assistantEnv/entrypoint injects the configured model at runtime.
const assistantModelId = process.env.HARNESST_ASSISTANT_MODEL ?? "z-ai/glm-5.2";
const assistantEffort = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
].includes(process.env.HARNESST_ASSISTANT_EFFORT ?? "")
  ? (process.env.HARNESST_ASSISTANT_EFFORT as
      "none" | "minimal" | "low" | "medium" | "high" | "xhigh")
  : undefined;

function assistantModel(id: string) {
  const qualified = id.match(
    /^(anthropic|codex|openai|openrouter)\/([a-z]{12})\/(.+)$/,
  );
  // Runtime compatibility for assistants configured with a pre-Phase-2 bare OpenRouter id.
  if (!qualified) return openrouter.chatModel(id);
  const provider = qualified[1];
  const connectionId = qualified[2];
  const upstreamModelId = qualified[3];
  if (provider === "codex") return harnesstGateway.chatModel(id);
  const envName =
    "HARNESST_PROVIDER_" +
    provider.toUpperCase() +
    "_" +
    connectionId.toUpperCase() +
    "_API_KEY";
  const apiKey = process.env[envName];
  if (!apiKey) {
    throw new Error(
      "No credential was deployed for the selected " +
        provider +
        " connection.",
    );
  }
  if (provider === "anthropic") {
    return createAnthropic({
      name: "anthropic/" + connectionId,
      apiKey,
    }).chat(upstreamModelId);
  }
  if (provider === "openai") {
    return createOpenAI({ name: "openai/" + connectionId, apiKey }).responses(
      upstreamModelId,
    );
  }
  return createOpenAICompatible({
    name: "openrouter/" + connectionId,
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  }).chatModel(upstreamModelId);
}

export default defineAgent({
  model: assistantModel(assistantModelId),
  reasoning: assistantEffort,
  modelContextWindowTokens: 200000,
  // Deployable off-Vercel: declare + externalize the Postgres Workflow world.
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
});
