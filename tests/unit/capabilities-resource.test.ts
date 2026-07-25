/**
 * Capability resource binding (issue #166) — the post-consent tenant/organisation flow:
 *
 *  - the generic connect CALLBACK resolves the binding with the exchange's fresh token: exactly
 *    one listed resource binds silently; several store the grant UNBOUND and redirect to the
 *    picker; a reconnect keeps a still-listed prior binding (never silently re-targets); an
 *    account with NO usable resource fails readably and stores nothing;
 *  - the PICKER (loader/action) lists resources with a brokered token, refuses a browser-picked
 *    id that a fresh listing doesn't contain, binds validated picks, audits, and redeploys.
 *
 * Same seam mocking as connection-routes.test.ts; the capability registry is mocked so the
 * resource listing is a controllable fake (the real xero definition would dial api.xero.com).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilityDefinition } from "~/capabilities/definition.server";

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
  listResources: vi.fn(),
  redeployAfterConnect: vi.fn(),
  requireProject: vi.fn(),
  setGrantResource: vi.fn(),
  upsertGrant: vi.fn(),
}));

/** A xero-shaped capability whose resource listing is the controllable mock above. */
const FAKE_CAPABILITY = vi.hoisted((): { current: CapabilityDefinition | null } => ({
  current: null,
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
vi.mock("~/capabilities/registry.server", () => ({
  getCapability: (id: string) => (id === "xero" ? FAKE_CAPABILITY.current : null),
  listCapabilities: () => (FAKE_CAPABILITY.current ? [FAKE_CAPABILITY.current] : []),
}));
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
  };
});
vi.mock("~/connections/grants.server", () => ({
  findGrant: mocks.findGrant,
  setGrantResource: mocks.setGrantResource,
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
  return { ...actual, publicOrigin: () => "https://harnesst.example.com" };
});
vi.mock("~/project/guard.server", () => ({
  requireProject: mocks.requireProject,
  requireRepo: (project: unknown) => project,
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: { audit: { record: mocks.auditRecord } } }),
}));

process.env.HARNESST_SECRETS_KEY =
  "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";

const PROJECT = {
  id: "projabcdefgh",
  orgId: "org-owner",
  repoInstallationId: "1234",
  repoOwner: "zero8ai",
  repoName: "example",
};
const AGENT = { id: "agntabcdefgh", name: "books", root: "roster/books", kind: "member" };
const XERO_SCOPES =
  "offline_access accounting.invoices accounting.contacts accounting.settings.read accounting.attachments";
const TENANT_A = { id: "tenant-a", name: "Acme Ltd" };
const TENANT_B = { id: "tenant-b", name: "Beta Pty" };

function routeArgs<P extends Record<string, string>>(
  url: string,
  params: P = {} as P,
  init?: RequestInit & { headers?: HeadersInit },
) {
  const request = new Request(url, init);
  return {
    request,
    url: new URL(url),
    pattern: new URL(url).pathname,
    params,
    context: {} as never,
  };
}

