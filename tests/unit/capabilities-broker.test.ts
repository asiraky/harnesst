/**
 * Capability credential handling (issue #166) — the control-plane side that keeps a rotating
 * grant alive under per-call load, and the deploy behavior that keeps the credential OUT of the
 * container:
 *
 *  - `capabilityAccessToken`: serves only `credentialDelivery: "capability"` providers; caches
 *    the access token per grant until shortly before `expiresAt` (Xero burns one rotation per
 *    refresh — refreshing per call would also race concurrent calls); concurrent calls share ONE
 *    refresh (the queued task finds the leader's cached token); sequential calls after expiry
 *    consume the PERSISTED rotated refresh token (two calls succeed against a rotate-on-refresh
 *    fake); a dead grant surfaces the reconnect message and drops the cache entry; a RECONNECT
 *    (the real `upsertGrant`, faked Drizzle) invalidates the cache so the replaced account's
 *    token never serves another call.
 *  - `connectionGrantEnv`: a capability provider's deploy injects NO `<PREFIX>_OAUTH_*` vars —
 *    only the harnesst-owned `HARNESST_CAPABILITY_PROVIDERS` marker — but still liveness-validates the
 *    grant (dead → readable throw), requires the resource binding when the capability declares
 *    one, and fails honestly when the operator OAuth client was removed after an active grant
 *    was made.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capabilityAccessToken,
  clearCapabilityTokenCache,
  type BrokerDeps,
} from "~/connections/broker.server";
import {
  connectionGrantEnv,
  type ConnectionDeployDeps,
} from "~/connections/deploy.server";
import { upsertGrant } from "~/connections/grants.server";
import { InvalidGrantError } from "~/connections/oauth.server";

// upsertGrant persists through Drizzle — faked here so the reconnect-invalidation test can drive
// the REAL grant writer (the cache invalidation lives inside it) without a database.
const dbMocks = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("~/db/client.server", () => ({ db: { insert: dbMocks.insert } }));

const SCOPE = { projectId: "projabcdefgh", agentId: "agntabcdefgh" };
const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

const XERO_SCOPES =
  "offline_access accounting.invoices accounting.contacts accounting.settings.read accounting.attachments";

function brokerDeps(over: Partial<BrokerDeps>): BrokerDeps {
  return {
    getConfig: () => ({ clientId: "xero_client", clientSecret: "xero_secret" }),
    openRefreshToken: async () => ({
      grant: { id: "grant_xero", status: "active", scopes: XERO_SCOPES, clientId: null },
      refreshToken: "rt_1",
      tokenVersion: "iv_1",
    }),
    markGrantStatus: async () => {},
    rotateRefreshToken: async () => true,
    refreshAccessToken: async () => ({
      accessToken: "at_1",
      expiresIn: 1800,
      refreshToken: "rt_2",
    }),
    ...over,
  };
}

/** A rotate-on-refresh Xero fake: single-use refresh tokens, reuse kills the family (#167). */
function rotatingXero() {
  let stored = "rt_1";
  const spent = new Set<string>();
  let mint = 1;
  const events: string[] = [];
  const deps = brokerDeps({
    openRefreshToken: async () => {
      events.push(`open:${stored}`);
      return {
        grant: { id: "grant_xero", status: "active", scopes: XERO_SCOPES, clientId: null },
        refreshToken: stored,
        tokenVersion: `iv:${stored}`,
      };
    },
    refreshAccessToken: async (input) => {
      if (spent.has(input.refreshToken)) {
        // Family-reuse revocation — the exact failure the persistence discipline prevents.
        throw new InvalidGrantError("refresh token reuse — family revoked");
      }
      spent.add(input.refreshToken);
      events.push(`refresh:${input.refreshToken}`);
      mint += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { accessToken: `at_${mint}`, expiresIn: 1800, refreshToken: `rt_${mint}` };
    },
    rotateRefreshToken: async (_id, rt) => {
      events.push(`rotate:${rt}`);
      stored = rt;
      return true;
    },
  });
  return { deps, events };
}

afterEach(() => {
  clearCapabilityTokenCache();
});

