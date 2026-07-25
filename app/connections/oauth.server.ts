/**
 * Provider-generic OAuth broker (issues #30, #163) — the pure URL/state shapes plus the
 * code→token network calls, parameterized by a ProviderDefinition from the registry.
 *
 * harnesst owns ONE OAuth client per (installation, provider), operator-registered as
 * HARNESST_<PREFIX>_*. The connect flow sends the user through the provider's consent screen for
 * that client; the provider redirects back to the registered callback with a `code`, which this
 * module exchanges server-side for a refresh token (the durable grant harnesst seals in
 * `connection_grants`). Unlike Discord — where the connect proof is a bot-token side effect and
 * no code is ever exchanged — these providers REQUIRE a real code→token exchange with the client
 * id + secret. Providers that declare `pkce` additionally get an S256 code_challenge on the
 * authorize URL and the code_verifier on the exchange (RFC 7636); the verifier rides inside the
 * HMAC-signed state, which only ever round-trips through the user's redirect — the same trust
 * model as the nonce.
 *
 * Everything shape-like is exported pure so tests assert the literals; the network helpers take
 * an injected `fetchImpl` (default `fetch`). The signed state uses the shared signed-state helper
 * keyed by the same tenant-wide secrets key that seals secrets (no new key to provision).
 */
import { createHash, randomBytes } from "node:crypto";

import { decodeKey } from "~/seams/oss/secretbox";
import {
  safeReturnTo,
  signState,
  verifyState,
} from "~/lib/signed-state.server";
import type { OAuthClientConfig } from "./config.server";
import { getProvider, type ProviderDefinition } from "./providers.server";

export const CONNECT_STATE_TTL_MS = 60 * 60 * 1000;

/**
 * Requested connector scopes that the provider did NOT grant (issue #30). Google's consent screen
 * lets a user UNCHECK individual scopes (granular consent), so `granted` can be a strict subset of
 * what we asked for — an under-scoped grant that 403s at runtime. Both inputs are space-separated.
 * Only the CONNECTOR scopes are compared: identity scopes (openid/email) are appended separately
 * and providers normalize their short names, so callers pass just `state.scopes` here. Lenient
 * when `granted` is empty/absent — a missing field must not hard-fail the connect.
 */
export function missingScopes(requested: string, granted: string): string[] {
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
  if (grantedSet.size === 0) return [];
  const requestedList = requested.split(/\s+/).filter(Boolean);
  return requestedList.filter((s) => !grantedSet.has(s));
}

/**
 * The states a Deployment-tab Connections row can be in (issue #30). The card is now the ONE
 * place a connector's OAuth account is connected/reconnected — installs no longer gate on it — so a
 * row exists for every provider the lock REQUIRES, even before any grant.
 *  - "not-connected": no grant yet → primary Connect button (requests the lock-required scopes).
 *  - "connected": active grant that covers the required scopes → subtle Reconnect link.
 *  - "under-scoped": active grant missing required scopes (would 403 at runtime) → primary Reconnect.
 *  - "needs-reconnect": active, covered grant whose per-grant OAuth client no longer covers every
 *    environment (issue #167 — a provider with immutable exact-match callback URIs can't have an
 *    environment added after Connect; Reconnect registers a fresh client) → primary Reconnect.
 *  - "inactive": grant expired/revoked → status badge + Reconnect.
 *  - "disabled": every permission group explicitly deselected (issue #173) — deploys skip this
 *    provider's injection and connect/reconnect refuses (nothing to authorize), but a stored
 *    grant is NOT revoked. The row must say so honestly instead of rendering "connected".
 */
export type ConnectionRowState =
  | "not-connected"
  | "connected"
  | "under-scoped"
  | "needs-reconnect"
  | "inactive"
  | "disabled";

