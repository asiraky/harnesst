/**
 * Server half of the service-provider registry: how each provider's credential is verified and
 * which upstream failures mean the credential itself is no longer usable. Adding a provider is
 * an entry here plus its display entry in providers.ts.
 */
import {
  SupabaseManagement,
  SupabaseRequestError,
} from "~/marketplace/supabase-provisioning.server";
import type { ServiceConnectionStatus, ServiceProviderId } from "./providers";

/** The provider rejected the credential (or it was malformed). Safe to show. */
export class ServiceCredentialError extends Error {}

export interface VerifiedCredential {
  metadata: Record<string, unknown>;
}

export interface ServiceProvider {
  /** Proves the credential works. Throws ServiceCredentialError when the provider rejects it. */
  verify(
    credential: string,
    request?: typeof fetch,
  ): Promise<VerifiedCredential>;
  /** The status an upstream failure implies for the credential, or null when it says nothing. */
  unusableStatus(
    error: unknown,
  ): Exclude<ServiceConnectionStatus, "active"> | null;
}

const supabase: ServiceProvider = {
  async verify(credential, request = fetch) {
    const token = credential.trim();
    if (!token)
      throw new ServiceCredentialError("Enter a Supabase access token.");
    const api = new SupabaseManagement(token, request);
    let projects: unknown;
    try {
      projects = await api.call("projects");
    } catch (error) {
      if (
        error instanceof SupabaseRequestError &&
        [401, 403].includes(error.status)
      )
        throw new ServiceCredentialError(
          "Supabase rejected this access token. Create a new one and try again.",
        );
      throw error;
    }
    if (!Array.isArray(projects))
      throw new Error("Supabase returned an invalid project list.");
    // Organization names only label the connection; a failure here must not reject a good token.
    const organizations = await api
      .call("organizations")
      .then((orgs: unknown) =>
        Array.isArray(orgs)
          ? orgs
              .map((o) => String((o as { name?: unknown }).name ?? ""))
              .filter(Boolean)
          : [],
      )
      .catch(() => [] as string[]);
    return { metadata: { organizations, projectCount: projects.length } };
  },
  unusableStatus(error) {
    // Only a 401 condemns the token: 403 is a per-project permission, 5xx is Supabase's problem.
    return error instanceof SupabaseRequestError && error.status === 401
      ? "invalid"
      : null;
  },
};

const PROVIDERS: Record<ServiceProviderId, ServiceProvider> = { supabase };

export function serviceProvider(id: ServiceProviderId): ServiceProvider {
  return PROVIDERS[id];
}

export function verifyServiceCredential(
  provider: ServiceProviderId,
  credential: string,
): Promise<VerifiedCredential> {
  return serviceProvider(provider).verify(credential);
}