describe("capabilityAccessToken", () => {
  it("refuses an unknown provider and every non-capability delivery (google, mayi)", async () => {
    for (const provider of ["notaprovider", "google", "mayi"]) {
      const out = await capabilityAccessToken(
        { ...SCOPE, provider },
        okFetch,
        brokerDeps({}),
      );
      expect(out).toMatchObject({ ok: false, status: 404 });
    }
  });

  it("persists the rotation BEFORE releasing the token, so two sequential refreshes both succeed against a rotate-on-refresh provider", async () => {
    const { deps, events } = rotatingXero();
    let clock = Date.now();
    const now = () => clock;

    const first = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps, now);
    expect(first.ok).toBe(true);
    // Force the cache stale: the second call MUST refresh — and must consume rt_2, not rt_1.
    clock += 1801 * 1000;
    const second = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps, now);
    expect(second.ok).toBe(true);
    expect(events).toEqual([
      "open:rt_1",
      "refresh:rt_1",
      "rotate:rt_2",
      "open:rt_2",
      "refresh:rt_2",
      "rotate:rt_3",
    ]);
  });

  it("caches the access token until shortly before expiresAt — a second call spends NO rotation", async () => {
    const { deps, events } = rotatingXero();
    const first = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps);
    const second = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.accessToken).toBe(first.accessToken);
    expect(events.filter((e) => e.startsWith("refresh:"))).toEqual(["refresh:rt_1"]);
  });

  it("shares ONE refresh across concurrent calls — the queued task finds the leader's token in the cache", async () => {
    const { deps, events } = rotatingXero();
    const [a, b, c] = await Promise.all([
      capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps),
      capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps),
      capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(b.accessToken).toBe(a.accessToken);
    expect(c.accessToken).toBe(a.accessToken);
    // Exactly one rotation for three calls — the whole point of the control-plane cache.
    expect(events.filter((e) => e.startsWith("refresh:"))).toEqual(["refresh:rt_1"]);
  });

  it("keeps caches per grant scope — another agent's token is never served", async () => {
    const { deps } = rotatingXero();
    const a = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps);
    const b = await capabilityAccessToken(
      { projectId: SCOPE.projectId, agentId: "agntdifferent", provider: "xero" },
      okFetch,
      deps,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.accessToken).not.toBe(a.accessToken);
  });

  it("invalidates the cached token when the grant is replaced — a reconnect's account is honored at the very next call", async () => {
    const OLD_KEY = process.env.HARNESST_SECRETS_KEY;
    process.env.HARNESST_SECRETS_KEY = "a".repeat(64);
    dbMocks.insert.mockReturnValue({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [
            {
              id: "grant_xero",
              projectId: SCOPE.projectId,
              agentId: SCOPE.agentId,
              environmentId: null,
              provider: "xero",
              accountEmail: "new@acme.example",
              scopes: XERO_SCOPES,
              status: "active",
              clientId: null,
              resourceId: "tenant-2",
              resourceName: "New Org",
              createdAt: new Date(),
            },
          ],
        }),
      }),
    });
    try {
      const { deps, events } = rotatingXero();
      const first = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps);
      expect(first.ok).toBe(true);
      // The installer reconnects Xero (possibly as a DIFFERENT account) — the real grant writer.
      await upsertGrant({
        projectId: SCOPE.projectId,
        agentId: SCOPE.agentId,
        provider: "xero",
        accountEmail: "new@acme.example",
        scopes: XERO_SCOPES,
        refreshToken: "rt_new",
      });
      // The next call must NOT ride the old account's still-live token: it refreshes again.
      const second = await capabilityAccessToken({ ...SCOPE, provider: "xero" }, okFetch, deps);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.accessToken).not.toBe(first.accessToken);
      expect(events.filter((e) => e.startsWith("refresh:"))).toHaveLength(2);
    } finally {
      if (OLD_KEY === undefined) delete process.env.HARNESST_SECRETS_KEY;
      else process.env.HARNESST_SECRETS_KEY = OLD_KEY;
    }
  });

  it("surfaces a dead grant with the reconnect message and drops the cache entry", async () => {
    const markGrantStatus = vi.fn(async () => {});
    const out = await capabilityAccessToken(
      { ...SCOPE, provider: "xero" },
      okFetch,
      brokerDeps({
        markGrantStatus,
        refreshAccessToken: async () => {
          throw new InvalidGrantError("expired after 60 days");
        },
      }),
    );
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect(out.ok === false && out.error).toMatch(/Xero connection.*expired — reconnect/);
    expect(markGrantStatus).toHaveBeenCalledWith("grant_xero", "expired", "iv_1");
  });
});

/* ─────────────────────────── deploy behavior for capability providers ─────────────────────────── */

const deployScope = { ...SCOPE, environmentId: "envabcdefghi" };