/**
 * Derive a Connections-card row's state from its lock-required scopes and current grant (issue #30).
 * Pure so the route computes it in the loader and ships a plain string to the client — deployments.tsx
 * is a route with client code, so the server-only scope comparison stays out of the render path. A
 * null/absent `requiredScopes` (old locks with no snapshot) is treated as covered.
 *
 * `staleClientCoverage` (issue #167): the loader sets it for a provider with per-grant client
 * registration when an environment was created AFTER the grant — the grant's immutable OAuth
 * client can't know the new environment's callback URL, so a reconnect (fresh registration) is
 * needed. Under-scoped wins when both apply (one reconnect fixes both, and the permission gap is
 * the more actionable message).
 *
 * `permissionsDisabled` (issue #173): the loader sets it when the lock's required scope set for
 * this provider is present but EMPTY — every permission group deliberately deselected. It wins
 * over every other state (grant or not): deploys skip injection and connect/reconnect refuses,
 * so any other rendering ("connected", a Connect button) would misstate what's live.
 */
export function connectionRowState(input: {
  hasGrant: boolean;
  grantStatus: string | null;
  requiredScopes: string | null;
  grantScopes: string;
  staleClientCoverage?: boolean;
  permissionsDisabled?: boolean;
}): ConnectionRowState {
  if (input.permissionsDisabled) return "disabled";
  if (!input.hasGrant) return "not-connected";
  if (input.grantStatus !== "active") return "inactive";
  const covered =
    !input.requiredScopes ||
    missingScopes(input.requiredScopes, input.grantScopes).length === 0;
  if (!covered) return "under-scoped";
  return input.staleClientCoverage ? "needs-reconnect" : "connected";
}

/* ─────────────────────────── state token (pure given key) ─────────────────────────── */

export interface ConnectState {
  projectId: string;
  agentId: string;
  /** Better Auth user and session that initiated this OAuth round-trip. */
  userId: string;
  sessionId: string;
  /** Random server-recorded nonce consumed atomically by the callback. */
  nonce: string;
  /** Registry provider id — validated against the registry on verify. */
  provider: string;
  /** Space-separated scopes requested (as the connector declared them). */
  scopes: string;
  /** Same-origin relative path to return to after the round-trip. */
  returnTo: string;
  /** Unix ms after which the token is dead. */
  exp: number;
  /** PKCE code_verifier, carried inside the HMAC-signed state (same trust model as nonce). */
  codeVerifier?: string;
  /**
   * Per-grant OAuth client id minted by dynamic registration at connect time (issue #167) —
   * carried through the consent round-trip so the callback exchanges against the SAME client the
   * authorize URL named, then persists it on the grant for every later refresh.
   */
  clientId?: string;
  /**
   * The environment ids whose approval-callback URLs were registered on the minted client
   * (issue #167). The registered client is IMMUTABLE, so the callback re-lists the agent's
   * environments and refuses the flow when one exists that this set doesn't cover — an
   * environment created while the consent tab was open would otherwise store a grant whose
   * client silently can't receive that environment's callbacks (and, having been created BEFORE
   * the grant, would never trip the Connections card's needs-reconnect watermark).
   */
  environmentIds?: string[];
}

/** The HMAC key: the same tenant-wide key that seals secrets. */
export function connectStateKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

/** Sign a connect state. `returnTo` must already be a validated same-origin path. */
export function signConnectState(state: ConnectState, key: Buffer): string {
  return signState(state, key);
}

/**
 * Verify signature + expiry AND re-validate every field (including that `returnTo` is still a
 * same-origin relative path — belt and suspenders against a signing bug or key reuse). The
 * provider must still be registered (the registry is the authority), and a codeVerifier — when
 * present — must be an RFC 7636 §4.1 verifier length (43..128). Null on anything off; never
 * throws on malformed input.
 */
