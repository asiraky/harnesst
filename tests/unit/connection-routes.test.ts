/**
 * Provider-generic connect/callback routes (issue #163) — the URL-driven provider resolution the
 * generalization added: an unknown provider id renders a readable error page (never a consent
 * redirect, never an exchange), a registered PKCE provider gets a code_challenge on the authorize
 * URL and its code_verifier back on the exchange via the signed state, and google — from BOTH the
 * legacy alias and the generic route — keeps issuing its legacy /google/callback redirect URI
 * (operators' Google apps registered that URI; acceptance criterion 2).
 *
 * Same seam mocking as google-auth-routes.test.ts; the registry is extended with a hypothetical
 * "mayi" PKCE provider (the real registry ships only google, which declares no pkce).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderDefinition } from "~/connections/providers.server";

const mocks = vi.hoisted(() => ({
  auditRecord: vi.fn(),
  auth: {
    user: { id: "user-owner", email: "owner@example.com" },
    session: { id: "session-owner" },
    organizationId: "org-owner",
    requestHeaders: new Headers(),
  },
  consumeOAuthStateNonce: vi.fn(),
  createOAuthStateNonce: vi.fn(),
  exchangeCode: vi.fn(),
  fetchAccountEmail: vi.fn(),
  fetchAgentSource: vi.fn(),
  findGrant: vi.fn(),
  getAgentSource: vi.fn(),
  getConfig: vi.fn(),
  listAgentEnvironments: vi.fn(),
  listAgents: vi.fn(),
  listDrafts: vi.fn(),
  redeployAfterConnect: vi.fn(),
  registerOAuthClient: vi.fn(),
  requireProject: vi.fn(),
  upsertGrant: vi.fn(),
}));

const MAYI = vi.hoisted(
  (): ProviderDefinition => ({
    id: "mayi",
    label: "May I?",
    authorizeUrl: "https://auth.mayi.example/oauth/authorize",
    tokenUrl: "https://auth.mayi.example/oauth/token",
    pkce: true,
    envPrefix: "MAYI",
  }),
);

/**
 * A hypothetical provider with per-grant dynamic client registration (issue #167) — a PUBLIC
 * client whose immutable, exact-match callback URIs force one registered client per grant.
 */
const REGPROV = vi.hoisted(
  (): ProviderDefinition => ({
    id: "regprov",
    label: "Regprov",
    authorizeUrl: "https://auth.regprov.example/oauth/authorize",
    tokenUrl: "https://auth.regprov.example/oauth/token",
    pkce: true,
    envPrefix: "REGPROV",
    tokenEndpointAuth: "none",
    credentialDelivery: "access-token-broker",
    clientRegistration: {
      endpoint: "https://auth.regprov.example/oauth/register",
      approvalCallbackPath: "/eve/v1/regprov/approval-resolved",
    },
  }),
);

vi.mock("~/auth/session.server", () => ({
  sessionLoader: async (
    _args: unknown,
    callback: (input: { auth: typeof mocks.auth }) => Promise<object>,
  ) => ({
    ...(await callback({ auth: mocks.auth })),
    user: mocks.auth.user,
  }),
}));

vi.mock("~/connections/providers.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/connections/providers.server")>();
  return {
    ...actual,
    getProvider: (id: string) =>
      id === "mayi" ? MAYI : id === "regprov" ? REGPROV : actual.getProvider(id),
    listProviders: () => [...actual.listProviders(), MAYI, REGPROV],
  };
});

vi.mock("~/connections/config.server", () => ({
  getProviderOAuthConfig: mocks.getConfig,
  getGoogleOAuthConfig: mocks.getConfig,
}));

vi.mock("~/connections/oauth.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/connections/oauth.server")>();
  return {
    ...actual,
    exchangeCode: mocks.exchangeCode,
    fetchAccountEmail: mocks.fetchAccountEmail,
    registerOAuthClient: mocks.registerOAuthClient,
  };
});

vi.mock("~/connections/grants.server", () => ({
  findGrant: mocks.findGrant,
  upsertGrant: mocks.upsertGrant,
}));

vi.mock("~/connections/oauth-state.server", () => ({
  consumeOAuthStateNonce: mocks.consumeOAuthStateNonce,
  createOAuthStateNonce: mocks.createOAuthStateNonce,
}));

vi.mock("~/connections/redeploy.server", () => ({
  redeployAfterConnect: mocks.redeployAfterConnect,
}));

