/**
 * Model-provider registry and connection-qualified model references (issue #28, Phase 2).
 *
 * A model reference always carries the provider, the exact workspace connection, and the
 * upstream model id: `<provider>/<connectionId>/<upstreamModelId>`. Upstream ids may themselves
 * contain slashes (OpenRouter ids commonly do), so parsing splits only the first two segments.
 */

export const MODEL_PROVIDER_IDS = [
  "openrouter",
  "anthropic",
  "openai",
  "codex",
] as const;

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];
export type ApiKeyProviderId = Exclude<ModelProviderId, "codex">;
export type ModelProviderAuthKind = "api-key" | "oauth";

export interface ModelProviderDefinition {
  id: ModelProviderId;
  displayName: string;
  authKind: ModelProviderAuthKind;
  /** Conventional runtime credential variable; null for gateway-backed OAuth providers. */
  standardEnv:
    "OPENROUTER_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | null;
}

export const MODEL_PROVIDERS: Readonly<
  Record<ModelProviderId, ModelProviderDefinition>
> = {
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    authKind: "api-key",
    standardEnv: "OPENROUTER_API_KEY",
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    authKind: "api-key",
    standardEnv: "ANTHROPIC_API_KEY",
  },
  openai: {
    id: "openai",
    displayName: "OpenAI Platform",
    authKind: "api-key",
    standardEnv: "OPENAI_API_KEY",
  },
  codex: {
    id: "codex",
    displayName: "OpenAI Codex",
    authKind: "oauth",
    standardEnv: null,
  },
};

export function isModelProviderId(value: string): value is ModelProviderId {
  return Object.prototype.hasOwnProperty.call(MODEL_PROVIDERS, value);
}

export function isApiKeyProviderId(value: string): value is ApiKeyProviderId {
  return (
    isModelProviderId(value) && MODEL_PROVIDERS[value].authKind === "api-key"
  );
}

export function getModelProvider(id: string): ModelProviderDefinition | null {
  return isModelProviderId(id) ? MODEL_PROVIDERS[id] : null;
}

export interface ProviderModelReference {
  provider: ModelProviderId;
  connectionId: string;
  upstreamModelId: string;
}

const CONNECTION_ID_PATTERN = /^[a-z]{12}$/;

export function isProviderConnectionId(value: string): boolean {
  return CONNECTION_ID_PATTERN.test(value);
}

/** Build a connection-qualified reference. The caller supplies an upstream, unqualified id. */
export function buildProviderModelReference(
  provider: ModelProviderId,
  connectionId: string,
  upstreamModelId: string,
): string {
  if (!isProviderConnectionId(connectionId)) {
    throw new Error(
      "A model-provider connection id must be 12 lowercase letters.",
    );
  }
  if (!upstreamModelId) throw new Error("An upstream model id is required.");
  return `${provider}/${connectionId}/${upstreamModelId}`;
}

/** Parse a provider-qualified model reference, preserving every slash in the upstream model id. */
export function parseProviderModelReference(
  reference: string,
): ProviderModelReference | null {
  const providerSlash = reference.indexOf("/");
  if (providerSlash <= 0) return null;
  const provider = reference.slice(0, providerSlash);
  if (!isModelProviderId(provider)) return null;

  const connectionSlash = reference.indexOf("/", providerSlash + 1);
  if (connectionSlash <= providerSlash + 1) return null;
  const connectionId = reference.slice(providerSlash + 1, connectionSlash);
  const upstreamModelId = reference.slice(connectionSlash + 1);
  if (!isProviderConnectionId(connectionId) || !upstreamModelId) return null;
  return { provider, connectionId, upstreamModelId };
}

/**
 * Exact per-connection runtime variable used by generated provider wiring. Returning null for an
 * unknown provider, an OAuth provider, or a malformed id keeps untrusted reference text out of
 * environment-variable names.
 */
export function providerConnectionEnvName(
  provider: string,
  connectionId: string,
): string | null {
  if (
    !isApiKeyProviderId(provider) ||
    !CONNECTION_ID_PATTERN.test(connectionId)
  ) {
    return null;
  }
  return `HARNESST_PROVIDER_${provider.toUpperCase()}_${connectionId.toUpperCase()}_API_KEY`;
}

/** Explicit alias retained for call sites where the credential kind is useful context. */
export const providerConnectionApiKeyEnvName = providerConnectionEnvName;
