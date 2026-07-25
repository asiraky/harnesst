/**
 * Instance token broker (issue #167) — the control-plane half of the "access-token-broker"
 * credential delivery. Providers with ROTATING refresh grants (mayi: a refresh mints a new
 * refresh token, and reusing an old one revokes the whole token family) can't ship
 * `<PREFIX>_OAUTH_REFRESH_TOKEN` to instances: harnesst and the instance would race the rotation
 * and kill the grant. Instead harnesst stays the SINGLE WRITER — the instance POSTs
 * `/api/connections/token` (see routes/api.connections.token.ts) and gets back a fresh
 * short-lived access token; every refresh happens here, and the rotated refresh token is
 * persisted before the access token is released.
 *
 * Concurrency: refreshes are serialized PER GRANT via the shared in-process promise chain in
 * refresh-serialization.server.ts — deploy-time validation (deploy.server.ts) runs on the SAME
 * chain, so two concurrent broker calls, or a broker call racing a deploy validation, can't both
 * consume the same stored token. Cross-process races are caught by the compare-and-set in
 * `rotateGrantRefreshToken` and surface as a retryable error.
 *
 * eve-side traffic is cheap: the shipped credentials binding caches the token until close to
 * `expiresAt`, so this is ~one call per access-token lifetime (an hour for mayi) per instance,
 * not per request.
 *
 * Deps are injectable so the decision logic unit-tests with fakes; default wiring hits
 * Postgres + operator env (same seams as deploy.server.ts).
 */
import {
  deleteCachedCapabilityToken,
  getCachedCapabilityToken,
  setCachedCapabilityToken,
} from "./capability-token-cache.server";
import {
  getProviderOAuthConfig,
  type OAuthClientConfig,
} from "./config.server";
import {
  InvalidGrantError,
  refreshAccessToken as realRefreshAccessToken,
} from "./oauth.server";
import { getProvider, type ProviderDefinition } from "./providers.server";
import {
  grantRefreshKey,
  serializedRefresh,
} from "./refresh-serialization.server";
import {
  markGrantStatus as realMarkGrantStatus,
  openRefreshToken as realOpenRefreshToken,
  rotateGrantRefreshToken as realRotateGrantRefreshToken,
  type GrantStatus,
} from "./grants.server";

export interface BrokerDeps {
  getConfig: (provider: ProviderDefinition) => OAuthClientConfig | null;
  openRefreshToken: (input: {
    projectId: string;
    agentId: string;
    provider: string;
  }) => Promise<{
    grant: {
      id: string;
      status: GrantStatus;
      scopes: string;
      clientId?: string | null;
    };
    refreshToken: string;
    tokenVersion?: string;
  } | null>;
  markGrantStatus: (
    id: string,
    status: GrantStatus,
    expectedTokenVersion?: string,
  ) => Promise<void>;
  rotateRefreshToken: (
    id: string,
    refreshToken: string,
    expectedTokenVersion?: string,
  ) => Promise<boolean>;
  refreshAccessToken: (
    input: {
      provider: ProviderDefinition;
      config: OAuthClientConfig;
      refreshToken: string;
    },
    fetchImpl: typeof fetch,
  ) => Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }>;
}

function defaultDeps(): BrokerDeps {
  return {
    getConfig: getProviderOAuthConfig,
    openRefreshToken: realOpenRefreshToken,
    markGrantStatus: realMarkGrantStatus,
    rotateRefreshToken: realRotateGrantRefreshToken,
    refreshAccessToken: realRefreshAccessToken,
  };
}

export type BrokerResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; error: string; status: number };

/**
 * The refresh core shared by the instance token broker and the capability framework (issues
 * #167/#166): open the grant, refresh against its own client (else the operator's), persist any
 * rotation BEFORE releasing the access token, and map failures to readable results. Runs INSIDE
 * a per-grant serialization chain — callers wrap it in `serializedRefresh` so a queued task
 * always consumes its predecessor's rotated token.
 */
async function refreshGrantAccessToken(
  def: ProviderDefinition,
  input: { projectId: string; agentId: string },
  fetchImpl: typeof fetch,
  deps: BrokerDeps,
): Promise<BrokerResult> {
  const found = await deps.openRefreshToken({
    projectId: input.projectId,
    agentId: input.agentId,
    provider: def.id,
  });
  if (!found || found.grant.status !== "active") {
    return {
      ok: false,
      status: 403,
      error:
        `This agent has no active ${def.label} connection — connect it from the agent's ` +
        "Deployment tab, then redeploy.",
    };
  }
  const config: OAuthClientConfig | null = found.grant.clientId
    ? { clientId: found.grant.clientId }
    : deps.getConfig(def);
  if (!config) {
    return {
      ok: false,
      status: 503,
      error: `This harnesst installation has no ${def.label} OAuth client configured for this grant.`,
    };
  }

  let refreshed: {
    accessToken: string;
    expiresIn: number;
    refreshToken?: string;
  };
  try {
    refreshed = await deps.refreshAccessToken(
      { provider: def, config, refreshToken: found.refreshToken },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof InvalidGrantError) {
      // Same compare-and-set discipline as deploy validation: never expire a row a
      // concurrent reconnect already rotated to a fresh valid token.
      await deps.markGrantStatus(
        found.grant.id,
        "expired",
        found.tokenVersion,
      );
      return {
        ok: false,
        status: 403,
        error:
          `The ${def.label} connection for this agent has expired — reconnect it from the ` +
          "agent's Deployment tab, then redeploy.",
      };
    }
    return {
      ok: false,
      status: 502,
      error: `Couldn't refresh the ${def.label} token: ${(error as Error).message}`,
    };
  }

  // Persist the rotation BEFORE releasing the access token — the stored token was just
  // consumed, and a replay would trip the provider's family-reuse revocation. A failed
  // compare-and-set means a concurrent (cross-process) write replaced the grant: drop this
  // result and let the caller retry against the fresh grant.
  if (
    refreshed.refreshToken &&
    refreshed.refreshToken !== found.refreshToken
  ) {
    const persisted = await deps.rotateRefreshToken(
      found.grant.id,
      refreshed.refreshToken,
      found.tokenVersion,
    );
    if (!persisted) {
      return {
        ok: false,
        status: 503,
        error: `The ${def.label} connection changed while refreshing — retry.`,
      };
    }
  }

  return {
    ok: true,
    accessToken: refreshed.accessToken,
    expiresAt: Date.now() + refreshed.expiresIn * 1000,
  };
}

