/**
 * OpenRouter model catalog — the source of truth for the agent model picker.
 *
 * harnesst supports OpenRouter as the primary model path for deployed agents. The picker lists
 * OpenRouter model ids, and the settings route writes those ids into `openrouter.chatModel("...")`
 * provider wiring in `agent.ts`. The endpoint is public; every non-id field is optional so
 * parsing stays loose and OpenRouter can add fields without breaking the picker.
 */
import { z } from "zod";

import { SwrCache } from "~/github/cache.server";
import type { ModelProviderId } from "~/models/provider-reference";
import {
  classifyReasoningCapability,
  isReasoningEffort,
  type ReasoningEffort,
} from "~/models/reasoning";

const DEFAULT_OPENROUTER_API_BASE_URL = "https://openrouter.ai";
const TTL_MS = 60 * 60 * 1000; // 1 hour — model metadata changes on the order of days.
const DESCRIPTION_MAX = 160;

/** One model as the picker consumes it — flat, numbers pre-computed. */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  tags: string[];
  /** Normalized reasoning choices; absent when no reasoning control is known. */
  supportedEfforts?: ReasoningEffort[];
  /** Upstream default when the provider publishes one. */
  providerDefaultEffort?: ReasoningEffort;
  /** USD per 1M input tokens. */
  inputPerMTok: number | null;
  /** USD per 1M output tokens. */
  outputPerMTok: number | null;
  providers: string[];
  /** Connection metadata is populated after a raw provider catalog is qualified for a workspace. */
  provider?: ModelProviderId;
  providerName?: string;
  connectionId?: string;
  connectionLabel?: string;
  /** Provider-native id sent upstream after harnesst removes the connection qualification. */
  upstreamModelId?: string;
}

const modelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().nullish(),
    context_length: z.number().nullish(),
    architecture: z
      .object({
        output_modalities: z.array(z.string()).optional(),
      })
      .passthrough()
      .nullish(),
    pricing: z
      .object({
        prompt: z.string().nullish(),
        completion: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    top_provider: z
      .object({
        context_length: z.number().nullish(),
        max_completion_tokens: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
    supported_parameters: z.array(z.string()).optional(),
    reasoning: z
      .object({
        supported_efforts: z.array(z.string()).optional(),
        default_effort: z.string().optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const modelsSchema = z.object({ data: z.array(modelSchema) }).passthrough();

/** USD-per-single-token string → USD per 1M tokens, or null when absent/unparseable. */
function perMTok(price: string | null | undefined): number | null {
  if (price == null) return null;
  const n = Number(price);
  return Number.isFinite(n) ? n * 1_000_000 : null;
}

/**
 * Normalize OpenRouter's model list into the flat picker shape. Pure — no fetch, no cache —
 * so parsing/filtering/pricing rules are exercised directly in tests.
 */
export function normalizeCatalog(payload: unknown): ModelCatalogEntry[] {
  const parsed = modelsSchema.parse(payload);

  return parsed.data
    .filter((m) => {
      const output = m.architecture?.output_modalities;
      return !output || output.includes("text");
    })
    .map((m): ModelCatalogEntry => {
      const description = m.description ?? null;
      const discovered =
        m.reasoning?.supported_efforts?.filter(isReasoningEffort);
      const fallback = classifyReasoningCapability({
        provider: "openrouter",
        modelId: m.id,
        supportedParameters: m.supported_parameters,
      });
      const supportedEfforts = discovered?.length
        ? discovered
        : fallback?.supportedEfforts;
      const providerDefaultEffort = isReasoningEffort(
        m.reasoning?.default_effort,
      )
        ? m.reasoning.default_effort
        : undefined;
      return {
        id: m.id,
        name: m.name ?? m.id,
        description:
          description && description.length > DESCRIPTION_MAX
            ? `${description.slice(0, DESCRIPTION_MAX).trimEnd()}...`
            : description,
        contextWindow:
          m.context_length ?? m.top_provider?.context_length ?? null,
        maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
        tags: m.supported_parameters ?? [],
        ...(supportedEfforts ? { supportedEfforts } : {}),
        ...(providerDefaultEffort ? { providerDefaultEffort } : {}),
        inputPerMTok: perMTok(m.pricing?.prompt),
        outputPerMTok: perMTok(m.pricing?.completion),
        providers: [],
        upstreamModelId: m.id,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const globalForCache = globalThis as unknown as {
  __harnesstModelCatalogCache?: SwrCache;
};

const catalogCache: SwrCache =
  globalForCache.__harnesstModelCatalogCache ?? new SwrCache();

if (process.env.NODE_ENV !== "production") {
  globalForCache.__harnesstModelCatalogCache = catalogCache;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`openrouter ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** OpenRouter host, overridable for self-hosted proxies and deterministic integration tests. */
export function openRouterApiBase(): string {
  return (
    process.env.EDEN_OPENROUTER_API_BASE_URL ?? DEFAULT_OPENROUTER_API_BASE_URL
  ).replace(/\/+$/, "");
}

/** The full picker catalog, SWR-cached for an hour. */
export function listOpenRouterModels(): Promise<ModelCatalogEntry[]> {
  const baseUrl = openRouterApiBase();
  return catalogCache.get(`openrouter:models:${baseUrl}`, TTL_MS, async () =>
    normalizeCatalog(await fetchJson(`${baseUrl}/api/v1/models`)),
  );
}

/** Returns null when the catalog cannot be loaded or the id is absent. */
export async function findModel(id: string): Promise<ModelCatalogEntry | null> {
  try {
    const models = await listOpenRouterModels();
    return models.find((m) => m.id === id) ?? null;
  } catch {
    return null;
  }
}
