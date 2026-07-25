import type { ModelProviderId } from "~/models/provider-reference";

/** Superset of the named reasoning levels exposed by harnesst's supported providers. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelReasoningCapability {
  supportedEfforts: ReasoningEffort[];
  /** The upstream catalog's default, when it publishes one. */
  providerDefaultEffort?: ReasoningEffort;
}

const STANDARD_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/** Remove a provider connection prefix when a qualified id reaches the classifier. */
export function reasoningUpstreamModelId(
  provider: ModelProviderId,
  modelId: string,
): string {
  const prefix = `${provider}/`;
  if (!modelId.startsWith(prefix)) return modelId;
  const rest = modelId.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.slice(slash + 1);
}

/**
 * Capability discovery for catalogs whose model endpoint does not publish reasoning levels.
 * This is deliberately conservative: unknown models get no control instead of a rejected option.
 */
export function classifyReasoningCapability(input: {
  provider: ModelProviderId;
  modelId: string;
  supportedParameters?: readonly string[];
}): ModelReasoningCapability | null {
  const { provider, supportedParameters = [] } = input;
  const id = reasoningUpstreamModelId(provider, input.modelId).toLowerCase();

  if (provider === "openrouter") {
    return supportedParameters.includes("reasoning")
      ? { supportedEfforts: [...STANDARD_EFFORTS] }
      : null;
  }

  if (provider === "anthropic") {
    // Extended/adaptive thinking is available on Claude 3.7 and the Claude 4+ families.
    return /(?:^|\/)claude-(?:3[-.]7|(?:sonnet|opus|haiku)-4|4[-.])/.test(id)
      ? { supportedEfforts: [...STANDARD_EFFORTS] }
      : null;
  }

  if (provider === "openai" || provider === "codex") {
    const base = id.startsWith("ft:") ? id.slice(3) : id;
    if (!/^(?:gpt-5(?:[.:-]|$)|o\d(?:[.:-]|$)|codex-)/.test(base)) {
      return null;
    }
    if (/^gpt-5(?:\.6|\.5|\.4|\.3|\.2)(?:[.:-]|$)/.test(base)) {
      return {
        supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
      };
    }
    if (/^gpt-5\.1(?:[.:-]|$)/.test(base)) {
      return { supportedEfforts: ["none", "low", "medium", "high"] };
    }
    if (/^gpt-5(?:[.:-]|$)/.test(base)) {
      return { supportedEfforts: ["minimal", "low", "medium", "high"] };
    }
    return { supportedEfforts: [...STANDARD_EFFORTS] };
  }

  return null;
}