/**
 * A fresh access token for (project, agent, provider), refreshed centrally with the rotation
 * persisted (issue #167). Business failures come back as `{ ok: false }` with an HTTP-ish status
 * hint so the resource route can surface a readable message to the instance's credentials
 * binding.
 */
export async function brokerAccessToken(
  input: { projectId: string; agentId: string; provider: string },
  fetchImpl: typeof fetch = fetch,
  deps: BrokerDeps = defaultDeps(),
): Promise<BrokerResult> {
  const def = getProvider(input.provider);
  if (!def) {
    return {
      ok: false,
      status: 404,
      error: `"${input.provider}" is not a connection provider this harnesst installation supports.`,
    };
  }
  // Only brokered-delivery providers are served: refresh-token providers ship their grant to the
  // instance and self-refresh — brokering them too would put two writers on one grant. (And a
  // "capability" provider's tokens NEVER leave the control plane, not even short-lived ones.)
  if (def.credentialDelivery !== "access-token-broker") {
    return {
      ok: false,
      status: 404,
      error: `${def.label} connections are delivered to the instance directly — the token broker only serves access-token-broker providers.`,
    };
  }

  return serializedRefresh(
    grantRefreshKey({
      projectId: input.projectId,
      agentId: input.agentId,
      provider: def.id,
    }),
    () => refreshGrantAccessToken(def, input, fetchImpl, deps),
  );
}

/* ─────────────────── capability access tokens (issue #166) ─────────────────── */

/**
 * The cache itself lives in capability-token-cache.server.ts so grant writers (grants.server.ts's
 * `upsertGrant`) can invalidate a scope's entry on reconnect without importing the broker —
 * refreshing per capability call would burn a rotation per call and race concurrent calls, so the
 * token from one refresh is reused until shortly before `expiresAt`, but never across a grant
 * replacement.
 */
export { clearCapabilityTokenCache } from "./capability-token-cache.server";

/** Refresh this long before `expiresAt` so a token is never used at the edge of its life. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * A CURRENT access token for a capability provider's grant (issue #166): the cached one while it
 * lives, else one rotation-safe refresh on the same per-grant serialization chain the deploy
 * validation and instance broker use. Two concurrent capability calls share ONE refresh — the
 * queued task finds the leader's token in the cache instead of consuming another rotation.
 * Refuses non-capability providers: their tokens are delivered to instances, not spent here.
 */
export async function capabilityAccessToken(
  input: { projectId: string; agentId: string; provider: string },
  fetchImpl: typeof fetch = fetch,
  deps: BrokerDeps = defaultDeps(),
  now: () => number = Date.now,
): Promise<BrokerResult> {
  const def = getProvider(input.provider);
  if (!def) {
    return {
      ok: false,
      status: 404,
      error: `"${input.provider}" is not a connection provider this harnesst installation supports.`,
    };
  }
  if (def.credentialDelivery !== "capability") {
    return {
      ok: false,
      status: 404,
      error: `${def.label} is not a capability provider — its credentials are delivered to the instance.`,
    };
  }

  const key = grantRefreshKey({
    projectId: input.projectId,
    agentId: input.agentId,
    provider: def.id,
  });
  const fresh = (cached?: { accessToken: string; expiresAt: number }) =>
    cached !== undefined && now() < cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS;

  // Fast path outside the chain; re-checked INSIDE it so a queued concurrent call picks up the
  // leader's freshly cached token instead of spending a second rotation.
  const cached = getCachedCapabilityToken(key);
  if (fresh(cached)) {
    return { ok: true, accessToken: cached!.accessToken, expiresAt: cached!.expiresAt };
  }

  return serializedRefresh(key, async (): Promise<BrokerResult> => {
    const inChain = getCachedCapabilityToken(key);
    if (fresh(inChain)) {
      return { ok: true, accessToken: inChain!.accessToken, expiresAt: inChain!.expiresAt };
    }
    const result = await refreshGrantAccessToken(def, input, fetchImpl, deps);
    if (result.ok) {
      setCachedCapabilityToken(key, {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
      });
    } else {
      // A dead/replaced grant invalidates whatever was cached for it.
      deleteCachedCapabilityToken(key);
    }
    return result;
  });
}
