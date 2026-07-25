import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getGoogleOAuthConfig: vi.fn(),
  listAgents: vi.fn(),
  listDrafts: vi.fn(),
  redeployAfterConnect: vi.fn(),
  requireProject: vi.fn(),
  upsertGrant: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  sessionLoader: async (
    _args: unknown,
    callback: (input: { auth: typeof mocks.auth }) => Promise<object>,
  ) => ({
    ...(await callback({ auth: mocks.auth })),
    user: mocks.auth.user,
  }),
}));

vi.mock("~/connections/config.server", () => ({
  getGoogleOAuthConfig: mocks.getGoogleOAuthConfig,
}));

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

vi.mock("~/connections/google.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/connections/google.server")>();
  return {
    ...actual,
    exchangeCode: mocks.exchangeCode,
    fetchAccountEmail: mocks.fetchAccountEmail,
  };
});

vi.mock("~/db/queries.server", () => ({ listAgents: mocks.listAgents }));
vi.mock("~/drafts/drafts.server", () => ({ listDrafts: mocks.listDrafts }));
vi.mock("~/github/cached.server", () => ({
  getAgentSource: mocks.getAgentSource,
}));
// The callback's lock-currency guard reads RAW (issue #173) — the connect loader keeps the cache.
vi.mock("~/github/repo.server", () => ({
  fetchAgentSource: mocks.fetchAgentSource,
}));
vi.mock("~/lib/ingress", () => ({
  publicOrigin: () => "https://eden.example.com",
}));
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

function routeArgs(url: string, headers?: HeadersInit) {
  const request = new Request(url, { headers });
  return {
    request,
    url: new URL(url),
    pattern: new URL(url).pathname,
    params: {},
    context: {} as never,
  };
}

function effectiveLock() {
  return JSON.stringify({
    version: 1,
    installs: [
      {
        id: "google-sheets",
        type: "connection",
        name: "Google Sheets",
        version: "1.0.0",
        hash: "hash",
        registry: "fixture",
        member: null,
        files: [],
        auth: [{ provider: "google", kind: "oauth2", scopes: [SHEETS_SCOPE] }],
      },
    ],
  });
}

