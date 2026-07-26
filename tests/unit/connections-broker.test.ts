/**
 * Instance token broker (issue #167) — the control-plane half of "access-token-broker"
 * credential delivery. Two layers under test:
 *
 *  - `brokerAccessToken` (pure decision logic, fake deps): only brokered-delivery providers are
 *    served, refreshes run against the grant's own registered client, rotations persist BEFORE
 *    the access token is released, dead grants flip to "expired" with the reconnect message, and
 *    concurrent calls for one grant are serialized (the second sees the first's rotated token —
 *    the discipline that keeps mayi's family-reuse revocation from firing).
 *  - the `/api/connections/token` resource action (mocked seams): HARNESST_TEAM_TOKEN delegation
 *    auth (the Discord-send-proxy pattern), deployment → environment → agent resolution, body
 *    validation, and BrokerResult status passthrough.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  brokerAccessToken,
  type BrokerDeps,
} from "~/connections/broker.server";
import {
  connectionGrantEnv,
  type ConnectionDeployDeps,
} from "~/connections/deploy.server";
import { InvalidGrantError } from "~/connections/oauth.server";

const routeMocks = vi.hoisted(() => ({
  brokerAccessToken: vi.fn(),
  store: {
    deployments: { findById: vi.fn() },
    environments: { findById: vi.fn() },
    agents: { findById: vi.fn() },
  },
  verifyDelegationToken: vi.fn(),
}));

vi.mock("~/connections/broker.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/connections/broker.server")>();
  return { ...actual, brokerAccessToken: routeMocks.brokerAccessToken };
});
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: routeMocks.store }),
}));
vi.mock("~/team/token.server", () => ({
  verifyDelegationToken: routeMocks.verifyDelegationToken,
}));

// The pure-logic tests below want the REAL brokerAccessToken despite the route-facing mock.
const realBroker = (await vi
  .importActual<typeof import("~/connections/broker.server")>(
    "~/connections/broker.server",
  )
  .then((m) => m.brokerAccessToken)) as typeof brokerAccessToken;

const SCOPE = { projectId: "projabcdefgh", agentId: "agntabcdefgh" };
const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

function brokerDeps(over: Partial<BrokerDeps>): BrokerDeps {
  return {
    getConfig: () => null,
    openRefreshToken: async () => ({
      grant: {
        id: "grant_mayi",
        status: "active",
        scopes: "approval:create approval:read approval:cancel",
        clientId: "mayi_client_1",
      },
      refreshToken: "rt_1",
      tokenVersion: "iv_1",
    }),
    markGrantStatus: async () => {},
    rotateRefreshToken: async () => true,
    refreshAccessToken: async () => ({
      accessToken: "at_1",
      expiresIn: 3600,
      refreshToken: "rt_2",
    }),
    ...over,
  };
}

describe("brokerAccessToken", () => {
  it("refuses an unknown provider (404)", async () => {
    const out = await realBroker(
      { ...SCOPE, provider: "notaprovider" },
      okFetch,
      brokerDeps({}),
    );
    expect(out).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a refresh-token-delivery provider — brokering it would put two writers on one grant", async () => {
    const openRefreshToken = vi.fn();
    const out = await realBroker(
      { ...SCOPE, provider: "google" },
      okFetch,
      brokerDeps({ openRefreshToken }),
    );
    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(out.ok === false && out.error).toMatch(/delivered to the instance directly/);
    expect(openRefreshToken).not.toHaveBeenCalled();
  });

  it("returns a fresh token refreshed against the grant's OWN registered client, rotation persisted first", async () => {
    const order: string[] = [];
    const refreshAccessToken = vi.fn(
      async (input: { config: { clientId: string } }) => {
        order.push(`refresh:${input.config.clientId}`);
        return { accessToken: "at_1", expiresIn: 3600, refreshToken: "rt_2" };
      },
    );
    const rotateRefreshToken = vi.fn(async (id: string, rt: string) => {
      order.push(`rotate:${id}:${rt}`);
      return true;
    });
    const before = Date.now();
    const out = await realBroker(
      { ...SCOPE, provider: "mayi" },
      okFetch,
      brokerDeps({
        refreshAccessToken: refreshAccessToken as unknown as BrokerDeps["refreshAccessToken"],
        rotateRefreshToken,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.accessToken).toBe("at_1");
    expect(out.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    // The rotated token hit the grant row BEFORE the access token was released — a crash after
    // the refresh but before persistence is the only remaining window, never a happy-path replay.
    expect(order).toEqual(["refresh:mayi_client_1", "rotate:grant_mayi:rt_2"]);
    expect(rotateRefreshToken).toHaveBeenCalledWith("grant_mayi", "rt_2", "iv_1");
  });

  it("does not write the grant when the provider returns no rotation", async () => {
    const rotateRefreshToken = vi.fn(async () => true);
    const out = await realBroker(
      { ...SCOPE, provider: "mayi" },
      okFetch,
      brokerDeps({
        rotateRefreshToken,
        refreshAccessToken: async () => ({ accessToken: "at", expiresIn: 3600 }),
      }),
    );
    expect(out.ok).toBe(true);
    expect(rotateRefreshToken).not.toHaveBeenCalled();
  });

  it("403s with the reconnect message when the agent has no active grant", async () => {
    const out = await realBroker(
      { ...SCOPE, provider: "mayi" },
      okFetch,
      brokerDeps({ openRefreshToken: async () => null }),
    );
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect(out.ok === false && out.error).toMatch(/no active May I\? connection/);
  });

  it("marks a dead grant expired (compare-and-set) and 403s with the reconnect message", async () => {
    const markGrantStatus = vi.fn(async () => {});
    const out = await realBroker(
      { ...SCOPE, provider: "mayi" },
      okFetch,
      brokerDeps({
        markGrantStatus,
        refreshAccessToken: async () => {
          throw new InvalidGrantError("family revoked");
        },
      }),
    );
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect(out.ok === false && out.error).toMatch(/has expired — reconnect/);
    expect(markGrantStatus).toHaveBeenCalledWith("grant_mayi", "expired", "iv_1");
  });

  it("502s on a transient refresh failure without touching the grant", async () => {
    const markGrantStatus = vi.fn(async () => {});
    const out = await realBroker(
      { ...SCOPE, provider: "mayi" },
      okFetch,
      brokerDeps({
        markGrantStatus,
        refreshAccessToken: async () => {
          throw new Error("upstream 500");
        },
      }),
    );
    expect(out).toMatchObject({ ok: false, status: 502 });
    expect(markGrantStatus).not.toHaveBeenCalled();
  });

  it("drops a rotation a concurrent cross-process write beat (retryable 503)", async () => {
    const out = await realBroker(
      { ...SCOPE, provider: "mayi" },
      okFetch,
      brokerDeps({ rotateRefreshToken: async () => false }),
    );
    expect(out).toMatchObject({ ok: false, status: 503 });
    expect(out.ok === false && out.error).toMatch(/retry/);
  });

  it("serializes concurrent refreshes per grant — the second call consumes the FIRST's rotated token", async () => {
    const events: string[] = [];
    let stored = "rt_1";
    let mint = 1;
    const deps = brokerDeps({
      openRefreshToken: async () => {
        events.push(`open:${stored}`);
        return {
          grant: {
            id: "grant_mayi",
            status: "active",
            scopes: "approval:create",
            clientId: "mayi_client_1",
          },
          refreshToken: stored,
          tokenVersion: `iv:${stored}`,
        };
      },
      refreshAccessToken: async (input) => {
        events.push(`refresh:${input.refreshToken}`);
        mint += 1;
        // Yield so an unserialized second call COULD interleave here — the chain must prevent it.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { accessToken: `at_${mint}`, expiresIn: 3600, refreshToken: `rt_${mint}` };
      },
      rotateRefreshToken: async (_id, rt) => {
        events.push(`rotate:${rt}`);
        stored = rt;
        return true;
      },
    });
    const [a, b] = await Promise.all([
      realBroker({ ...SCOPE, provider: "mayi" }, okFetch, deps),
      realBroker({ ...SCOPE, provider: "mayi" }, okFetch, deps),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Strictly sequential: open → refresh → rotate, twice — never two refreshes of one token.
    expect(events).toEqual([
      "open:rt_1",
      "refresh:rt_1",
      "rotate:rt_2",
      "open:rt_2",
      "refresh:rt_2",
      "rotate:rt_3",
    ]);
  });

  it("serializes a broker call against a concurrent DEPLOY validation — one shared per-grant chain", async () => {
    // The scenario the chain exists for: a deployed instance asks the broker for a token while a
    // redeploy validates the same grant. Unserialized, both would read rt_1 and refresh it twice
    // — mayi's family-reuse revocation would kill the grant. The shared chain
    // (refresh-serialization.server.ts) makes the second task re-read and consume the first's
    // rotated token, whichever side wins the race.
    const events: string[] = [];
    let stored = "rt_1";
    let mint = 1;
    const openRefreshToken = async () => {
      events.push(`open:${stored}`);
      return {
        grant: {
          id: "grant_mayi",
          status: "active" as const,
          scopes: "approval:create",
          clientId: "mayi_client_1",
        },
        refreshToken: stored,
        tokenVersion: `iv:${stored}`,
      };
    };
    const refreshAccessToken = async (input: { refreshToken: string }) => {
      events.push(`refresh:${input.refreshToken}`);
      mint += 1;
      // Yield so an unserialized second refresh COULD interleave here — the chain must prevent it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { accessToken: `at_${mint}`, expiresIn: 3600, refreshToken: `rt_${mint}` };
    };
    const rotateRefreshToken = async (_id: string, rt: string) => {
      events.push(`rotate:${rt}`);
      stored = rt;
      return true;
    };
    const deployDeps: ConnectionDeployDeps = {
      getConfig: () => null,
      listGrantsForAgent: async () => [
        { provider: "mayi", status: "active" as const },
      ],
      openRefreshToken,
      markGrantStatus: async () => {},
      rotateRefreshToken,
      refreshAccessToken:
        refreshAccessToken as ConnectionDeployDeps["refreshAccessToken"],
    };
    const [env, brokered] = await Promise.all([
      connectionGrantEnv(
        { ...SCOPE, environmentId: "envabcdefghi" },
        okFetch,
        deployDeps,
      ),
      realBroker(
        { ...SCOPE, provider: "mayi" },
        okFetch,
        brokerDeps({
          openRefreshToken,
          refreshAccessToken:
            refreshAccessToken as BrokerDeps["refreshAccessToken"],
          rotateRefreshToken,
        }),
      ),
    ]);
    expect(brokered.ok).toBe(true);
    expect(env.MAYI_OAUTH_SCOPES).toBe("approval:create");
    // Strictly sequential regardless of which side entered the chain first: the second task
    // opened the FIRST's rotated token — never two refreshes of one stored token.
    expect(events).toEqual([
      "open:rt_1",
      "refresh:rt_1",
      "rotate:rt_2",
      "open:rt_2",
      "refresh:rt_2",
      "rotate:rt_3",
    ]);
  });
});

/* ───────────────────── the /api/connections/token resource action ───────────────────── */