vi.mock("~/db/queries.server", () => ({
  listAgentEnvironments: mocks.listAgentEnvironments,
  listAgents: mocks.listAgents,
}));
vi.mock("~/drafts/drafts.server", () => ({ listDrafts: mocks.listDrafts }));
vi.mock("~/github/cached.server", () => ({
  getAgentSource: mocks.getAgentSource,
}));
// The callback's lock-currency guard reads RAW (issue #173) — the connect loader keeps the cache.
vi.mock("~/github/repo.server", () => ({
  fetchAgentSource: mocks.fetchAgentSource,
}));
vi.mock("~/lib/ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/ingress")>();
  return { ...actual, publicOrigin: () => "https://eden.example.com" };
});
vi.mock("~/project/guard.server", () => ({
  requireProject: mocks.requireProject,
  requireRepo: (project: unknown) => project,
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: { audit: { record: mocks.auditRecord } } }),
}));

process.env.EDEN_SECRETS_KEY =
  "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";

const PROJECT = {
  id: "projabcdefgh",
  orgId: "org-owner",
  repoInstallationId: "1234",
  repoOwner: "zero8ai",
  repoName: "example",
};
const AGENT = {
  id: "agntabcdefgh",
  name: "agent",
  root: "agent",
  kind: "member",
};
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const MAYI_SCOPE = "mayi.approvals";

function routeArgs<P extends Record<string, string>>(
  url: string,
  params: P = {} as P,
  headers?: HeadersInit,
) {
  const request = new Request(url, { headers });
  return {
    request,
    url: new URL(url),
    pattern: new URL(url).pathname,
    params,
    context: {} as never,
  };
}

function lockWith(provider: string, scope: string) {
  return JSON.stringify({
    version: 1,
    installs: [
      {
        id: `${provider}-connector`,
        type: "connection",
        name: provider,
        version: "1.0.0",
        hash: "hash",
        registry: "fixture",
        member: null,
        files: [],
        auth: [{ provider, kind: "oauth2", scopes: [scope] }],
      },
    ],
  });
}

async function redirectFrom(operation: unknown): Promise<Response> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("expected the loader to throw a redirect Response");
}

function resetSeams() {
  vi.resetModules();
  mocks.auditRecord.mockReset().mockResolvedValue(undefined);
  mocks.consumeOAuthStateNonce.mockReset().mockResolvedValue(true);
  mocks.createOAuthStateNonce.mockReset().mockResolvedValue("nonce-owner");
  mocks.exchangeCode.mockReset();
  mocks.fetchAccountEmail.mockReset().mockResolvedValue(null);
  mocks.findGrant.mockReset().mockResolvedValue(null);
  mocks.getAgentSource.mockReset().mockResolvedValue({
    files: { "eden-lock.json": lockWith("google", SHEETS_SCOPE) },
    paths: [],
  });
  mocks.fetchAgentSource.mockReset().mockResolvedValue({
    files: { "eden-lock.json": lockWith("google", SHEETS_SCOPE) },
    paths: [],
  });
  mocks.getConfig.mockReset().mockReturnValue({
    clientId: "client_1",
    clientSecret: "secret_1",
  });
  mocks.listAgentEnvironments.mockReset().mockResolvedValue([]);
  mocks.listAgents.mockReset().mockResolvedValue([AGENT]);
  mocks.listDrafts.mockReset().mockResolvedValue([]);
  mocks.redeployAfterConnect
    .mockReset()
    .mockResolvedValue({ status: "not-deployed" });
  mocks.registerOAuthClient.mockReset();
  mocks.requireProject.mockReset().mockResolvedValue(PROJECT);
  mocks.upsertGrant.mockReset().mockResolvedValue(undefined);
}