function xeroLock() {
  return JSON.stringify({
    version: 1,
    installs: [
      {
        id: "xero",
        type: "connection",
        name: "Xero",
        version: "0.1.0",
        hash: "hash",
        registry: "fixture",
        member: AGENT.name,
        files: [],
        auth: [
          {
            provider: "xero",
            kind: "oauth2",
            scopes: XERO_SCOPES.split(" "),
            capabilityGroups: ["reference-read"],
            selectedCapabilityGroups: ["reference-read"],
          },
        ],
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
  throw new Error("expected a redirect Response");
}

function resetSeams() {
  vi.resetModules();
  FAKE_CAPABILITY.current = {
    provider: "xero",
    resource: {
      label: "organisation",
      list: (accessToken: string) => mocks.listResources(accessToken),
    },
    operationGroups: [],
  };
  mocks.auditRecord.mockReset().mockResolvedValue(undefined);
  mocks.consumeOAuthStateNonce.mockReset().mockResolvedValue(true);
  mocks.createOAuthStateNonce.mockReset().mockResolvedValue("nonce-owner");
  mocks.exchangeCode.mockReset().mockResolvedValue({
    accessToken: "fresh-access-token",
    refreshToken: "rotating-refresh-token",
    expiresIn: 1800,
    scope: XERO_SCOPES,
  });
  mocks.fetchAccountEmail.mockReset().mockResolvedValue(null);
  mocks.findGrant.mockReset().mockResolvedValue(null);
  mocks.getAgentSource.mockReset().mockResolvedValue({
    files: { "harnesst-lock.json": xeroLock() },
    paths: [],
  });
  mocks.fetchAgentSource.mockReset().mockResolvedValue({
    files: { "harnesst-lock.json": xeroLock() },
    paths: [],
  });
  mocks.getConfig.mockReset().mockReturnValue({
    clientId: "xero_client",
    clientSecret: "xero_secret",
  });
  mocks.listAgentEnvironments.mockReset().mockResolvedValue([]);
  mocks.listAgents.mockReset().mockResolvedValue([AGENT]);
  mocks.listDrafts.mockReset().mockResolvedValue([]);
  mocks.listResources.mockReset().mockResolvedValue([TENANT_A]);
  mocks.redeployAfterConnect.mockReset().mockResolvedValue({ status: "not-deployed" });
  mocks.requireProject.mockReset().mockResolvedValue(PROJECT);
  mocks.setGrantResource.mockReset().mockResolvedValue(undefined);
  mocks.upsertGrant.mockReset().mockResolvedValue(undefined);
}

/** Drive the two-pass staged callback for xero and return the final outcome (data or redirect). */
async function runCallback() {
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
      nonce: "xero-nonce",
      provider: "xero",
      scopes: XERO_SCOPES,
      returnTo: "/repos/projabcdefgh/agents/books/deployments",
      exp: Date.now() + 60_000,
      codeVerifier: "v".repeat(43),
    },
    connectStateKey(),
  );
  const staged = (await loader(
    routeArgs(
      `https://harnesst.example.com/connections/xero/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      { provider: "xero" },
    ),
  )) as Response;
  const cookie = staged.headers.get("set-cookie")!.split(";", 1)[0];
  try {
    return {
      data: await loader(
        routeArgs(
          "https://harnesst.example.com/connections/xero/callback",
          { provider: "xero" },
          { headers: { cookie } },
        ),
      ),
      redirect: null as Response | null,
    };
  } catch (error) {
    if (error instanceof Response) return { data: null, redirect: error };
    throw error;
  }
}

describe("connect callback — capability resource binding", () => {
  beforeEach(resetSeams);

  it("binds silently when the account reaches exactly one organisation", async () => {
    mocks.listResources.mockResolvedValue([TENANT_A]);
    const { redirect } = await runCallback();
    expect(redirect?.status).toBe(302);
    expect(redirect?.headers.get("location")).toBe(
      "/repos/projabcdefgh/agents/books/deployments?connected=xero",
    );
    // The listing ran with the EXCHANGE's fresh access token — no second refresh.
    expect(mocks.listResources).toHaveBeenCalledWith("fresh-access-token");
    expect(mocks.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xero",
        refreshToken: "rotating-refresh-token",
        resourceId: TENANT_A.id,
        resourceName: TENANT_A.name,
      }),
    );
  });

  it("stores the grant UNBOUND and redirects to the picker when several organisations are listed", async () => {
    mocks.listResources.mockResolvedValue([TENANT_A, TENANT_B]);
    const { redirect } = await runCallback();
    expect(redirect?.status).toBe(302);
    const location = new URL(
      redirect!.headers.get("location")!,
      "https://harnesst.example.com",
    );
    expect(location.pathname).toBe("/connections/xero/resource");
    expect(location.searchParams.get("project")).toBe(PROJECT.id);
    expect(location.searchParams.get("agent")).toBe(AGENT.name);
    expect(mocks.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "xero", resourceId: null, resourceName: null }),
    );
  });

  it("keeps a reconnect's prior binding when it is still listed (never silently re-targets)", async () => {
    mocks.listResources.mockResolvedValue([TENANT_A, TENANT_B]);
    mocks.findGrant.mockResolvedValue({
      id: "grant_1",
      status: "active",
      resourceId: TENANT_B.id,
      resourceName: TENANT_B.name,
    });
    const { redirect } = await runCallback();
    expect(redirect?.headers.get("location")).toBe(
      "/repos/projabcdefgh/agents/books/deployments?connected=xero",
    );
    expect(mocks.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: TENANT_B.id, resourceName: TENANT_B.name }),
    );
  });

  it("fails readably and stores NOTHING when the account has no usable organisation", async () => {
    mocks.listResources.mockResolvedValue([]);
    const { data } = await runCallback();
    expect(data).toMatchObject({
      error: expect.stringMatching(/has no organisation harnesst can use/),
    });
    expect(mocks.upsertGrant).not.toHaveBeenCalled();
  });

  it("fails readably when the resource listing itself fails, storing nothing", async () => {
    mocks.listResources.mockRejectedValue(new Error("Xero rejected the connections lookup (HTTP 500)"));
    const { data } = await runCallback();
    expect(data).toMatchObject({
      error: expect.stringMatching(/connections lookup/),
    });
    expect(mocks.upsertGrant).not.toHaveBeenCalled();
  });
});

/* ───────────────────────────── the picker loader/action ───────────────────────────── */

import type { ResourcePickerDeps } from "~/capabilities/resource-flow.server";

const GRANT = {
  id: "grant_1",
  provider: "xero",
  status: "active",
  resourceId: null,
  resourceName: null,
} as never;

function pickerDeps(over: Partial<ResourcePickerDeps> = {}): ResourcePickerDeps {
  return {
    findGrant: mocks.findGrant as never,
    setGrantResource: mocks.setGrantResource as never,
    accessToken: async () => ({
      ok: true,
      accessToken: "brokered-token",
      expiresAt: Date.now() + 1_800_000,
    }),
    listResources: (_provider, accessToken) => mocks.listResources(accessToken),
    redeploy: mocks.redeployAfterConnect as never,
    ...over,
  };
}

const PICKER_URL =
  `https://harnesst.example.com/connections/xero/resource?project=${PROJECT.id}` +
  `&agent=${AGENT.name}&returnTo=${encodeURIComponent("/repos/projabcdefgh/agents/books/deployments")}`;

describe("resource picker", () => {
  beforeEach(() => {
    resetSeams();
    mocks.findGrant.mockResolvedValue(GRANT);
    mocks.listResources.mockResolvedValue([TENANT_A, TENANT_B]);
  });

  it("loader lists the account's organisations for the pick", async () => {
    const { resourcePickerLoader } = await import(
      "~/capabilities/resource-flow.server"
    );
    const data = (await resourcePickerLoader(
      routeArgs(PICKER_URL),
      "xero",
      pickerDeps(),
    )) as { error: string; options: unknown; resourceLabel: string };
    expect(data.error).toBe("");
    expect(data.resourceLabel).toBe("organisation");
    expect(data.options).toEqual([TENANT_A, TENANT_B]);
  });

  it("loader surfaces a readable error when the agent has no active grant", async () => {
    mocks.findGrant.mockResolvedValue(null);
    const { resourcePickerLoader } = await import(
      "~/capabilities/resource-flow.server"
    );
    const data = (await resourcePickerLoader(
      routeArgs(PICKER_URL),
      "xero",
      pickerDeps(),
    )) as { error: string };
    expect(data.error).toMatch(/no active Xero connection/);
  });

  it("action binds a validated pick, audits, redeploys, and returns to the Deployment tab", async () => {
    mocks.redeployAfterConnect.mockResolvedValue({ status: "redeployed" });
    const { resourcePickerAction } = await import(
      "~/capabilities/resource-flow.server"
    );
    const form = new URLSearchParams({ resourceId: TENANT_B.id });
    const response = await redirectFrom(
      resourcePickerAction(
        routeArgs(PICKER_URL, {}, {
          method: "POST",
          body: form,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        "xero",
        pickerDeps(),
      ),
    );
    expect(mocks.setGrantResource).toHaveBeenCalledWith(
      "grant_1",
      TENANT_B.id,
      TENANT_B.name,
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "connection.resource-bound" }),
    );
    const location = new URL(
      response.headers.get("location")!,
      "https://harnesst.example.com",
    );
    expect(location.pathname).toBe("/repos/projabcdefgh/agents/books/deployments");
    expect(location.searchParams.get("connected")).toBe("xero");
    expect(location.searchParams.get("redeploy")).toBe("queued");
  });

  it("action refuses a browser-picked id a FRESH listing doesn't contain", async () => {
    const { resourcePickerAction } = await import(
      "~/capabilities/resource-flow.server"
    );
    const form = new URLSearchParams({ resourceId: "tenant-not-mine" });
    const data = (await resourcePickerAction(
      routeArgs(PICKER_URL, {}, {
        method: "POST",
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      "xero",
      pickerDeps(),
    )) as { error: string };
    expect(data.error).toMatch(/isn't available to the connected Xero account/);
    expect(mocks.setGrantResource).not.toHaveBeenCalled();
  });
});