function tokenRequest(body: unknown, authorization?: string): Request {
  return new Request("http://localhost/api/connections/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** react-router `data()` payload/status, whether returned or thrown. */
function unwrap(value: unknown): { payload: unknown; status: number } {
  const d = value as { data: unknown; init?: { status?: number } | null };
  return { payload: d.data, status: d.init?.status ?? 200 };
}

function actionArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
    params: {},
    context: {} as never,
  };
}

describe("POST /api/connections/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.verifyDelegationToken.mockReturnValue("dep_1");
    routeMocks.store.deployments.findById.mockResolvedValue({
      id: "dep_1",
      environmentId: "env_1",
    });
    routeMocks.store.environments.findById.mockResolvedValue({
      id: "env_1",
      agentId: "agnt_1",
    });
    routeMocks.store.agents.findById.mockResolvedValue({
      id: "agnt_1",
      projectId: "proj_1",
    });
    routeMocks.brokerAccessToken.mockResolvedValue({
      ok: true,
      accessToken: "at_1",
      expiresAt: 1_800_000_000_000,
    });
  });

  it("401s a missing or unverifiable bearer token without touching the broker", async () => {
    routeMocks.verifyDelegationToken.mockReturnValue(null);
    const { action } = await import("~/routes/api.connections.token");
    for (const request of [
      tokenRequest({ provider: "mayi" }),
      tokenRequest({ provider: "mayi" }, "Bearer forged"),
    ]) {
      const thrown = await action(actionArgs(request))
        .then(() => null)
        .catch((error) => error);
      expect(unwrap(thrown).status).toBe(401);
    }
    expect(routeMocks.brokerAccessToken).not.toHaveBeenCalled();
  });

  it("400s a non-JSON body and a missing provider", async () => {
    const { action } = await import("~/routes/api.connections.token");
    for (const body of ["not json", {}, { provider: 42 }, { provider: "" }]) {
      const result = await action(actionArgs(tokenRequest(body, "Bearer good")));
      expect(unwrap(result).status).toBe(400);
    }
    expect(routeMocks.brokerAccessToken).not.toHaveBeenCalled();
  });

  it("resolves deployment → environment → agent from the token and brokers for THAT agent", async () => {
    const { action } = await import("~/routes/api.connections.token");
    const result = await action(
      actionArgs(tokenRequest({ provider: "mayi" }, "Bearer good")),
    );
    expect(routeMocks.store.deployments.findById).toHaveBeenCalledWith("dep_1");
    expect(routeMocks.brokerAccessToken).toHaveBeenCalledWith({
      projectId: "proj_1",
      agentId: "agnt_1",
      provider: "mayi",
    });
    expect(unwrap(result)).toEqual({
      payload: { ok: true, accessToken: "at_1", expiresAt: 1_800_000_000_000 },
      status: 200,
    });
  });

  it("403s a token whose deployment no longer resolves to an agent", async () => {
    routeMocks.store.deployments.findById.mockResolvedValue(null);
    const { action } = await import("~/routes/api.connections.token");
    const result = await action(
      actionArgs(tokenRequest({ provider: "mayi" }, "Bearer good")),
    );
    expect(unwrap(result).status).toBe(403);
    expect(routeMocks.brokerAccessToken).not.toHaveBeenCalled();
  });

  it("passes a BrokerResult failure through with its status and readable error", async () => {
    routeMocks.brokerAccessToken.mockResolvedValue({
      ok: false,
      status: 403,
      error: "The May I? connection for this agent has expired — reconnect it.",
    });
    const { action } = await import("~/routes/api.connections.token");
    const result = await action(
      actionArgs(tokenRequest({ provider: "mayi" }, "Bearer good")),
    );
    expect(unwrap(result)).toEqual({
      payload: {
        ok: false,
        error: "The May I? connection for this agent has expired — reconnect it.",
      },
      status: 403,
    });
  });
});
