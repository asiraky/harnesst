/**
 * Codex model catalog (issue #28, Phase 1) — the curated list of ChatGPT-subscription models the
 * gateway can run, plus the connection-qualified model-id helpers.
 *
 * A Codex model surfaces in the pickers as `codex/<connectionId>/<slug>` so one picked value
 * carries BOTH which connection serves the turn and which upstream model. The gateway parses that
 * id, authorizes the connection, and forwards `<slug>` to the Codex Responses backend.
 *
 * The slug list is curated (source: ChatMock `chatmock/model_registry.py`) pending a dynamic Codex
 * catalog in Phase 2 — the ChatGPT backend has no public models endpoint. Context windows are a
 * conservative 272k for the gpt-5 family (null is acceptable when unknown); pricing is null (a
 * subscription isn't per-token billed here).
 */
import type { ReasoningEffort } from "~/models/reasoning";

export interface CodexModelSpec {
  /** The upstream model id sent to the Codex backend. */
  slug: string;
  /** Human display name for the picker. */
  name: string;
  /** Conservative context window in tokens, or null when unknown. */
  contextWindow: number | null;
  /** Curated because the subscription backend has no public model metadata endpoint. */
  supportedEfforts: readonly ReasoningEffort[];
  providerDefaultEffort: ReasoningEffort;
}

/** gpt-5 family context window — conservative; refine when a dynamic catalog lands (Phase 2). */
const GPT5_CONTEXT = 272_000;

/** Curated Codex-backend model specs. Ordered newest/most-capable first. */
export const CODEX_MODEL_SPECS: readonly CodexModelSpec[] = [
  // The 5.6 family (ChatMock registry). Upstream also lists a "max" effort, which harnesst's
  // ReasoningEffort scale doesn't model — capped at xhigh.
  {
    slug: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["low", "medium", "high"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.2",
    name: "GPT-5.2",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.1-codex-max",
    name: "GPT-5.1 Codex Max",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["none", "low", "medium", "high"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["none", "low", "medium", "high"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5-codex",
    name: "GPT-5 Codex",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["minimal", "low", "medium", "high"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5",
    name: "GPT-5",
    contextWindow: GPT5_CONTEXT,
    supportedEfforts: ["minimal", "low", "medium", "high"],
    providerDefaultEffort: "medium",
  },
] as const;

/** Prefix marking a connection-qualified Codex model id. */
export const CODEX_MODEL_ID_PREFIX = "codex/";

/** Build a connection-qualified model id: `codex/<connectionId>/<slug>`. */
export function buildCodexModelId(connectionId: string, slug: string): string {
  return `${CODEX_MODEL_ID_PREFIX}${connectionId}/${slug}`;
}

/**
 * Parse a `codex/<connectionId>/<slug>` id into its parts, or null when it isn't one. The slug may
 * itself contain no slashes in practice, but we keep everything after the connection segment as the
 * slug so future dotted/dashed slugs stay intact.
 */
export function parseCodexModelId(
  id: string,
): { connectionId: string; slug: string } | null {
  if (!id.startsWith(CODEX_MODEL_ID_PREFIX)) return null;
  const rest = id.slice(CODEX_MODEL_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const connectionId = rest.slice(0, slash);
  const slug = rest.slice(slash + 1);
  if (!connectionId || !slug) return null;
  return { connectionId, slug };
}

/** Look up a curated spec by slug, or null when the slug is unknown. */
export function findCodexSpec(slug: string): CodexModelSpec | null {
  return CODEX_MODEL_SPECS.find((m) => m.slug === slug) ?? null;
}