describe("provider-generic connection routes (issue #163)", () => {
  beforeEach(resetSeams);

  it("renders a readable error for an unknown provider on connect — no consent redirect", async () => {
    const { loader } = await import(
      "~/routes/connections.$provider.connect"
    );
    const result = await loader(
      routeArgs(
        "https://eden.example.com/connections/notaprovider/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
        { provider: "notaprovider" },
      ),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining(
        '"notaprovider" is not a connection provider',
      ),
      backUrl: "/dashboard",
      providerLabel: "notaprovider",
    });
    // Rejected before any tenancy/consent work — never a provider redirect.
    expect(mocks.requireProject).not.toHaveBeenCalled();
    expect(mocks.createOAuthStateNonce).not.toHaveBeenCalled();
  });

  it("renders a readable error for an unknown provider on callback — never exchanges", async () => {
    const { loader } = await import(
      "~/routes/connections.$provider.callback"
    );
    const result = await loader(
      routeArgs("https://eden.example.com/connections/notaprovider/callback", {
        provider: "notaprovider",
      }),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining(
        '"notaprovider" is not a connection provider',
      ),
      providerLabel: "notaprovider",
    });
    expect(mocks.consumeOAuthStateNonce).not.toHaveBeenCalled();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it("issues the legacy /google/callback redirect URI from the generic google connect route", async () => {
    const { loader } = await import(
      "~/routes/connections.$provider.connect"
    );
    const response = await redirectFrom(
      loader(
        routeArgs(
          "https://eden.example.com/connections/google/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
          { provider: "google" },
        ),
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://eden.example.com/google/callback",
    );
    // Google declares no pkce — the generic route must not add PKCE params for it.
    expect(location.searchParams.has("code_challenge")).toBe(false);
  });

  it("issues the same legacy redirect URI from the /google/connect alias", async () => {
    const { loader } = await import("~/routes/google.connect");
    const response = await redirectFrom(
      loader(
        routeArgs(
          "https://eden.example.com/google/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
        ),
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://eden.example.com/google/callback",
    );
  });

  it("puts an S256 code_challenge on a PKCE provider's authorize URL and the verifier in the state", async () => {
    mocks.getAgentSource.mockResolvedValue({
      files: { "eden-lock.json": lockWith("mayi", MAYI_SCOPE) },
      paths: [],
    });
    const { loader } = await import(
      "~/routes/connections.$provider.connect"
    );
    const { codeChallengeS256, connectStateKey, verifyConnectState } =
      await import("~/connections/oauth.server");

    const response = await redirectFrom(
      loader(
        routeArgs(
          "https://eden.example.com/connections/mayi/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
          { provider: "mayi" },
        ),
      ),
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://auth.mayi.example/oauth/authorize",
    );
    // New providers use the canonical redirect path — no legacy override.
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://eden.example.com/connections/mayi/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const state = verifyConnectState(
      location.searchParams.get("state")!,
      connectStateKey(),
    );
    expect(state).toMatchObject({ provider: "mayi", scopes: MAYI_SCOPE });
    expect(state?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The challenge on the URL is derived from the verifier riding in the signed state.
    expect(location.searchParams.get("code_challenge")).toBe(
      codeChallengeS256(state!.codeVerifier!),
    );
  });

  it("passes the state's code_verifier to the exchange on a PKCE provider's callback", async () => {
    const { loader } = await import(
      "~/routes/connections.$provider.callback"
    );
    const { connectStateKey, signConnectState } = await import(
      "~/connections/oauth.server"
    );
    const codeVerifier = "v".repeat(43);
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "mayi-nonce",
        provider: "mayi",
        scopes: MAYI_SCOPE,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
        codeVerifier,
      },
      connectStateKey(),
    );
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3599,
      scope: MAYI_SCOPE,
    });

    // Credential-bearing hit stages into the path-scoped cookie and redirects clean.
    const staged = await loader(
      routeArgs(
        `https://eden.example.com/connections/mayi/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
        { provider: "mayi" },
      ),
    );
    expect(staged).toBeInstanceOf(Response);
    expect((staged as Response).headers.get("location")).toBe(
      "/connections/mayi/callback",
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];

    const response = await redirectFrom(
      loader(
        routeArgs(
          "https://eden.example.com/connections/mayi/callback",
          { provider: "mayi" },
          { cookie },
        ),
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard?connected=mayi");
    expect(mocks.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ id: "mayi" }),
        config: { clientId: "client_1", clientSecret: "secret_1" },
        code: "one-time-code",
        redirectUri: "https://eden.example.com/connections/mayi/callback",
        codeVerifier,
      }),
    );
    // No userinfoUrl → the grant stores accountEmail null ("Connected" without an email).
    expect(mocks.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "mayi",
        accountEmail: null,
        refreshToken: "refresh-token",
      }),
    );
  });

  it("refuses a google-signed state on another provider's callback (provider pin)", async () => {
    const { loader } = await import(
      "~/routes/connections.$provider.callback"
    );
    const { connectStateKey, signConnectState } = await import(
      "~/connections/oauth.server"
    );
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "pin-nonce",
        provider: "google",
        scopes: SHEETS_SCOPE,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );
    const staged = await loader(
      routeArgs(
        `https://eden.example.com/connections/mayi/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
        { provider: "mayi" },
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    const result = await loader(
      routeArgs(
        "https://eden.example.com/connections/mayi/callback",
        { provider: "mayi" },
        { cookie },
      ),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("invalid or has expired"),
    });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });
});

