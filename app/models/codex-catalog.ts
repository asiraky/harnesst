/**
 * Codex model catalog (issue #28, Phase 1) — the curated list of ChatGPT-subscription models the
 * gateway can run, plus the connection-qualified model-id helpers.
 *
 * A Codex model surfaces in the pickers as `codex/<connectionId>/<slug>` so one picked value
 * carries BOTH which connection serves the turn and which upstream model. The gateway parses that
 * id, authorizes the connection, and forwards `<slug>` to the Codex Responses backend.
 *
 * The slug list is curated from the Codex backend's own catalog
 * (`GET https://chatgpt.com/backend-api/codex/models?client_version=<ver>`, what `codex debug
 * models` renders). That endpoint filters by client version, so an old version string hides newer
 * models. Only models with `visibility: "list"` are included. Pricing is null (a subscription isn't
 * per-token billed here).
 */
import type { ReasoningEffort } from "~/models/reasoning";

export interface CodexModelSpec {
  /** The upstream model id sent to the Codex backend. */
  slug: string;
  /** Human display name for the picker. */
  name: string;
  /** Conservative context window in tokens, or null when unknown. */
  contextWindow: number | null;
  /** Efforts harnesst can send, from the backend catalog capped to the ReasoningEffort scale. */
  supportedEfforts: readonly ReasoningEffort[];
  providerDefaultEffort: ReasoningEffort;
}

/** The context window the Codex backend reports for every listed model. */
const CODEX_CONTEXT = 272_000;

/** Curated Codex-backend model specs. Ordered newest/most-capable first. */
export const CODEX_MODEL_SPECS: readonly CodexModelSpec[] = [
  // Upstream also lists "max" (and "ultra" on some models) efforts, which harnesst's
  // ReasoningEffort scale doesn't model, so every list is capped at xhigh. Upstream lists no
  // "none" effort for any of these, and rejects it.
  {
    slug: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    contextWindow: CODEX_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "low",
  },
  {
    slug: "gpt-6-astra",
    name: "GPT-6 Astra",
    contextWindow: CODEX_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-6-sol",
    name: "GPT-6 Sol",
    contextWindow: CODEX_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-6-luna",
    name: "GPT-6 Luna",
    contextWindow: CODEX_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    contextWindow: CODEX_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "low",
  },
  {
    slug: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    contextWindow: CODEX_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  {
    slug: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    contextWindow: CODEX_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    providerDefaultEffort: "medium",
  },
  // Upstream retires GPT-5.5 on 2026-10-14 (its upgrade target is GPT-5.6 Sol).
  {
    slug: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: CODEX_CONTEXT,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
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
