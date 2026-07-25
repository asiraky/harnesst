/**
 * Connector provider registry (issues #30, #163) — everything harnesst needs to broker OAuth against
 * a provider, keyed by provider id. Registering a new provider is a data addition here plus the
 * operator's `EDEN_<PREFIX>_CLIENT_ID`/`_CLIENT_SECRET` env vars — no new routes, flows, or schema.
 * Unknown provider → null.
 */
export interface ProviderDefinition {
  /** Registry key and the `auth.provider` string connection templates use. */
  id: string;
  /** Display name for the Connections card and connect/consent UI. */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** OIDC-ish userinfo endpoint, best-effort display of the connected account. */
  userinfoUrl?: string;
  /** Send PKCE (S256 code_challenge on authorize, code_verifier on exchange). */
  pkce?: boolean;
  /** Extra static authorize params, appended in insertion order after response_type/scope. */
  authorizeParams?: Record<string, string>;
  /** Identity scopes appended so the callback can name the account. */
  identityScopes?: string[];
  /** Env prefix: operator `EDEN_<PREFIX>_CLIENT_ID/SECRET`, injected `<PREFIX>_OAUTH_*`. */
  envPrefix: string;
  /**
   * Redirect path this provider's OAuth app has registered. Defaults to
   * `/connections/<id>/callback`. Google overrides with "/google/callback" (back-compat:
   * operators' Google apps registered that URI; no operator action required).
   */
  redirectPath?: string;
  /** Extra remediation appended to the "no refresh token" exchange error (Google's myaccount hint). */
  noRefreshTokenHint?: string;
  /**
   * How the token endpoint authenticates harnesst's client (issue #167). `"client_secret_post"`
   * (default) posts the operator secret; `"none"` is a PUBLIC client (RFC 8414
   * `token_endpoint_auth_methods_supported: ["none"]`) — no secret exists, PKCE is the
   * code-exchange proof, and only `EDEN_<PREFIX>_CLIENT_ID` is required operator config.
   */
  tokenEndpointAuth?: "client_secret_post" | "none";
  /**
   * How a validated grant reaches the agent's instance (issue #167; shared axis with #166).
   * `"refresh-token"` (default) ships the `<PREFIX>_OAUTH_*` trio so the instance self-refreshes.
   * `"access-token-broker"` never ships the refresh token — providers that ROTATE it per refresh
   * (and revoke the whole family on reuse) can only have ONE writer, so harnesst refreshes centrally
   * and the instance fetches short-lived access tokens from `POST <EDEN_API_URL>/api/connections/token`
   * (authenticated by its `EDEN_TEAM_TOKEN` delegation token).
   * `"capability"` (issue #166) ships NOTHING — the instance never sees any credential material.
   * harnesst holds the grant and executes only the provider's whitelisted operations itself
   * (`POST <EDEN_API_URL>/api/capabilities/:provider/:operation`, same delegation-token auth);
   * the provider must have a capability definition registered in `app/capabilities/`.
   */
  credentialDelivery?: "refresh-token" | "access-token-broker" | "capability";
  /**
   * RFC 7591-shaped dynamic client registration (issue #167). When present, the connect flow
   * registers ONE OAuth client PER GRANT at Connect time (no `EDEN_<PREFIX>_CLIENT_ID` operator
   * step) — required when the provider's clients are immutable with exact-match callback URIs,
   * so a single shared client can't cover per-environment callback URLs. `approvalCallbackPath`
   * is the instance-side route the provider calls back (registered as
   * `<EDEN_PUBLIC_ORIGIN>/e/<envId><approvalCallbackPath>` for every environment the agent has).
   */
  clientRegistration?: { endpoint: string; approvalCallbackPath?: string };
  /**
   * Static env constants injected alongside this provider's grant env at deploy (issue #167),
   * anti-shadowed like the `<PREFIX>_OAUTH_*` names. For mayi this carries the callback-state
   * key id that pairs with the `generated` MAYI_CALLBACK_STATE_KEY secret.
   */
  deployEnv?: Record<string, string>;
}