export function verifyConnectState(
  token: string,
  key: Buffer,
  now: number = Date.now(),
): ConnectState | null {
  const parsed = verifyState<ConnectState>(token, key, now);
  if (!parsed) return null;
  if (
    typeof parsed.projectId !== "string" ||
    typeof parsed.agentId !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.provider !== "string" ||
    getProvider(parsed.provider) === null ||
    typeof parsed.scopes !== "string" ||
    typeof parsed.returnTo !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    return null;
  }
  if (
    parsed.codeVerifier !== undefined &&
    (typeof parsed.codeVerifier !== "string" ||
      parsed.codeVerifier.length < 43 ||
      parsed.codeVerifier.length > 128)
  ) {
    return null;
  }
  if (
    parsed.clientId !== undefined &&
    (typeof parsed.clientId !== "string" || parsed.clientId.length === 0)
  ) {
    return null;
  }
  if (
    parsed.environmentIds !== undefined &&
    (!Array.isArray(parsed.environmentIds) ||
      parsed.environmentIds.some(
        (id) => typeof id !== "string" || id.length === 0,
      ))
  ) {
    return null;
  }
  if (safeReturnTo(parsed.returnTo) === null) return null;
  return parsed;
}

/* ────────────────────────────────── PKCE (RFC 7636) ───────────────────────────────── */

/** RFC 7636: 32 random bytes base64url = 43 chars, the minimum verifier length. */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 code_challenge for a verifier. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/* ─────────────────────────────── authorize URL (pure) ─────────────────────────────── */

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Connector-declared scopes (space-separated or array); identity scopes are added here. */
  scopes: string | string[];
  /** S256 challenge; callers pass it only when the provider declares `pkce`. */
  codeChallenge?: string;
}

/**
 * The provider's OAuth 2.0 authorize URL. Provider quirks live in `authorizeParams` (Google:
 * access_type=offline + prompt=consent guarantee a refresh token even on re-consent) and
 * `identityScopes` (folded in so the callback can name the connected account). Deduped, stable
 * scope order; params emit in insertion order, so Google's query string is byte-for-byte what
 * the Google-only broker produced.
 */
export function authorizeUrl(
  provider: ProviderDefinition,
  input: AuthorizeUrlInput,
): string {
  const requested = Array.isArray(input.scopes)
    ? input.scopes
    : input.scopes.split(/\s+/).filter(Boolean);
  const scopes: string[] = [];
  for (const s of [...requested, ...(provider.identityScopes ?? [])]) {
    if (!scopes.includes(s)) scopes.push(s);
  }
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    ...(provider.authorizeParams ?? {}),
    state: input.state,
  });
  if (input.codeChallenge) {
    params.set("code_challenge", input.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${provider.authorizeUrl}?${params.toString()}`;
}

/* ─────────────────────────────── token exchange (network) ─────────────────────────── */

export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds (Google typically returns 3599). */
  expiresIn: number;
  /** Scopes actually granted, space-separated. */
  scope: string;
}

/** A dead-grant marker so callers (deploy) can distinguish "reconnect needed" from a transient 5xx. */
export class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGrantError";
  }
}

/**
 * Exchange an authorization code for tokens. Throws a readable Error on a non-2xx response or
 * when the provider returns no refresh_token (for Google that happens if consent was previously
 * granted without `prompt=consent` — we always send it, so this is a real misconfiguration worth
 * surfacing; the provider's `noRefreshTokenHint` carries the remediation).
 */
export async function exchangeCode(
  input: {
    provider: ProviderDefinition;
    config: OAuthClientConfig;
    code: string;
    redirectUri: string;
    /** PKCE verifier from the signed state; sent as code_verifier when present. */
    codeVerifier?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenGrant> {
  const { provider } = input;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.config.clientId,
    redirect_uri: input.redirectUri,
  });
  // Public clients (tokenEndpointAuth "none", issue #167) have no secret — PKCE is the proof.
  if (input.config.clientSecret !== undefined) {
    form.set("client_secret", input.config.clientSecret);
  }
  if (input.codeVerifier) form.set("code_verifier", input.codeVerifier);
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${provider.label} rejected the token exchange (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.access_token) {
    throw new Error(
      `${provider.label}'s token response is missing an access_token.`,
    );
  }
  if (!body.refresh_token) {
    throw new Error(
      `${provider.label} returned no refresh token.` +
        (provider.noRefreshTokenHint
          ? ` ${provider.noRefreshTokenHint}`
          : ""),
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in ?? 3599,
    scope: body.scope ?? "",
  };
}

