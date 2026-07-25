/**
 * OpenAI Codex (ChatGPT subscription) OAuth client (issue #28, Phase 1) — the device-code
 * sign-in flow plus the token exchange/refresh network calls and the JWT identity decode.
 *
 * Unlike the Google broker (a redirect-based authorization-code flow), a web control plane can't
 * use the Codex CLI's hardcoded `http://localhost:1455/auth/callback` redirect. So harnesst connects
 * a Codex account through OpenAI's DEVICE-CODE flow, an official Codex sign-in method:
 *
 *   1. usercode  — POST {auth}/api/accounts/deviceauth/usercode {client_id} → device_auth_id + code
 *   2. the human opens {auth}/codex/device and enters the code
 *   3. token poll — POST {auth}/api/accounts/deviceauth/token {device_auth_id, user_code}; 403/404
 *      means "still pending", success returns a server-generated PKCE pair + an authorization_code
 *   4. exchange   — POST {auth}/oauth/token (authorization_code + code_verifier) → access/refresh/id
 *   5. refresh    — POST {auth}/oauth/token (refresh_token); the refresh token MAY rotate
 *
 * There is no client secret (public client), so no new env var is required. The two base URLs are
 * env-overridable purely so tests and local development can point at a mock server. Everything
 * network-touching takes an injected `fetchImpl` (default `fetch`) so the flow unit-tests with no
 * real I/O. Ported from ChatMock (github.com/RayBytes/ChatMock, `chatmock/oauth.py` +
 * `chatmock/utils.py`) — the same client id and endpoints the Codex CLI uses.
 */

/** The public Codex CLI OAuth client id (no secret). Same value the Codex CLI ships. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Auth host — override with EDEN_CODEX_AUTH_BASE_URL for tests/dev-mocking. */
export function codexAuthBase(): string {
  return (
    process.env.EDEN_CODEX_AUTH_BASE_URL?.replace(/\/+$/, "") ||
    "https://auth.openai.com"
  );
}

/** Codex backend host (the Responses API) — override with EDEN_CODEX_API_BASE_URL. */
export function codexApiBase(): string {
  return (
    process.env.EDEN_CODEX_API_BASE_URL?.replace(/\/+$/, "") ||
    "https://chatgpt.com/backend-api/codex"
  );
}

/** A dead-grant marker so the gateway/refresh path can distinguish "reconnect needed" from a 5xx. */
export class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGrantError";
  }
}

/**
 * Raised when {auth}/api/accounts/deviceauth/usercode 404s — OpenAI returns that until the user
 * enables device-code login at https://chatgpt.com/settings/security. Surfaced as a friendly,
 * actionable error rather than a generic failure.
 */
export class DeviceLoginDisabledError extends Error {
  constructor() {
    super(
      "OpenAI hasn't enabled device-code login for this account yet. Turn it on at " +
        "https://chatgpt.com/settings/security, then try connecting again.",
    );
    this.name = "DeviceLoginDisabledError";
  }
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  /** Poll interval in seconds (>= 1). */
  interval: number;
  /** Where the human enters the code. */
  verificationUrl: string;
}

/**
 * Step 1 — request a device code. A 404 means device login must be enabled first
 * (DeviceLoginDisabledError); any other non-2xx throws a readable Error.
 */
export async function requestDeviceCode(
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCode> {
  const base = codexAuthBase();
  const res = await fetchImpl(`${base}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (res.status === 404) throw new DeviceLoginDisabledError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Couldn't start Codex device login (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const data = (await res.json()) as {
    device_auth_id?: string;
    user_code?: string;
    usercode?: string;
    interval?: number;
  };
  const deviceAuthId = data.device_auth_id;
  const userCode = data.user_code ?? data.usercode;
  if (typeof deviceAuthId !== "string" || typeof userCode !== "string") {
    throw new Error("Codex device-login response is missing expected fields.");
  }
  const interval = Math.max(Math.trunc(Number(data.interval) || 5), 1);
  return { deviceAuthId, userCode, interval, verificationUrl: `${base}/codex/device` };
}

/** Server-generated PKCE pair + authorization code returned once the user authorizes. */
export interface DevicePollSuccess {
  authorizationCode: string;
  codeVerifier: string;
}

/**
 * Step 3 — poll the device token endpoint once. HTTP 403/404 = the user hasn't authorized yet
 * ("pending"); a 2xx carries the authorization_code + code_verifier; any other status throws.
 */
export async function pollDeviceToken(
  input: { deviceAuthId: string; userCode: string },
  fetchImpl: typeof fetch = fetch,
): Promise<"pending" | DevicePollSuccess> {
  const res = await fetchImpl(
    `${codexAuthBase()}/api/accounts/deviceauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: input.deviceAuthId,
        user_code: input.userCode,
      }),
    },
  );
  if (res.status === 403 || res.status === 404) return "pending";
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Codex device login failed (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  const data = (await res.json()) as {
    authorization_code?: string;
    code_verifier?: string;
  };
  if (
    typeof data.authorization_code !== "string" ||
    typeof data.code_verifier !== "string"
  ) {
    throw new Error("Codex device-token response is missing expected fields.");
  }
  return {
    authorizationCode: data.authorization_code,
    codeVerifier: data.code_verifier,
  };
}

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

