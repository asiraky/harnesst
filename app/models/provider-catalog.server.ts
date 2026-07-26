/** Provider-specific API-key validation and model catalogs (issue #28, Phase 2). */
import { z } from "zod";

import {
  normalizeCatalog,
  openRouterApiBase,
  type ModelCatalogEntry,
} from "~/models/catalog.server";
import { CODEX_MODEL_SPECS } from "~/models/codex-catalog";
import {
  MODEL_PROVIDERS,
  type ApiKeyProviderId,
  type ModelProviderId,
} from "~/models/provider-reference";
import { classifyReasoningCapability } from "~/models/reasoning";

const DEFAULT_ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com";

export function anthropicApiBase(): string {
  return (
    process.env.HARNESST_ANTHROPIC_API_BASE_URL ?? DEFAULT_ANTHROPIC_API_BASE_URL
  ).replace(/\/+$/, "");
}

export function openAiApiBase(): string {
  return (
    process.env.HARNESST_OPENAI_API_BASE_URL ?? DEFAULT_OPENAI_API_BASE_URL
  ).replace(/\/+$/, "");
}

export interface ProviderCatalogDeps {
  fetch?: typeof fetch;
  listOpenRouter?: (apiKey: string) => Promise<ModelCatalogEntry[]>;
}

function emptyEntry(input: {
  id: string;
  name?: string | null;
  provider: ModelProviderId;
  tags?: string[];
}): ModelCatalogEntry {
  const reasoning = classifyReasoningCapability({
    provider: input.provider,
    modelId: input.id,
    supportedParameters: input.tags,
  });
  return {
    id: input.id,
    name: input.name || input.id,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    tags: input.tags ?? [],
    ...(reasoning ?? {}),
    inputPerMTok: null,
    outputPerMTok: null,
    providers: [input.provider],
    upstreamModelId: input.id,
  };
}

async function providerJson(
  provider: ModelProviderId,
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    throw new Error(
      `${MODEL_PROVIDERS[provider].displayName} could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${MODEL_PROVIDERS[provider].displayName} rejected the credential (HTTP ${response.status}).`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(
      `${MODEL_PROVIDERS[provider].displayName} returned an invalid JSON response.`,
    );
  }
}

const anthropicModelSchema = z
  .object({
    id: z.string(),
    display_name: z.string().nullish(),
    type: z.string().optional(),
    max_input_tokens: z.number().int().positive().nullish(),
    max_tokens: z.number().int().positive().nullish(),
  })
  .passthrough();

const anthropicModelsSchema = z
  .object({
    data: z.array(anthropicModelSchema),
    has_more: z.boolean().optional().default(false),
    last_id: z.string().nullish(),
  })
  .passthrough();