function deployDeps(over: Partial<ConnectionDeployDeps>): ConnectionDeployDeps {
  return {
    getConfig: () => ({ clientId: "xero_client", clientSecret: "xero_secret" }),
    listGrantsForAgent: async () => [{ provider: "xero", status: "active" as const }],
    openRefreshToken: async () => ({
      grant: {
        id: "grant_xero",
        status: "active",
        scopes: XERO_SCOPES,
        resourceId: "tenant-1",
      },
      refreshToken: "rt_1",
      tokenVersion: "iv_1",
    }),
    markGrantStatus: async () => {},
    rotateRefreshToken: async () => true,
    refreshAccessToken: async () => ({
      accessToken: "at_1",
      expiresIn: 1800,
      refreshToken: "rt_2",
    }),
    ...over,
  };
}

describe("connectionGrantEnv — capability delivery (issue #166)", () => {
  it("injects NO XERO_OAUTH_* vars — only the harnesst-owned capability marker", async () => {
    const out = await connectionGrantEnv(deployScope, okFetch, deployDeps({}));
    expect(Object.keys(out).filter((k) => k.startsWith("XERO"))).toEqual([]);
    expect(out).toEqual({ HARNESST_CAPABILITY_PROVIDERS: "xero" });
  });

  it("still liveness-validates the grant with the rotation persisted (harnesst stays the single writer)", async () => {
    const order: string[] = [];
    const rotateRefreshToken = vi.fn(async (_id: string, rt: string) => {
      order.push(`rotate:${rt}`);
      return true;
    });
    const out = await connectionGrantEnv(
      deployScope,
      okFetch,
      deployDeps({ rotateRefreshToken }),
    );
    expect(rotateRefreshToken).toHaveBeenCalledWith("grant_xero", "rt_2", "iv_1");
    // The rotated token was persisted — and still nothing credential-shaped got injected.
    expect(out).toEqual({ HARNESST_CAPABILITY_PROVIDERS: "xero" });
  });

  it("fails the deploy honestly on a dead grant (marked expired, readable reconnect throw)", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        deployScope,
        okFetch,
        deployDeps({
          markGrantStatus,
          refreshAccessToken: async () => {
            throw new InvalidGrantError("dead");
          },
        }),
      ),
    ).rejects.toThrow(/The Xero connection for this agent has expired/);
    expect(markGrantStatus).toHaveBeenCalledWith("grant_xero", "expired", "iv_1");
  });

  it("fails the deploy when the capability's resource binding is missing (unbound grant is unusable)", async () => {
    await expect(
      connectionGrantEnv(
        deployScope,
        okFetch,
        deployDeps({
          openRefreshToken: async () => ({
            grant: {
              id: "grant_xero",
              status: "active",
              scopes: XERO_SCOPES,
              resourceId: null,
            },
            refreshToken: "rt_1",
            tokenVersion: "iv_1",
          }),
        }),
      ),
    ).rejects.toThrow(/isn't bound to an organisation/);
  });

  it("fails the deploy honestly when an ACTIVE capability grant has no operator OAuth client (config removed after connect)", async () => {
    await expect(
      connectionGrantEnv(deployScope, okFetch, deployDeps({ getConfig: () => null })),
    ).rejects.toThrow(/no Xero OAuth client configured.*HARNESST_XERO_CLIENT_ID/);
  });

  it("still skips silently when the operator config is missing and no ACTIVE capability grant exists", async () => {
    const out = await connectionGrantEnv(
      deployScope,
      okFetch,
      deployDeps({
        getConfig: () => null,
        listGrantsForAgent: async () => [{ provider: "xero", status: "expired" as const }],
      }),
    );
    expect(out).toEqual({});
  });

  it("leaves refresh-token providers byte-identical (google regression)", async () => {
    const out = await connectionGrantEnv(
      deployScope,
      okFetch,
      deployDeps({
        listGrantsForAgent: async () => [{ provider: "google", status: "active" as const }],
        openRefreshToken: async () => ({
          grant: {
            id: "grant_g",
            status: "active",
            scopes: "https://www.googleapis.com/auth/spreadsheets",
          },
          refreshToken: "rt_g",
        }),
        refreshAccessToken: async () => ({ accessToken: "at", expiresIn: 3599 }),
      }),
    );
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "xero_client",
      GOOGLE_OAUTH_CLIENT_SECRET: "xero_secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt_g",
      GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/spreadsheets",
    });
    expect(out.HARNESST_CAPABILITY_PROVIDERS).toBeUndefined();
  });
});