/** Step 4 — exchange the device authorization code (+ PKCE verifier) for tokens. */
export async function exchangeDeviceCode(
  input: { authorizationCode: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CodexTokens> {
  const base = codexAuthBase();
  const res = await fetchImpl(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      redirect_uri: `${base}/deviceauth/callback`,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Codex rejected the token exchange (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  return readTokenResponse(await res.json());
}

/**
 * Step 5 — exchange a refresh token for fresh tokens. The response MAY rotate the refresh token,
 * so callers must always persist the returned one. Throws `InvalidGrantError` when OpenAI reports
 * `invalid_grant` (the connection is dead — mark it expired and prompt a reconnect); throws a plain
 * Error on any other failure (transient, worth a retry).
 */
export async function refreshCodexTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexTokens> {
  const res = await fetchImpl(`${codexAuthBase()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
      scope: "openid profile email",
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500 && /invalid_grant/.test(body)) {
      throw new InvalidGrantError(
        "OpenAI refused the Codex refresh token (invalid_grant) — the connection is no longer valid.",
      );
    }
    throw new Error(
      `Codex rejected the token refresh (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
  // A rotated refresh token comes back on the response; fall back to the one we sent.
  const tokens = readTokenResponse(await res.json());
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

function readTokenResponse(json: unknown): CodexTokens {
  const body = (json ?? {}) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) {
    throw new Error("Codex token response is missing an access_token.");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? "",
    idToken: body.id_token ?? null,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3600,
  };
}

/**
 * Decode a JWT payload (the middle base64url segment) WITHOUT verifying the signature. We only use
 * the claims for display (email) and to read the ChatGPT account id header — never for trust — so
 * signature verification is unnecessary. Null on anything malformed.
 */
export function decodeJwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (typeof token !== "string" || token.split(".").length !== 3) return null;
  try {
    const payload = token.split(".")[1];
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf8");
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === "object"
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface AccountIdentity {
  email: string | null;
  accountId: string | null;
}

/**
 * Pull the display email + ChatGPT account id out of the token JWTs. The account id lives under a
 * namespaced claim; the fallback chain (per Codex CLI) is, checking the id_token first then the
 * access token:
 *   top-level `chatgpt_account_id`
 *   → `["https://api.openai.com/auth"].chatgpt_account_id`
 *   → `["https://api.openai.com/auth"].organizations[0].id`
 * The email is read from the id_token's `email` claim.
 */
export function extractAccountIdentity(input: {
  idToken: string | null;
  accessToken: string | null;
}): AccountIdentity {
  const idClaims = decodeJwtClaims(input.idToken);
  const accessClaims = decodeJwtClaims(input.accessToken);

  const email =
    (typeof idClaims?.email === "string" && idClaims.email) ||
    (typeof accessClaims?.email === "string" && accessClaims.email) ||
    null;

  const accountId =
    accountIdFromClaims(idClaims) ?? accountIdFromClaims(accessClaims) ?? null;

  return { email, accountId };
}

function accountIdFromClaims(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  const top = claims.chatgpt_account_id;
  if (typeof top === "string" && top) return top;
  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const authObj = auth as Record<string, unknown>;
    const nested = authObj.chatgpt_account_id;
    if (typeof nested === "string" && nested) return nested;
    const orgs = authObj.organizations;
    if (Array.isArray(orgs) && orgs.length > 0) {
      const first = orgs[0] as Record<string, unknown> | undefined;
      if (first && typeof first.id === "string" && first.id) return first.id;
    }
  }
  return null;
}
