/**
 * Deploy-side connection injection (issues #30, #163, #167). Turns an agent's active OAuth grants
 * into the env the shipped eve connections need at runtime, per registered provider and per the
 * provider's `credentialDelivery`:
 *
 *  - "refresh-token" (default; google unchanged): the operator client creds plus the sealed
 *    refresh token (unsealed here) as `<PREFIX>_OAUTH_CLIENT_ID` / `<PREFIX>_OAUTH_CLIENT_SECRET`
 *    / `<PREFIX>_OAUTH_REFRESH_TOKEN` — no per-turn control-plane dependency: once these vars are
 *    in the container, eve's `getToken` exchanges the refresh token for access tokens on its own.
 *  - "access-token-broker" (issue #167): the refresh token NEVER ships — rotating-grant providers
 *    (mayi) revoke the whole token family if two writers race a rotation, so harnesst stays the
 *    single writer and the instance fetches short-lived access tokens from the control-plane
 *    broker (`POST <EDEN_API_URL>/api/connections/token`, see broker.server.ts). Deploy injects
 *    only `<PREFIX>_OAUTH_SCOPES` plus the provider's static `deployEnv` constants; the broker
 *    coordinates (EDEN_API_URL / EDEN_TEAM_TOKEN) are deployment-scoped and injected by the
 *    controller.
 *  - "capability" (issue #166): the instance gets NO `<PREFIX>_OAUTH_*` vars at all — suppressing
 *    injection is precisely the point: harnesst executes the provider's whitelisted operations itself
 *    (`POST <EDEN_API_URL>/api/capabilities/...`). Deploy still VALIDATES the grant (one
 *    rotation-safe liveness refresh, plus the capability's resource binding when it declares one)
 *    so a dead Xero connection fails the deploy with the existing readable reconnect message
 *    rather than failing at first call. The provider id joins the harnesst-owned
 *    `EDEN_CAPABILITY_PROVIDERS` marker (comma-joined), which tells the controller to inject the
 *    EDEN_API_URL / EDEN_TEAM_TOKEN coordinates the per-operation tools ride on.
 *
 * The first two deliveries also inject `<PREFIX>_OAUTH_SCOPES` — the grant's GRANTED scopes
 * (issue #165) so agent code can read its actual permission level. Capability providers don't:
 * the agent's permission surface is the operation-group enablement, checked per call in harnesst.
 *
 * Each grant is VALIDATED once at deploy by attempting a refresh: a dead grant (invalid_grant) is
 * marked "expired" and the deploy fails honestly with a reconnect message, rather than shipping a
 * container that can never authenticate. A transient refresh failure throws too (deploys should be
 * repeatable), but leaves the grant active. When the provider ROTATES refresh tokens (issue #167),
 * the rotated token from the validation refresh is persisted back onto the grant before anything
 * uses it — otherwise the deploy itself would burn the stored token and the provider's
 * family-reuse detection would kill the grant. The read→refresh→rotate section runs on the SAME
 * per-grant serialization chain as the token broker (refresh-serialization.server.ts): a deployed
 * instance requesting a broker token while a redeploy validates the same grant must queue behind
 * the validation (and vice versa), or both would consume one stored token and the reuse would
 * revoke the family.
 *
 * Per-grant OAuth clients (issue #167): a grant carrying a `clientId` (dynamic registration at
 * connect time) refreshes against ITS OWN client — no operator config involved; operator-level
 * grants keep using `getProviderOAuthConfig` exactly as before.
 *
 * When the caller supplies the installed connectors' required scopes (issue #69), it ALSO validates
 * scope COVERAGE per provider: an active grant whose granted scopes don't cover what the installs
 * require would 403 at runtime, so the deploy fails honestly with a "reconnect" message instead.
 * The grant stays active (it isn't dead — just under-scoped), so it is NOT marked expired.
 *
 * The persistence + config touchpoints are injectable (`ConnectionDeployDeps`) so the decision
 * logic is unit-testable with fakes; the default wiring hits Postgres + operator env.
 */
