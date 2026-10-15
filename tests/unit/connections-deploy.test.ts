/**
 * Deploy-side connection injection (issues #30, #163). The decision logic, per provider: no config
 * or no active grant → nothing; an active grant → the `<PREFIX>_OAUTH_*` client-creds +
 * refresh-token env trio (after a validating refresh); a dead grant → status marked "expired" and
 * a readable throw so the deploy fails honestly. Providers iterate over the UNION of the agent's
 * grant rows and the lock's required providers; unregistered ids are skipped silently.
 *
 * The registry is mocked to add a second provider ("hubspot") for multi-provider behavior, and a
 * rotating-grant brokered provider ("rotating") for access-token-broker delivery.
 */
import { describe, expect, it, vi } from "vitest";

import { connectionGrantEnv, type ConnectionDeployDeps } from "~/connections/deploy.server";
import { InvalidGrantError } from "~/connections/oauth.server";
import type { ProviderDefinition } from "~/connections/providers.server";

const HUBSPOT: ProviderDefinition = {
  id: "hubspot",
  label: "HubSpot",
  authorizeUrl: "https://app.hubspot.com/oauth/authorize",
  tokenUrl: "https://api.hubapi.com/oauth/v1/token",
  envPrefix: "HUBSPOT",
};

/** A hypothetical rotating-grant provider: brokered delivery, per-grant client registration. */
const ROTATING: ProviderDefinition = {
  id: "rotating",
  label: "Rotating Provider",
  authorizeUrl: "https://auth.rotating.example/oauth/authorize",
  tokenUrl: "https://auth.rotating.example/oauth/token",
  pkce: true,
  envPrefix: "ROTATING",
  tokenEndpointAuth: "none",
  credentialDelivery: "access-token-broker",
  clientRegistration: { endpoint: "https://auth.rotating.example/oauth/register" },
  deployEnv: { ROTATING_KEY_ID: "k1" },
};

vi.mock("~/connections/providers.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/connections/providers.server")>();
  return {
    ...actual,
    getProvider: (id: string) =>
      id === "hubspot"
        ? HUBSPOT
        : id === "rotating"
          ? ROTATING
          : actual.getProvider(id),
    listProviders: () => [...actual.listProviders(), HUBSPOT, ROTATING],
  };
});

const scope = {
  projectId: "projabcdefgh",
  agentId: "agntabcdefgh",
  environmentId: "envabcdefghi",
};
const config = { clientId: "client_1", clientSecret: "secret_1" };
const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

function deps(over: Partial<ConnectionDeployDeps>): ConnectionDeployDeps {
  return {
    getConfig: () => config,
    listGrantsForAgent: async () => [
      { provider: "google", status: "active" as const },
    ],
    openRefreshToken: async () => ({
      grant: {
        id: "grant_1",
        status: "active",
        scopes: "https://www.googleapis.com/auth/spreadsheets",
      },
      refreshToken: "rt",
    }),
    markGrantStatus: async () => {},
    rotateRefreshToken: async () => true,
    refreshAccessToken: async () => ({ accessToken: "at", expiresIn: 3599 }),
    ...over,
  };
}

