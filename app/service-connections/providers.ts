/**
 * Workspace service connections: operator credentials for services harnesst itself calls on a
 * team's behalf (today a Supabase access token for installing and upgrading the ledger). They are
 * not agent connections: the credential is used server-side only and never reaches an agent.
 *
 * This module is the client-safe half (display metadata). Verification lives in
 * providers.server.ts.
 */
export type ServiceConnectionStatus = "active" | "expired" | "invalid";

export interface ServiceProviderInfo {
  id: string;
  displayName: string;
  /** What the credential is called in forms. */
  credentialLabel: string;
  /** Where the user creates the credential. */
  tokenUrl: string;
  placeholder: string;
  /** One line on what harnesst uses it for. */
  description: string;
}

export const SERVICE_PROVIDERS = {
  supabase: {
    id: "supabase",
    displayName: "Supabase",
    credentialLabel: "Supabase access token",
    tokenUrl: "https://supabase.com/dashboard/account/tokens",
    placeholder: "sbp_…",
    description:
      "Installs and upgrades team databases such as the ledger. Used by harnesst only, never given to agents.",
  },
} as const satisfies Record<string, ServiceProviderInfo>;

export type ServiceProviderId = keyof typeof SERVICE_PROVIDERS;

export function isServiceProviderId(value: string): value is ServiceProviderId {
  return Object.hasOwn(SERVICE_PROVIDERS, value);
}

/** Display-safe connection: everything but the sealed credential. Safe for loaders. */
export interface ServiceConnection {
  id: string;
  provider: ServiceProviderId;
  label: string;
  status: ServiceConnectionStatus;
  lastVerifiedAt: Date | null;
  /** Provider facts gathered at verification (e.g. account names). Never secret. */
  metadata: Record<string, unknown>;
  createdAt: Date;
}