import { getCapability } from "~/capabilities/registry.server";
import type { SecretScope } from "~/seams/types";
import {
  getProviderOAuthConfig,
  type OAuthClientConfig,
} from "./config.server";
import {
  InvalidGrantError,
  missingScopes,
  refreshAccessToken as realRefreshAccessToken,
} from "./oauth.server";
import { getProvider, type ProviderDefinition } from "./providers.server";
import {
  grantRefreshKey,
  serializedRefresh,
} from "./refresh-serialization.server";
import {
  listGrantsForAgent as realListGrantsForAgent,
  markGrantStatus as realMarkGrantStatus,
  openRefreshToken as realOpenRefreshToken,
  rotateGrantRefreshToken as realRotateGrantRefreshToken,
  type GrantStatus,
} from "./grants.server";

export interface ConnectionDeployDeps {
  getConfig: (provider: ProviderDefinition) => OAuthClientConfig | null;
  /** Display-safe grant rows — enumeration only (which providers have a grant at all). */
  listGrantsForAgent: (
    agentId: string,
  ) => Promise<{ provider: string; status: GrantStatus }[]>;
  openRefreshToken: (input: {
    projectId: string;
    agentId: string;
    provider: string;
  }) => Promise<{
    grant: {
      id: string;
      status: GrantStatus;
      scopes: string;
      /** Per-grant OAuth client from dynamic registration (issue #167). */
      clientId?: string | null;
      /** Capability resource binding (issue #166) — validated present when required. */
      resourceId?: string | null;
    };
    refreshToken: string;
    /** Opaque fingerprint of THIS token, for compare-and-set status flips. */
    tokenVersion?: string;
  } | null>;
  markGrantStatus: (
    id: string,
    status: GrantStatus,
    expectedTokenVersion?: string,
  ) => Promise<void>;
  /** Persist a rotated refresh token (issue #167); false = a concurrent write won, drop ours. */
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

function defaultDeps(): ConnectionDeployDeps {
  return {
    getConfig: getProviderOAuthConfig,
    listGrantsForAgent: realListGrantsForAgent,
    openRefreshToken: realOpenRefreshToken,
    markGrantStatus: realMarkGrantStatus,
    rotateRefreshToken: realRotateGrantRefreshToken,
    refreshAccessToken: realRefreshAccessToken,
  };
}

/**
 * Resolve the connection env for a deploy scope across every provider the agent has a grant for
 * or the lock requires, or `{}` when nothing injects (no active grants, or the operator hasn't
 * configured the providers' shared clients). Validates each grant with a single refresh; throws a
 * readable Error if one is dead (after marking it expired) or under-scoped.
 */
export async function connectionGrantEnv(
  scope: SecretScope,
  fetchImpl: typeof fetch = fetch,
  deps: ConnectionDeployDeps = defaultDeps(),
  requiredScopes: ReadonlyMap<string, string[]> | null = null,
): Promise<Record<string, string>> {
  // Grants are per-agent; a scope without a concrete agent (shouldn't happen at deploy) has none.
  const agentId = scope.agentId;
  if (!agentId) return {};

  // Union of "has a grant row" and "the lock requires it" — a lock-required provider with a dead
  // or missing grant must still be considered (its coverage/liveness failures surface elsewhere),
  // and a granted provider the lock no longer names keeps injecting (grants are the authority).
  // The one exception is a provider whose requirement is present but EMPTY — see the skip below.
  const grants = await deps.listGrantsForAgent(agentId);
  const providerIds = [
    ...new Set([
      ...grants.map((g) => g.provider),
      ...(requiredScopes?.keys() ?? []),
    ]),
  ].sort();

  const env: Record<string, string> = {};
  for (const id of providerIds) {
    // Unregistered id (a stale grant row, or a lock requiring a provider this installation
    // doesn't know) → skip silently; the Connections card handles the messaging.
    const def = getProvider(id);
    if (!def) continue;
    // Present-but-EMPTY requirement (issue #173): every permission group for this provider was
    // explicitly deselected — distinguishable from the legacy no-auth-snapshot case (absent from
    // the map), which keeps the grant-authority fallback below. Injecting the stored grant here
    // would silently retain access the user just revoked in the Permissions UI, so the provider
    // is skipped entirely — no injection, and no liveness validation either (nothing ships that
    // could use the token). The grant row itself stays put: revocation is out of scope, and the
    // Connections card renders the retained-grant state honestly.
    const requiredForProvider = requiredScopes?.get(id);
    if (requiredForProvider !== undefined && requiredForProvider.length === 0) {
      continue;
    }
    // Registration providers (issue #167) carry their client on the GRANT, so a missing operator
    // config only skips providers whose refresh would need the shared client.
    const operatorConfig = deps.getConfig(def);
    if (!operatorConfig && !def.clientRegistration) {
      // A capability provider's grant is USELESS without the operator client — harnesst itself makes
      // every vendor call, so shipping the container anyway would leave each tool failing "not
      // configured" at runtime with no deploy-time signal. An ACTIVE grant therefore fails the
      // deploy honestly (the operator env was removed after the connection was made); refresh-
      // token providers keep the historical silent skip (self-hosters run their own client).
      const hasActiveGrant = grants.some(
        (g) => g.provider === id && g.status === "active",
      );
      if (def.credentialDelivery === "capability" && hasActiveGrant) {
        throw new Error(
          `The ${def.label} connection for this agent can't be used: this harnesst installation has ` +
            `no ${def.label} OAuth client configured. Set EDEN_${def.envPrefix}_CLIENT_ID and ` +
            `EDEN_${def.envPrefix}_CLIENT_SECRET on the control plane, then redeploy.`,
        );
      }
      continue;
    }

    // The read→refresh→rotate section shares the token broker's per-grant serialization chain
    // (see module doc): the grant row is read INSIDE the chain, so a queued task consumes its
    // predecessor's rotated token, never the same stored one. Throws propagate to the deploy
    // (a failed task never poisons the chain).
    const validated = await serializedRefresh(
      grantRefreshKey({ projectId: scope.projectId, agentId, provider: def.id }),
      async () => {
        const found = await deps.openRefreshToken({
          projectId: scope.projectId,
          agentId,
          provider: def.id,
        });
        if (!found || found.grant.status !== "active") return null;

        // The grant's own registered client wins (issue #167 — exchange and refresh must use the
        // client the consent was minted for); null falls back to the operator-level shared client.
        const config: OAuthClientConfig | null = found.grant.clientId
          ? { clientId: found.grant.clientId }
          : operatorConfig;
        if (!config) return null;

        let refreshed: { accessToken: string; expiresIn: number; refreshToken?: string };
        try {
          refreshed = await deps.refreshAccessToken(
            { provider: def, config, refreshToken: found.refreshToken },
            fetchImpl,
          );
        } catch (error) {
          if (error instanceof InvalidGrantError) {
            // Compare-and-set against the token that was actually tested: a reconnect racing this
            // deploy may already have rotated the row to a fresh valid token, which must stay
            // active.
            await deps.markGrantStatus(found.grant.id, "expired", found.tokenVersion);
            throw new Error(
              `The ${def.label} connection for this agent has expired — reconnect it from the agent's ` +
                "install page or Deployment tab, then redeploy.",
            );
          }
          throw error;
        }

        // Rotating grants (issue #167): the validation refresh consumed the stored token — persist
        // the rotated replacement BEFORE injecting anything, or the next refresh (deploy or broker)
        // would replay a used token and trip the provider's family-reuse revocation. A failed
        // compare-and-set means a concurrent reconnect replaced the grant while we deployed: our
        // rotation belongs to the dead family, so fail the deploy honestly (deploys are repeatable
        // and the retry picks up the fresh grant).
        let liveRefreshToken = found.refreshToken;
        if (refreshed.refreshToken && refreshed.refreshToken !== found.refreshToken) {
          const persisted = await deps.rotateRefreshToken(
            found.grant.id,
            refreshed.refreshToken,
            found.tokenVersion,
          );
          if (!persisted) {
            throw new Error(
              `The ${def.label} connection for this agent was reconnected while this deploy was ` +
                "validating it — redeploy to use the new connection.",
            );
          }
          liveRefreshToken = refreshed.refreshToken;
        }

        return {
          config,
          grantScopes: found.grant.scopes,
          liveRefreshToken,
          resourceId: found.grant.resourceId ?? null,
        };
      },
    );
    if (!validated) continue;
    const { config, grantScopes, liveRefreshToken, resourceId } = validated;

    // Scope-coverage validation (issue #69): the grant is alive, but if its granted scopes don't
    // cover what the installed connectors require, the container would 403 at runtime. Fail the
    // deploy honestly. The grant is active (not dead), so it is NOT marked expired here.
    const required = requiredScopes?.get(def.id)?.join(" ");
    if (required) {
      const missing = missingScopes(required, grantScopes);
      if (missing.length > 0) {
        throw new Error(
          `The ${def.label} connection for this agent is missing required permission(s): ${missing.join(", ")}. ` +
            "Reconnect it from the agent's Deployment tab (leave all requested permissions checked), then redeploy.",
        );
      }
    }

    if (def.credentialDelivery === "capability") {
      // Capability delivery (issue #166): the container never sees ANY credential material — no
      // `<PREFIX>_OAUTH_*` vars, not even scopes. The grant was still liveness-validated above
      // (rotation persisted); one more requirement is the provider-side resource binding, without
      // which every call would fail — fail the deploy honestly instead.
      const capability = getCapability(def.id);
      if (capability?.resource && !resourceId) {
        throw new Error(
          `The ${def.label} connection for this agent isn't bound to ${aOrAn(capability.resource.label)} ` +
            `${capability.resource.label} yet — finish connecting it from the agent's Deployment tab ` +
            "(pick one on the connect flow's picker page), then redeploy.",
        );
      }
      for (const [key, value] of Object.entries(def.deployEnv ?? {})) {
        env[key] = value;
      }
      // harnesst-owned marker: which capability providers this deploy brokered. The controller reads
      // it to inject the EDEN_API_URL / EDEN_TEAM_TOKEN coordinates; agent code can read it to
      // know which capability tool families are live.
      env.EDEN_CAPABILITY_PROVIDERS = [
        ...(env.EDEN_CAPABILITY_PROVIDERS?.split(",").filter(Boolean) ?? []),
        def.id,
      ].join(",");
      continue;
    }
    if (def.credentialDelivery === "access-token-broker") {
      // Brokered delivery (issue #167): the refresh token (and any client credential) stays on
      // the control plane. Static provider constants (`deployEnv`) ride along; the broker
      // coordinates are deployment-scoped and injected by the controller.
      for (const [key, value] of Object.entries(def.deployEnv ?? {})) {
        env[key] = value;
      }
    } else {
      env[`${def.envPrefix}_OAUTH_CLIENT_ID`] = config.clientId;
      if (config.clientSecret !== undefined) {
        env[`${def.envPrefix}_OAUTH_CLIENT_SECRET`] = config.clientSecret;
      }
      env[`${def.envPrefix}_OAUTH_REFRESH_TOKEN`] = liveRefreshToken;
    }
    // Agent-side permission visibility (issue #165): the scopes the provider actually GRANTED,
    // space-joined exactly as stored on the grant row, so agent code can tell which permission
    // level it holds (e.g. don't offer to send mail when only read was granted).
    env[`${def.envPrefix}_OAUTH_SCOPES`] = grantScopes;
  }

  return env;
}

/** "a"/"an" for a resource label in the unbound-binding deploy error. */
function aOrAn(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}