/**
 * Best-effort account email from the provider's userinfo endpoint (display only). Null on any
 * failure, and null WITHOUT a request when the provider declares no userinfoUrl.
 */
export async function fetchAccountEmail(
  provider: ProviderDefinition,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!provider.userinfoUrl) return null;
  try {
    const res = await fetchImpl(provider.userinfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { email?: string };
    return body.email ?? null;
  } catch {
    return null;
  }
}

/* ──────────────────── dynamic client registration (RFC 7591, network) ─────────────────── */

/**
 * Register a fresh OAuth client with a provider that declares `clientRegistration` (issue #167) —
 * one client PER GRANT, minted at Connect time. RFC 7591-shaped POST; `approval_callback_uris`
 * is the (mayi-shaped) extension carrying the exact instance callback URL of every environment
 * the agent has (immutable, exact-match — a later environment needs a reconnect, which registers
 * a fresh client). Throws a readable Error on any failure; registration endpoints validate
 * callback URIs as public HTTPS, so the caller appends the local-dev remediation.
 */
export async function registerOAuthClient(
  input: {
    provider: ProviderDefinition;
    clientName: string;
    redirectUris: string[];
    approvalCallbackUris?: string[];
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string }> {
  const { provider } = input;
  const endpoint = provider.clientRegistration?.endpoint;
  if (!endpoint) {
    throw new Error(
      `${provider.label} does not support dynamic client registration.`,
    );
  }
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      ...(input.approvalCallbackUris && input.approvalCallbackUris.length > 0
        ? { approval_callback_uris: input.approvalCallbackUris }
        : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${provider.label} rejected the OAuth client registration (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) {
    throw new Error(
      `${provider.label}'s client registration response is missing a client_id.`,
    );
  }
  return { clientId: body.client_id };
}

/**
 * Exchange a refresh token for a fresh access token. Throws `InvalidGrantError` when the provider
 * reports `invalid_grant` (the refresh token is dead — revoked, expired, or Google's 7-day
 * Testing-mode cap) so the caller can mark the grant expired and prompt a reconnect; throws a
 * plain Error on any other failure (transient, worth a retry). This is the same grant the shipped
 * connection file runs at runtime — kept here too so deploy can validate a grant before injecting
 * it.
 *
 * Rotating grants (issue #167): providers like mayi return a NEW `refresh_token` on every refresh
 * and revoke the whole token family if the old one is reused. When the response carries one it is
 * returned as `refreshToken` — every harnesst-side caller MUST persist it back onto the grant before
 * using the new access token. Google returns none; the field stays undefined and nothing changes.
 */
export async function refreshAccessToken(
  input: {
    provider: ProviderDefinition;
    config: OAuthClientConfig;
    refreshToken: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  const { provider } = input;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.config.clientId,
  });
  // Public clients (tokenEndpointAuth "none", issue #167) have no secret to send.
  if (input.config.clientSecret !== undefined) {
    form.set("client_secret", input.config.clientSecret);
  }
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 400 && /invalid_grant/.test(body)) {
      throw new InvalidGrantError(
        `${provider.label} refused the refresh token (invalid_grant) — the connection is no longer valid.`,
      );
    }
    throw new Error(
      `${provider.label} rejected the token refresh (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!body.access_token) {
    throw new Error(
      `${provider.label}'s refresh response is missing an access_token.`,
    );
  }
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in ?? 3599,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
  };
}