/** Normalize one or more Anthropic `/v1/models` pages into provider-native catalog entries. */
export function normalizeAnthropicCatalog(
  payloads: unknown[],
): ModelCatalogEntry[] {
  return payloads
    .flatMap((payload) => anthropicModelsSchema.parse(payload).data)
    .map((model) => ({
      ...emptyEntry({
        id: model.id,
        name: model.display_name,
        provider: "anthropic",
      }),
      contextWindow: model.max_input_tokens ?? null,
      maxOutputTokens: model.max_tokens ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Fetch every Anthropic model page; `after_id` advances by the response's `last_id`. */
export async function listAnthropicModels(
  apiKey: string,
  deps: Pick<ProviderCatalogDeps, "fetch"> = {},
): Promise<ModelCatalogEntry[]> {
  const fetcher = deps.fetch ?? fetch;
  const pages: unknown[] = [];
  let afterId: string | null = null;
  const seenCursors = new Set<string>();

  for (;;) {
    const url = new URL(`${anthropicApiBase()}/v1/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const payload = await providerJson(
      "anthropic",
      url.toString(),
      {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
      fetcher,
    );
    const parsed = anthropicModelsSchema.parse(payload);
    pages.push(payload);
    if (!parsed.has_more) break;
    if (!parsed.last_id || seenCursors.has(parsed.last_id)) {
      throw new Error(
        "Anthropic returned an invalid model-catalog pagination cursor.",
      );
    }
    seenCursors.add(parsed.last_id);
    afterId = parsed.last_id;
  }

  return normalizeAnthropicCatalog(pages);
}

const openAiModelSchema = z
  .object({
    id: z.string(),
    owned_by: z.string().optional(),
  })
  .passthrough();

const openAiModelsSchema = z
  .object({ data: z.array(openAiModelSchema) })
  .passthrough();

/** Keep chat/text generation models while excluding non-text GPT variants and specialist APIs. */
export function isOpenAiTextModelId(id: string): boolean {
  const lower = id.toLowerCase();
  const family = lower.startsWith("ft:") ? lower.slice(3) : lower;
  if (
    /(?:audio|realtime|transcri|speech|tts|image|embedding|moderation|whisper|dall-e)/.test(
      family,
    )
  ) {
    return false;
  }
  return (
    /^(?:gpt-|chatgpt-|codex-)/.test(family) || /^o\d(?:[-.:]|$)/.test(family)
  );
}

/** Normalize OpenAI `/v1/models`, retaining only text/chat-capable model id families. */
export function normalizeOpenAiCatalog(payload: unknown): ModelCatalogEntry[] {
  return openAiModelsSchema
    .parse(payload)
    .data.filter((model) => isOpenAiTextModelId(model.id))
    .map((model) =>
      emptyEntry({
        id: model.id,
        provider: "openai",
        tags: model.owned_by ? [model.owned_by] : [],
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function listOpenAiModels(
  apiKey: string,
  deps: Pick<ProviderCatalogDeps, "fetch"> = {},
): Promise<ModelCatalogEntry[]> {
  const payload = await providerJson(
    "openai",
    `${openAiApiBase()}/v1/models`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
    },
    deps.fetch ?? fetch,
  );
  return normalizeOpenAiCatalog(payload);
}

/** OpenRouter's model list fetched with this exact connection's credential. */
export async function listOpenRouterProviderModels(
  apiKey: string,
  deps: ProviderCatalogDeps = {},
): Promise<ModelCatalogEntry[]> {
  if (deps.listOpenRouter) return deps.listOpenRouter(apiKey);
  const payload = await providerJson(
    "openrouter",
    `${openRouterApiBase()}/api/v1/models`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
    },
    deps.fetch ?? fetch,
  );
  return normalizeCatalog(payload);
}

export function listCodexModels(): ModelCatalogEntry[] {
  return CODEX_MODEL_SPECS.map((model) => ({
    ...emptyEntry({ id: model.slug, name: model.name, provider: "codex" }),
    description: "OpenAI Codex subscription",
    contextWindow: model.contextWindow,
    tags: ["codex", "subscription"],
    supportedEfforts: [...model.supportedEfforts],
    providerDefaultEffort: model.providerDefaultEffort,
  }));
}

/** Validate a key against the provider rather than storing an unchecked secret. */
export async function validateProviderApiKey(
  provider: ApiKeyProviderId,
  apiKey: string,
  deps: ProviderCatalogDeps = {},
): Promise<void> {
  if (!apiKey.trim()) throw new Error("An API key is required.");
  if (provider === "openrouter") {
    await providerJson(
      provider,
      `${openRouterApiBase()}/api/v1/key`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
      },
      deps.fetch ?? fetch,
    );
    return;
  }
  if (provider === "anthropic") {
    await listAnthropicModels(apiKey, deps);
    return;
  }
  await listOpenAiModels(apiKey, deps);
}

/** Return a provider-native catalog. API-key providers require the unsealed connection key. */
export async function listProviderModels(
  provider: ModelProviderId,
  apiKey: string | null,
  deps: ProviderCatalogDeps = {},
): Promise<ModelCatalogEntry[]> {
  if (provider === "codex") return listCodexModels();
  if (!apiKey)
    throw new Error(`${MODEL_PROVIDERS[provider].displayName} has no API key.`);
  if (provider === "openrouter") {
    return listOpenRouterProviderModels(apiKey, deps);
  }
  if (provider === "anthropic") return listAnthropicModels(apiKey, deps);
  return listOpenAiModels(apiKey, deps);
}