describe("connectionGrantEnv", () => {
  it("returns {} when no operator config is set", async () => {
    const out = await connectionGrantEnv(scope, okFetch, deps({ getConfig: () => null }));
    expect(out).toEqual({});
  });

  it("returns {} when the agent has no grant", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        listGrantsForAgent: async () => [],
        openRefreshToken: async () => null,
      }),
    );
    expect(out).toEqual({});
  });

  it("returns {} when the grant is not active", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        openRefreshToken: async () => ({
          grant: { id: "g", status: "expired", scopes: "" },
          refreshToken: "rt",
        }),
      }),
    );
    expect(out).toEqual({});
  });

  it("returns the client-creds + refresh-token env (plus granted scopes) for an active grant", async () => {
    const out = await connectionGrantEnv(scope, okFetch, deps({}));
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt",
      GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/spreadsheets",
    });
  });

  it("injects <PREFIX>_OAUTH_SCOPES exactly as stored on the grant row (issue #165)", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        openRefreshToken: async () => ({
          grant: {
            id: "grant_1",
            status: "active",
            scopes:
              "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send openid email",
          },
          refreshToken: "rt",
        }),
      }),
    );
    expect(out.GOOGLE_OAUTH_SCOPES).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send openid email",
    );
  });

  it("marks the grant expired and throws (naming the provider) on invalid_grant", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          markGrantStatus,
          // The expiry flip must be compare-and-set against the token that was TESTED — a
          // reconnect racing the deploy rotates the token version, and the guarded update then
          // no-ops instead of expiring the fresh valid token.
          openRefreshToken: async () => ({
            grant: {
              id: "grant_1",
              status: "active",
              scopes: "https://www.googleapis.com/auth/spreadsheets",
            },
            refreshToken: "rt",
            tokenVersion: "iv_of_tested_token",
          }),
          refreshAccessToken: async () => {
            throw new InvalidGrantError("dead");
          },
        }),
      ),
    ).rejects.toThrow(/The Google connection for this agent has expired/);
    expect(markGrantStatus).toHaveBeenCalledWith(
      "grant_1",
      "expired",
      "iv_of_tested_token",
    );
  });

  it("propagates a transient refresh failure without marking the grant", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          markGrantStatus,
          refreshAccessToken: async () => {
            throw new Error("HTTP 500");
          },
        }),
      ),
    ).rejects.toThrow(/500/);
    expect(markGrantStatus).not.toHaveBeenCalled();
  });

  it("returns the env trio when required scopes are fully covered by the grant (issue #69)", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        openRefreshToken: async () => ({
          grant: {
            id: "grant_1",
            status: "active",
            scopes:
              "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
          },
          refreshToken: "rt",
        }),
      }),
      new Map([["google", ["https://www.googleapis.com/auth/spreadsheets"]]]),
    );
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt",
      GOOGLE_OAUTH_SCOPES:
        "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
    });
  });

  it("throws (without expiring the grant) when required scopes aren't covered (issue #69)", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          markGrantStatus,
          openRefreshToken: async () => ({
            grant: {
              id: "grant_1",
              status: "active",
              scopes: "https://www.googleapis.com/auth/spreadsheets",
            },
            refreshToken: "rt",
          }),
        }),
        new Map([
          [
            "google",
            [
              "https://www.googleapis.com/auth/spreadsheets",
              "https://www.googleapis.com/auth/drive.file",
            ],
          ],
        ]),
      ),
    ).rejects.toThrow(/missing required permission/i);
    // Under-scoped is not dead: the grant stays active.
    expect(markGrantStatus).not.toHaveBeenCalled();
  });

  it("skips the coverage check when requiredScopes is omitted (existing behavior preserved)", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        openRefreshToken: async () => ({
          // Narrow grant that would fail a coverage check — but none is requested.
          grant: { id: "grant_1", status: "active", scopes: "openid" },
          refreshToken: "rt",
        }),
      }),
    );
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt",
      GOOGLE_OAUTH_SCOPES: "openid",
    });
  });

  it("injects every provider with an active grant, under its own env prefix (issue #163)", async () => {
    const hubConfig = { clientId: "hub_client", clientSecret: "hub_secret" };
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        getConfig: (p) => (p.id === "hubspot" ? hubConfig : config),
        listGrantsForAgent: async () => [
          { provider: "google", status: "active" as const },
          { provider: "hubspot", status: "active" as const },
        ],
        openRefreshToken: async ({ provider }) => ({
          grant: { id: `grant_${provider}`, status: "active", scopes: "s" },
          refreshToken: `rt_${provider}`,
        }),
      }),
    );
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt_google",
      GOOGLE_OAUTH_SCOPES: "s",
      HUBSPOT_OAUTH_CLIENT_ID: "hub_client",
      HUBSPOT_OAUTH_CLIENT_SECRET: "hub_secret",
      HUBSPOT_OAUTH_REFRESH_TOKEN: "rt_hubspot",
      HUBSPOT_OAUTH_SCOPES: "s",
    });
  });

  it("skips a lock-required provider that isn't in the registry (issue #163)", async () => {
    const openRefreshToken = vi.fn(
      async ({ provider }: { provider: string }) => ({
        grant: { id: `grant_${provider}`, status: "active" as const, scopes: "s" },
        refreshToken: `rt_${provider}`,
      }),
    );
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({ openRefreshToken }),
      new Map([["notaprovider", ["some.scope"]]]),
    );
    // The unregistered provider never reaches the grant store; google injects normally.
    expect(openRefreshToken).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      GOOGLE_OAUTH_CLIENT_ID: "client_1",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret_1",
      GOOGLE_OAUTH_REFRESH_TOKEN: "rt_google",
      GOOGLE_OAUTH_SCOPES: "s",
    });
  });

  it("names the provider's label in a scope-coverage failure (issue #163)", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          markGrantStatus,
          listGrantsForAgent: async () => [
            { provider: "hubspot", status: "active" as const },
          ],
          openRefreshToken: async () => ({
            grant: { id: "grant_hub", status: "active", scopes: "crm.read" },
            refreshToken: "rt_hub",
          }),
        }),
        new Map([["hubspot", ["crm.read", "crm.write"]]]),
      ),
    ).rejects.toThrow(
      /The HubSpot connection for this agent is missing required permission\(s\): crm\.write/,
    );
    // Under-scoped is not dead: the grant stays active.
    expect(markGrantStatus).not.toHaveBeenCalled();
  });

  it("persists a rotated refresh token from the validation refresh and injects the NEW token (issue #167)", async () => {
    const rotateRefreshToken = vi.fn(async () => true);
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        rotateRefreshToken,
        openRefreshToken: async () => ({
          grant: {
            id: "grant_1",
            status: "active",
            scopes: "https://www.googleapis.com/auth/spreadsheets",
          },
          refreshToken: "rt_old",
          tokenVersion: "iv_old",
        }),
        refreshAccessToken: async () => ({
          accessToken: "at",
          expiresIn: 3599,
          refreshToken: "rt_rotated",
        }),
      }),
    );
    // Persisted BEFORE injection, compare-and-set against the token that was refreshed.
    expect(rotateRefreshToken).toHaveBeenCalledWith("grant_1", "rt_rotated", "iv_old");
    expect(out.GOOGLE_OAUTH_REFRESH_TOKEN).toBe("rt_rotated");
  });

  it("does not touch the grant when the refresh response carries no rotation (google unchanged)", async () => {
    const rotateRefreshToken = vi.fn(async () => true);
    const out = await connectionGrantEnv(scope, okFetch, deps({ rotateRefreshToken }));
    expect(rotateRefreshToken).not.toHaveBeenCalled();
    expect(out.GOOGLE_OAUTH_REFRESH_TOKEN).toBe("rt");
  });

  it("fails the deploy when a concurrent reconnect wins the rotation compare-and-set (issue #167)", async () => {
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          rotateRefreshToken: async () => false,
          refreshAccessToken: async () => ({
            accessToken: "at",
            expiresIn: 3599,
            refreshToken: "rt_rotated",
          }),
        }),
      ),
    ).rejects.toThrow(/reconnected while this deploy was validating/);
  });

  it("brokered delivery: no OAuth trio, scopes + deployEnv constants only (issue #167)", async () => {
    const rotateRefreshToken = vi.fn(async () => true);
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "at",
      expiresIn: 3600,
      refreshToken: "rt_next",
    }));
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        // No operator config exists — the grant carries its registered client.
        getConfig: () => null,
        rotateRefreshToken,
        refreshAccessToken,
        listGrantsForAgent: async () => [
          { provider: "rotating", status: "active" as const },
        ],
        openRefreshToken: async () => ({
          grant: {
            id: "grant_rotating",
            status: "active",
            scopes: "approval:create approval:read approval:cancel",
            clientId: "rotating_client_1",
          },
          refreshToken: "rt_rotating",
          tokenVersion: "iv_rotating",
        }),
      }),
    );
    // The validation refresh ran against the grant's OWN registered client — secretless.
    expect(refreshAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { clientId: "rotating_client_1" },
        refreshToken: "rt_rotating",
      }),
      okFetch,
    );
    // The rotation was persisted even though the refresh token never ships.
    expect(rotateRefreshToken).toHaveBeenCalledWith("grant_rotating", "rt_next", "iv_rotating");
    expect(out).toEqual({
      ROTATING_KEY_ID: "k1",
      ROTATING_OAUTH_SCOPES: "approval:create approval:read approval:cancel",
    });
  });

  it("marks a dead brokered grant expired and fails the deploy with the reconnect message", async () => {
    const markGrantStatus = vi.fn(async () => {});
    await expect(
      connectionGrantEnv(
        scope,
        okFetch,
        deps({
          getConfig: () => null,
          markGrantStatus,
          listGrantsForAgent: async () => [
            { provider: "rotating", status: "active" as const },
          ],
          openRefreshToken: async () => ({
            grant: {
              id: "grant_rotating",
              status: "active",
              scopes: "approval:create",
              clientId: "rotating_client_1",
            },
            refreshToken: "rt_rotating",
            tokenVersion: "iv_rotating",
          }),
          refreshAccessToken: async () => {
            throw new InvalidGrantError("family revoked");
          },
        }),
      ),
    ).rejects.toThrow(/The Rotating Provider connection for this agent has expired/);
    expect(markGrantStatus).toHaveBeenCalledWith("grant_rotating", "expired", "iv_rotating");
  });

  it("skips a registration provider whose grant has no clientId and no operator config", async () => {
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        getConfig: () => null,
        listGrantsForAgent: async () => [
          { provider: "rotating", status: "active" as const },
        ],
        openRefreshToken: async () => ({
          grant: {
            id: "grant_rotating",
            status: "active",
            scopes: "approval:create",
            clientId: null,
          },
          refreshToken: "rt_rotating",
        }),
      }),
    );
    expect(out).toEqual({});
  });

  it("still injects a granted provider the lock no longer requires (grants ∪ lock union)", async () => {
    const hubConfig = { clientId: "hub_client", clientSecret: "hub_secret" };
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        getConfig: (p) => (p.id === "hubspot" ? hubConfig : null),
        listGrantsForAgent: async () => [
          { provider: "hubspot", status: "active" as const },
        ],
        openRefreshToken: async () => ({
          grant: { id: "grant_hub", status: "active", scopes: "s" },
          refreshToken: "rt_hub",
        }),
      }),
      new Map([["google", ["https://www.googleapis.com/auth/spreadsheets"]]]),
    );
    // Google's config is null here → skipped; hubspot rides on its grant row alone.
    expect(out).toEqual({
      HUBSPOT_OAUTH_CLIENT_ID: "hub_client",
      HUBSPOT_OAUTH_CLIENT_SECRET: "hub_secret",
      HUBSPOT_OAUTH_REFRESH_TOKEN: "rt_hub",
      HUBSPOT_OAUTH_SCOPES: "s",
    });
  });

  it("skips a provider whose required scope set is present but EMPTY — every group deselected (issue #173)", async () => {
    // The grants-are-the-authority union means a stored grant normally keeps injecting even when
    // the lock no longer names its provider. An explicitly EMPTY requirement is the exception:
    // the user deselected every permission group, so the deploy must stop shipping the token.
    const openRefreshToken = vi.fn(async () => ({
      grant: { id: "grant_1", status: "active" as const, scopes: "s" },
      refreshToken: "rt",
    }));
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "at",
      expiresIn: 3599,
    }));
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({ openRefreshToken, refreshAccessToken }),
      new Map([["google", []]]),
    );
    expect(out).toEqual({});
    // Skipped entirely: no grant read, no liveness refresh — nothing ships that could use it.
    expect(openRefreshToken).not.toHaveBeenCalled();
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("an empty requirement for one provider doesn't stop another's injection (issue #173)", async () => {
    const hubConfig = { clientId: "hub_client", clientSecret: "hub_secret" };
    const out = await connectionGrantEnv(
      scope,
      okFetch,
      deps({
        getConfig: (p) => (p.id === "hubspot" ? hubConfig : config),
        listGrantsForAgent: async () => [
          { provider: "google", status: "active" as const },
          { provider: "hubspot", status: "active" as const },
        ],
        openRefreshToken: async ({ provider }) => ({
          grant: { id: `grant_${provider}`, status: "active", scopes: "s" },
          refreshToken: `rt_${provider}`,
        }),
      }),
      new Map([
        ["google", []],
        ["hubspot", ["s"]],
      ]),
    );
    expect(out).toEqual({
      HUBSPOT_OAUTH_CLIENT_ID: "hub_client",
      HUBSPOT_OAUTH_CLIENT_SECRET: "hub_secret",
      HUBSPOT_OAUTH_REFRESH_TOKEN: "rt_hubspot",
      HUBSPOT_OAUTH_SCOPES: "s",
    });
  });
});