describe("Google routes with Better Auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.auditRecord.mockReset().mockResolvedValue(undefined);
    mocks.consumeOAuthStateNonce.mockReset().mockResolvedValue(true);
    mocks.createOAuthStateNonce.mockReset().mockResolvedValue("nonce-owner");
    mocks.exchangeCode.mockReset();
    mocks.fetchAccountEmail.mockReset().mockResolvedValue("google@example.com");
    mocks.findGrant.mockReset().mockResolvedValue(null);
    mocks.getAgentSource.mockReset().mockResolvedValue({
      files: { "eden-lock.json": effectiveLock() },
      paths: [],
    });
    mocks.fetchAgentSource.mockReset().mockResolvedValue({
      files: { "eden-lock.json": effectiveLock() },
      paths: [],
    });
    mocks.getGoogleOAuthConfig.mockReset().mockReturnValue({
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    mocks.listAgents.mockReset().mockResolvedValue([AGENT]);
    mocks.listDrafts.mockReset().mockResolvedValue([]);
    mocks.redeployAfterConnect
      .mockReset()
      .mockResolvedValue({ status: "not-deployed" });
    mocks.requireProject.mockReset().mockResolvedValue(PROJECT);
    mocks.upsertGrant.mockReset().mockResolvedValue(undefined);
  });

  it("binds state to the Better Auth user/session and ignores browser-supplied scopes", async () => {
    const { loader } = await import("~/routes/google.connect");
    const { connectStateKey, verifyConnectState } =
      await import("~/connections/google.server");
    const operation = loader(
      routeArgs(
        "https://eden.example.com/google/connect?project=projabcdefgh&agent=agent" +
          "&scopes=https%3A%2F%2Fmail.google.com%2F&returnTo=%2Fdashboard",
      ),
    );

    let response: Response | undefined;
    try {
      await operation;
    } catch (error) {
      if (error instanceof Response) response = error;
      else throw error;
    }
    expect(response?.status).toBe(302);

    const location = new URL(response!.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("scope")).toContain(SHEETS_SCOPE);
    expect(location.searchParams.get("scope")).not.toContain(
      "https://mail.google.com/",
    );
    const state = verifyConnectState(
      location.searchParams.get("state")!,
      connectStateKey(),
    );
    expect(state).toMatchObject({
      projectId: PROJECT.id,
      agentId: AGENT.id,
      userId: mocks.auth.user.id,
      sessionId: mocks.auth.session.id,
      nonce: "nonce-owner",
      provider: "google",
      scopes: SHEETS_SCOPE,
    });
    expect(mocks.createOAuthStateNonce).toHaveBeenCalledWith({
      userId: mocks.auth.user.id,
      sessionId: mocks.auth.session.id,
      expiresAt: expect.any(Date),
    });
    expect(mocks.requireProject).toHaveBeenCalledWith(mocks.auth, PROJECT.id);
  });

  it("never falls back to the old grant's scopes when every permission is deselected (issue #165)", async () => {
    // The install snapshots scope groups with an EXPLICITLY empty selection. Connect must not
    // treat that like a legacy no-snapshot lock and re-request the old grant's broad scopes.
    mocks.getAgentSource.mockResolvedValue({
      files: {
        "eden-lock.json": JSON.stringify({
          version: 1,
          installs: [
            {
              id: "gmail",
              type: "connection",
              name: "Gmail",
              version: "1.0.0",
              hash: "hash",
              registry: "fixture",
              member: null,
              files: [],
              auth: [
                {
                  provider: "google",
                  kind: "oauth2",
                  scopeGroups: [
                    {
                      id: "read",
                      label: "Read mail",
                      description: "Read messages.",
                      scopes: [SHEETS_SCOPE],
                      default: true,
                    },
                  ],
                  selectedGroups: [],
                },
              ],
            },
          ],
        }),
      },
      paths: [],
    });
    mocks.findGrant.mockResolvedValue({
      scopes: `${SHEETS_SCOPE} https://mail.google.com/ openid email`,
    });

    const { loader } = await import("~/routes/google.connect");
    const result = await loader(
      routeArgs(
        "https://eden.example.com/google/connect?project=projabcdefgh&agent=agent&returnTo=%2Fdashboard",
      ),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("deselected"),
    });
    expect(mocks.createOAuthStateNonce).not.toHaveBeenCalled();
  });

  it("refuses a stale callback whose permission selection changed mid-flight (issue #165)", async () => {
    const { loader } = await import("~/routes/google.callback");
    const { connectStateKey, signConnectState } =
      await import("~/connections/google.server");
    // Signed when the selection still included gmail.send — the lock has since been narrowed to
    // spreadsheets only (effectiveLock()), so completing this older consent tab must not store
    // the broader grant back over the narrowed requirement.
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "stale-nonce",
        provider: "google",
        scopes: `${SHEETS_SCOPE} https://www.googleapis.com/auth/gmail.send`,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );

    const staged = await loader(
      routeArgs(
        `https://eden.example.com/google/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    const result = await loader(
      routeArgs("https://eden.example.com/google/callback", { cookie }),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining(
        "changed while this consent was in progress",
      ),
      backUrl: "/dashboard",
    });
    // The nonce is consumed (this flow is dead either way), but no token is minted or stored.
    expect(mocks.consumeOAuthStateNonce).toHaveBeenCalledTimes(1);
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.upsertGrant).not.toHaveBeenCalled();
  });

  it("refuses to store a grant when the selection narrows between exchange and write (TOCTOU)", async () => {
    const { loader } = await import("~/routes/google.callback");
    const { connectStateKey, signConnectState } =
      await import("~/connections/google.server");
    const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
    const broadLock = JSON.stringify({
      version: 1,
      installs: [
        {
          id: "google-sheets",
          type: "connection",
          name: "Google Sheets",
          version: "1.0.0",
          hash: "hash",
          registry: "fixture",
          member: null,
          files: [],
          auth: [
            {
              provider: "google",
              kind: "oauth2",
              scopes: [SHEETS_SCOPE, SEND_SCOPE],
            },
          ],
        },
      ],
    });
    // The pre-exchange currency check sees the broad requirement (matching this flow's state),
    // then a Permissions edit + newer reconnect narrows the lock while the exchange/userinfo
    // round-trips are in flight — the pre-write re-check must catch it and store nothing. Both
    // checks read RAW (issue #173), so the sequence rides the repo.server mock.
    mocks.fetchAgentSource
      .mockResolvedValueOnce({
        files: { "eden-lock.json": broadLock },
        paths: [],
      })
      .mockResolvedValue({
        files: { "eden-lock.json": effectiveLock() },
        paths: [],
      });
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "broad-refresh-token",
      expiresIn: 3_599,
      scope: `${SHEETS_SCOPE} ${SEND_SCOPE} openid email`,
    });
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "toctou-nonce",
        provider: "google",
        scopes: `${SHEETS_SCOPE} ${SEND_SCOPE}`,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );

    const staged = await loader(
      routeArgs(
        `https://eden.example.com/google/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    const result = await loader(
      routeArgs("https://eden.example.com/google/callback", { cookie }),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining(
        "changed while this consent was in progress",
      ),
      backUrl: "/dashboard",
    });
    // The exchange ran (the narrowing landed after it), but the broad token is discarded — the
    // fresher narrow grant is never overwritten.
    expect(mocks.exchangeCode).toHaveBeenCalledTimes(1);
    expect(mocks.upsertGrant).not.toHaveBeenCalled();
    expect(mocks.redeployAfterConnect).not.toHaveBeenCalled();
  });

  it("rejects a callback initiated by another Better Auth session before exchange", async () => {
    const { loader } = await import("~/routes/google.callback");
    const { connectStateKey, signConnectState } =
      await import("~/connections/google.server");
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: "another-user",
        sessionId: "another-session",
        nonce: "nonce-other",
        provider: "google",
        scopes: SHEETS_SCOPE,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );

    const staged = await loader(
      routeArgs(
        `https://eden.example.com/google/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(staged).toBeInstanceOf(Response);
    expect((staged as Response).status).toBe(302);
    expect((staged as Response).headers.get("location")).toBe(
      "/google/callback",
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];

    const result = await loader(
      routeArgs("https://eden.example.com/google/callback", { cookie }),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("different harnesst session"),
      backUrl: "/dashboard",
      user: mocks.auth.user,
    });
    expect(mocks.requireProject).not.toHaveBeenCalled();
    expect(mocks.consumeOAuthStateNonce).not.toHaveBeenCalled();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it("exchanges a staged callback only after its nonce is consumed exactly once", async () => {
    const { loader } = await import("~/routes/google.callback");
    const { connectStateKey, signConnectState } =
      await import("~/connections/google.server");
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "single-use-nonce",
        provider: "google",
        scopes: SHEETS_SCOPE,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );
    mocks.consumeOAuthStateNonce
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mocks.exchangeCode.mockRejectedValueOnce(
      new Error("deliberate exchange failure"),
    );

    const staged = await loader(
      routeArgs(
        `https://eden.example.com/google/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(staged).toBeInstanceOf(Response);
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    const cleanArgs = () =>
      routeArgs("https://eden.example.com/google/callback", { cookie });

    const first = await loader(cleanArgs());
    expect(first).toMatchObject({
      error: "deliberate exchange failure",
    });
    const replay = await loader(cleanArgs());
    expect(replay).toMatchObject({
      error: expect.stringContaining("already been used"),
    });
    expect(mocks.consumeOAuthStateNonce).toHaveBeenCalledTimes(2);
    expect(mocks.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("consumes denied consent without exchanging or persisting anything", async () => {
    const { loader } = await import("~/routes/google.callback");
    const { connectStateKey, signConnectState } =
      await import("~/connections/google.server");
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "denied-nonce",
        provider: "google",
        scopes: SHEETS_SCOPE,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );
    const staged = await loader(
      routeArgs(
        `https://eden.example.com/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];

    const result = await loader(
      routeArgs("https://eden.example.com/google/callback", { cookie }),
    );
    expect(result).toMatchObject({
      error: expect.stringContaining("cancelled or denied"),
    });
    expect(mocks.consumeOAuthStateNonce).toHaveBeenCalledTimes(1);
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.upsertGrant).not.toHaveBeenCalled();
  });

  it("persists and audits a successful callback from the clean URL", async () => {
    const { loader } = await import("~/routes/google.callback");
    const { connectStateKey, signConnectState } =
      await import("~/connections/google.server");
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "success-nonce",
        provider: "google",
        scopes: SHEETS_SCOPE,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3_599,
      scope: `${SHEETS_SCOPE} openid email`,
    });

    const staged = await loader(
      routeArgs(
        `https://eden.example.com/google/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    let redirectResponse: Response | undefined;
    try {
      await loader(
        routeArgs("https://eden.example.com/google/callback", { cookie }),
      );
    } catch (error) {
      if (error instanceof Response) redirectResponse = error;
      else throw error;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get("location")).toBe(
      "/dashboard?connected=google",
    );
    expect(mocks.exchangeCode).toHaveBeenCalledWith({
      config: {
        clientId: "google-client",
        clientSecret: "google-secret",
      },
      code: "one-time-code",
      redirectUri: "https://eden.example.com/google/callback",
    });
    expect(mocks.upsertGrant).toHaveBeenCalledWith({
      projectId: PROJECT.id,
      agentId: AGENT.id,
      provider: "google",
      accountEmail: "google@example.com",
      scopes: `${SHEETS_SCOPE} openid email`,
      refreshToken: "refresh-token",
      // Google never registers per-grant clients (issue #167 acceptance criterion 3).
      clientId: null,
      // ...and declares no capability, so no resource binding (issue #166).
      resourceId: null,
      resourceName: null,
      createdBy: mocks.auth.user.id,
    });
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: PROJECT.orgId,
        actorUserId: mocks.auth.user.id,
        action: "connection.connect",
      }),
    );
    expect(mocks.redeployAfterConnect).toHaveBeenCalledWith({
      projectId: PROJECT.id,
      agentId: AGENT.id,
      createdBy: mocks.auth.user.id,
    });
  });

  it("the callback's lock-currency checks read RAW, never the SWR cache (issue #173)", async () => {
    // The cache's invalidation is process-local: with >1 control-plane replica, a Permissions
    // edit through replica A leaves replica B's cached lock stale, and a broad consent callback
    // landing on B would pass both staleness checks against it — exactly the overwrite the guard
    // exists to prevent. Pin that BOTH checks hit the raw read and the cache is never consulted.
    const { loader } = await import("~/routes/google.callback");
    const { connectStateKey, signConnectState } =
      await import("~/connections/google.server");
    const state = signConnectState(
      {
        projectId: PROJECT.id,
        agentId: AGENT.id,
        userId: mocks.auth.user.id,
        sessionId: mocks.auth.session.id,
        nonce: "raw-read-nonce",
        provider: "google",
        scopes: SHEETS_SCOPE,
        returnTo: "/dashboard",
        exp: Date.now() + 60_000,
      },
      connectStateKey(),
    );
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3_599,
      scope: `${SHEETS_SCOPE} openid email`,
    });

    const staged = await loader(
      routeArgs(
        `https://eden.example.com/google/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      ),
    );
    const cookie = (staged as Response).headers
      .get("set-cookie")!
      .split(";", 1)[0];
    try {
      await loader(
        routeArgs("https://eden.example.com/google/callback", { cookie }),
      );
    } catch (error) {
      if (!(error instanceof Response)) throw error;
    }

    // One raw read per staleness pass (pre-exchange + pre-write); the cache untouched.
    expect(mocks.fetchAgentSource).toHaveBeenCalledTimes(2);
    expect(mocks.getAgentSource).not.toHaveBeenCalled();
    expect(mocks.upsertGrant).toHaveBeenCalled();
  });
});