const PROVIDERS: Record<string, ProviderDefinition> = {
  google: {
    id: "google",
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    // access_type=offline + prompt=consent guarantee a refresh token even on re-consent (Google
    // only returns one when explicitly asked). Deliberately NO include_granted_scopes: harnesst
    // always requests the full effective required set (never a delta), so incremental auth buys
    // nothing — and with it set, Google folds previously granted scopes back into every new
    // token, which would make narrowing a scope-group selection + reconnect (issue #165) unable
    // to ever re-issue a narrower grant.
    authorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    identityScopes: ["openid", "email"],
    envPrefix: "GOOGLE",
    redirectPath: "/google/callback",
    noRefreshTokenHint:
      "Remove harnesst's access at myaccount.google.com/permissions and connect again so Google re-issues one.",
  },
  // May I? (issue #167) — human-approval channel. Verified against asiraky/mayi: PUBLIC client
  // (token_endpoint_auth_methods_supported: ["none"], PKCE S256 required), refresh tokens ROTATE
  // per use with family-reuse revocation (so the instance never holds one — access-token broker),
  // clients are register-once/immutable with exact-match approval callback URIs (so one client is
  // registered PER GRANT, covering every environment's callback URL at Connect time). No userinfo
  // endpoint — the card shows "Connected" without an account email. Hosted OAuth origin is
  // app.mayi.sh (mayi.sh is the marketing site — its /api/oauth/* 404/405; the authoritative
  // endpoints come from https://app.mayi.sh/.well-known/oauth-authorization-server). Self-hosted
  // mayi origins are deferred until a consumer exists (issue #167 open question).
  mayi: {
    id: "mayi",
    label: "May I?",
    authorizeUrl: "https://app.mayi.sh/api/oauth/authorize",
    tokenUrl: "https://app.mayi.sh/api/oauth/token",
    pkce: true,
    envPrefix: "MAYI",
    tokenEndpointAuth: "none",
    credentialDelivery: "access-token-broker",
    clientRegistration: {
      endpoint: "https://app.mayi.sh/api/oauth/register",
      // The @mayiapp/eve adapter registers exactly this route on the instance and builds its
      // callback URL as <EVE_PUBLIC_ORIGIN>/eve/v1/mayi/approval-resolved.
      approvalCallbackPath: "/eve/v1/mayi/approval-resolved",
    },
    // The adapter's callback-state key id — a purely local rotation identifier paired with the
    // generated MAYI_CALLBACK_STATE_KEY (mayi's channel.ts: currentKey { kid, key }); a fixed
    // first id is correct, and a future rotation moves "k1" into MAYI_CALLBACK_STATE_PREVIOUS_KEYS.
    deployEnv: { MAYI_CALLBACK_STATE_KEY_ID: "k1" },
  },
  // Xero (issue #166) — the first CAPABILITY provider: money-adjacent, so the OAuth grant never
  // leaves the control plane and the instance can only reach the whitelisted operations in
  // app/capabilities/xero.server.ts. Xero ROTATES refresh tokens (single-use, family revocation
  // on reuse, 60-day expiry), so every harnesst-side refresh rides #167's rotation-safe serialized
  // path. The scope set requested at consent is a fixed superset (see the catalog template) —
  // the operation whitelist, not the token scope, is the enforcement plane. Operator env:
  // EDEN_XERO_CLIENT_ID / EDEN_XERO_CLIENT_SECRET (a harnesst-owned app at developer.xero.com with
  // redirect `<origin>/connections/xero/callback`).
  xero: {
    id: "xero",
    label: "Xero",
    authorizeUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    pkce: true,
    envPrefix: "XERO",
    credentialDelivery: "capability",
  },
};

/** The provider definition for an id, or null when it isn't a known connector. */
export function getProvider(id: string): ProviderDefinition | null {
  return PROVIDERS[id] ?? null;
}

/** Every registered provider (deploy iterates these for per-provider grant injection). */
export function listProviders(): ProviderDefinition[] {
  return Object.values(PROVIDERS);
}

/** The redirect path the provider's OAuth app expects harnesst to use. */
export function providerRedirectPath(provider: ProviderDefinition): string {
  return provider.redirectPath ?? `/connections/${provider.id}/callback`;
}