describe("per-grant dynamic client registration (issue #167)", () => {
  const OLD_PUBLIC_ORIGIN = process.env.EDEN_PUBLIC_ORIGIN;
  beforeEach(() => {
    resetSeams();
    process.env.EDEN_PUBLIC_ORIGIN = "https://eden.public.example";
    // Registration providers have NO operator client env — that must not block Connect.
    mocks.getConfig.mockReturnValue(null);
    mocks.getAgentSource.mockResolvedValue({
      files: { "eden-lock.json": lockWith("regprov", "approval:create") },
      paths: [],
    });
    mocks.listAgentEnvironments.mockResolvedValue([
      { id: "envaaaaaaaaa" },
      { id: "envbbbbbbbbb" },
    ]);
    mocks.registerOAuthClient.mockResolvedValue({ clientId: "reg_client_1" });
  });
  afterEach(() => {
    if (OLD_PUBLIC_ORIGIN === undefined) delete process.env.EDEN_PUBLIC_ORIGIN;
    else process.env.EDEN_PUBLIC_ORIGIN = OLD_PUBLIC_ORIGIN;
  });

  it("registers one client at Connect covering every environment's exact callback URL, and the minted client_id rides the authorize URL + signed state", async () => {
    const { loader } = await import("~/routes/connections.$provider.connect");
    const { connectStateKey, verifyConnectState } = await import(
      "~/connections/oauth.server"
    );
    const response = await redirectFrom(
      loader(
        routeArgs(
          "https://eden.example.com/connections/regprov/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
          { provider: "regprov" },
        ),
      ),
    );
    expect(mocks.registerOAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ id: "regprov" }),
        clientName: "harnesst — projabcdefgh / agent",
        redirectUris: ["https://eden.example.com/connections/regprov/callback"],
        // Exact per-environment instance callback URLs, rooted at the OPERATOR's public origin
        // (EDEN_PUBLIC_ORIGIN — the same origin EVE_PUBLIC_ORIGIN injection uses).
        approvalCallbackUris: [
          "https://eden.public.example/e/envaaaaaaaaa/eve/v1/regprov/approval-resolved",
          "https://eden.public.example/e/envbbbbbbbbb/eve/v1/regprov/approval-resolved",
        ],
      }),
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://auth.regprov.example/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("reg_client_1");
    const state = verifyConnectState(
      location.searchParams.get("state")!,
      connectStateKey(),
    );
    expect(state?.clientId).toBe("reg_client_1");
    // The registered environment SET rides the signed state too — the callback compares it
    // against a fresh listing to refuse a flow during which an environment appeared.
    expect(state?.environmentIds).toEqual(["envaaaaaaaaa", "envbbbbbbbbb"]);
  });

  it("exchanges against the state's registered client on callback and persists it on the grant", async () => {
    const { loader } = await import("~/routes/connections.$provider.callback");
    const { connectStateKey, signConnectState } = await import(
      "~/connections/oauth.server"
    );
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "regprov-nonce",
        provider: "regprov",
        scopes: "approval:create",
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
        codeVerifier: "v".repeat(43),
        clientId: "reg_client_1",
        // A superset of the current environments: an environment REMOVED during consent leaves
        // a harmless extra registered URI and must not refuse the flow.
        environmentIds: ["envaaaaaaaaa", "envbbbbbbbbb", "envremovedxx"],
      },
      connectStateKey(),
    );
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3599,
      scope: "approval:create",
    });

    const staged = await loader(
      routeArgs(
        `https://eden.example.com/connections/regprov/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
        { provider: "regprov" },
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    const response = await redirectFrom(
      loader(
        routeArgs(
          "https://eden.example.com/connections/regprov/callback",
          { provider: "regprov" },
          { cookie },
        ),
      ),
    );
    expect(response.status).toBe(302);
    // The exchange ran against the SAME client the authorize URL named — secretless (the config
    // is the grant's registered public client, never the missing operator config).
    expect(mocks.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ id: "regprov" }),
        config: { clientId: "reg_client_1" },
        code: "one-time-code",
      }),
    );
    // Persisted on the grant so every later refresh (deploy validation, broker) uses it.
    expect(mocks.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "regprov",
        clientId: "reg_client_1",
        refreshToken: "refresh-token",
      }),
    );
  });

  it("refuses a callback when an environment was created while the consent was in progress", async () => {
    // The registered client is IMMUTABLE and covers only the environments captured at connect
    // time. Storing this grant would render "connected" forever (the new environment PREDATES
    // grant.createdAt — the Connections card's staleness watermark) while its approval callbacks
    // are silently rejected. The flow must refuse instead; reconnecting registers a fresh client.
    const { loader } = await import("~/routes/connections.$provider.callback");
    const { connectStateKey, signConnectState } = await import(
      "~/connections/oauth.server"
    );
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "regprov-nonce",
        provider: "regprov",
        scopes: "approval:create",
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
        codeVerifier: "v".repeat(43),
        clientId: "reg_client_1",
        // Only environment A existed when the client was registered…
        environmentIds: ["envaaaaaaaaa"],
      },
      connectStateKey(),
    );
    // …but environment B exists by the time the consent completes (beforeEach lists A and B).
    const staged = await loader(
      routeArgs(
        `https://eden.example.com/connections/regprov/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
        { provider: "regprov" },
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    const result = await loader(
      routeArgs(
        "https://eden.example.com/connections/regprov/callback",
        { provider: "regprov" },
        { cookie },
      ),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("An environment was added"),
      backUrl: "/dashboard",
    });
    // Refused BEFORE the exchange — no token minted, no grant stored.
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.upsertGrant).not.toHaveBeenCalled();
  });

  it("stays lenient on an in-flight state without environmentIds (pre-coverage token)", async () => {
    const { loader } = await import("~/routes/connections.$provider.callback");
    const { connectStateKey, signConnectState } = await import(
      "~/connections/oauth.server"
    );
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "regprov-nonce",
        provider: "regprov",
        scopes: "approval:create",
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
        codeVerifier: "v".repeat(43),
        clientId: "reg_client_1",
      },
      connectStateKey(),
    );
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3599,
      scope: "approval:create",
    });
    const staged = await loader(
      routeArgs(
        `https://eden.example.com/connections/regprov/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
        { provider: "regprov" },
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    const response = await redirectFrom(
      loader(
        routeArgs(
          "https://eden.example.com/connections/regprov/callback",
          { provider: "regprov" },
          { cookie },
        ),
      ),
    );
    expect(response.status).toBe(302);
    expect(mocks.upsertGrant).toHaveBeenCalled();
  });

  it("surfaces a readable error when registration fails (public-HTTPS callback rule / local dev)", async () => {
    mocks.registerOAuthClient.mockRejectedValue(
      new Error("Regprov rejected the OAuth client registration (HTTP 400): invalid callback"),
    );
    const { loader } = await import("~/routes/connections.$provider.connect");
    const result = await loader(
      routeArgs(
        "https://eden.example.com/connections/regprov/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
        { provider: "regprov" },
      ),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("publicly reachable"),
      backUrl: "/dashboard",
      providerLabel: "Regprov",
    });
    expect((result as { error: string }).error).toContain("EDEN_PUBLIC_ORIGIN");
    // Failed before any consent state was minted.
    expect(mocks.createOAuthStateNonce).not.toHaveBeenCalled();
  });

  it("google never registers a client and keeps requiring the operator config (regression)", async () => {
    mocks.getAgentSource.mockResolvedValue({
      files: { "eden-lock.json": lockWith("google", SHEETS_SCOPE) },
      paths: [],
    });
    const { loader } = await import("~/routes/connections.$provider.connect");
    // Unconfigured google still renders the operator-env error — registration is no substitute.
    const result = await loader(
      routeArgs(
        "https://eden.example.com/connections/google/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
        { provider: "google" },
      ),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("no Google OAuth client configured"),
    });
    expect(mocks.registerOAuthClient).not.toHaveBeenCalled();

    // Configured google connects exactly as before — no registration call, no state clientId.
    mocks.getConfig.mockReturnValue({ clientId: "client_1", clientSecret: "secret_1" });
    const { connectStateKey, verifyConnectState } = await import(
      "~/connections/oauth.server"
    );
    const response = await redirectFrom(
      loader(
        routeArgs(
          "https://eden.example.com/connections/google/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
          { provider: "google" },
        ),
      ),
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("client_id")).toBe("client_1");
    const state = verifyConnectState(
      location.searchParams.get("state")!,
      connectStateKey(),
    );
    expect(mocks.registerOAuthClient).not.toHaveBeenCalled();
    expect(state?.clientId).toBeUndefined();
  });
});
