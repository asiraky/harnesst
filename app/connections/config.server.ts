/**
 * Operator config for harnesst's shared OAuth clients (issues #30, #163). A self-host installation
 * registers ONE OAuth 2.0 client per provider and sets its two credentials as control-plane env
 * (`EDEN_<PREFIX>_CLIENT_ID` / `EDEN_<PREFIX>_CLIENT_SECRET`, prefix from the provider registry).
 * The connect flow exchanges codes with it, and deploy injects the client creds (alongside the
 * sealed refresh token) so the shipped connection self-refreshes tokens. The client secret NEVER
 * leaves the control plane except as an injected env var on the agent's own instance (which needs
 * it for the refresh grant).
 *
 * Null unless both are present — a partial config can't drive any OAuth operation, and treating
 * it as "unconfigured" keeps the connector's Connect button honestly disabled. Mirrors
 * app/discord/config.server.ts.
 */
import type { ProviderDefinition } from "./providers.server";
import { getProvider } from "./providers.server";

export interface OAuthClientConfig {
  clientId: string;
  /** Absent for PUBLIC clients (`tokenEndpointAuth: "none"`, issue #167) — no secret exists. */
  clientSecret?: string;
}

/**
 * A provider's shared-client config, or null when the operator hasn't set the required env vars.
 * A PUBLIC client (`tokenEndpointAuth: "none"`, issue #167) has no secret to set, so only
 * `EDEN_<PREFIX>_CLIENT_ID` is required; confidential providers need both, as before.
 */
export function getProviderOAuthConfig(
  provider: ProviderDefinition,
): OAuthClientConfig | null {
  const clientId = process.env[`EDEN_${provider.envPrefix}_CLIENT_ID`]?.trim();
  if (!clientId) return null;
  if (provider.tokenEndpointAuth === "none") return { clientId };
  const clientSecret =
    process.env[`EDEN_${provider.envPrefix}_CLIENT_SECRET`]?.trim();
  if (!clientSecret) return null;
  return { clientId, clientSecret };
}

/** @deprecated Google-era name for OAuthClientConfig; existing callers keep compiling. */
export type GoogleOAuthConfig = OAuthClientConfig;

/** The shared Google client's config (EDEN_GOOGLE_*), or null when unconfigured. */
export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  return getProviderOAuthConfig(getProvider("google")!);
}
