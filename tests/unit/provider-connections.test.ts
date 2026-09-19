/**
 * The central token-refresh path (issue #28), `getFreshAccessToken`, against injected deps — no DB.
 * Pins: a still-fresh token short-circuits (zero refresh calls), an expiring token refreshes and
 * persists the rotated refresh token, invalid_grant marks the connection expired + rethrows, a
 * non-active connection throws, and concurrent calls collapse onto a single upstream refresh.
 */
import { describe, expect, it, vi } from "vitest";

import { InvalidGrantError } from "~/connections/codex.server";
import {
  buildProviderDeploymentEnv,
  getFreshAccessToken,
  openApiKeyCredential,
  REFRESH_MARGIN_MS,
  sealApiKeyCredential,
  toDisplayModelConnection,
  type GatewayConnection,
} from "~/models/provider-connections.server";

describe("API-key credential boundary", () => {
  it("seals and opens API keys without retaining plaintext in the stored triplet", () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealApiKeyCredential("sk-provider-secret", key);
    expect(Object.values(sealed)).not.toContain("sk-provider-secret");
    expect(openApiKeyCredential(sealed, key)).toBe("sk-provider-secret");
    expect(
      openApiKeyCredential({ ...sealed, apiKeyAuthTag: null }, key),
    ).toBeNull();
  });

  it("projects database rows to display metadata without any credential fields", () => {
    const display = toDisplayModelConnection({
      id: "abcdefghijkl",
      orgId: "org_1",
      provider: "openai",
      label: "Platform",
      accountEmail: null,
      accountId: null,
      apiKeyCiphertext: "ciphertext",
      apiKeyIv: "iv",
      apiKeyAuthTag: "tag",
      accessTokenCiphertext: null,
      accessTokenIv: null,
      accessTokenAuthTag: null,
      refreshTokenCiphertext: null,
      refreshTokenIv: null,
      refreshTokenAuthTag: null,
      accessTokenExpiresAt: null,
      status: "active",
      createdBy: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      credentialVersion: 0,
      authorizationVersion: 0,
    });
    expect(display).toEqual({
      id: "abcdefghijkl",
      provider: "openai",
      label: "Platform",
      accountEmail: null,
      accountId: null,
      status: "active",
      createdAt: new Date(0),
    });
    expect(display).not.toHaveProperty("apiKeyCiphertext");
    expect(display).not.toHaveProperty("apiKey");
  });
});

describe("buildProviderDeploymentEnv", () => {
  it("emits every exact key and a stable first standard alias per provider", () => {
    const env = buildProviderDeploymentEnv([
      {
        id: "abcdefghijkl",
        orgId: "org_1",
        provider: "anthropic",
        apiKey: "ant-first",
      },
      {
        id: "mnopqrstuvwx",
        orgId: "org_1",
        provider: "anthropic",
        apiKey: "ant-second",
      },
      {
        id: "zyxwvutsrqpo",
        orgId: "org_1",
        provider: "openai",
        apiKey: "openai-first",
      },
    ]);
    expect(env).toEqual({
      HARNESST_PROVIDER_ANTHROPIC_ABCDEFGHIJKL_API_KEY: "ant-first",
      HARNESST_PROVIDER_ANTHROPIC_MNOPQRSTUVWX_API_KEY: "ant-second",
      HARNESST_PROVIDER_OPENAI_ZYXWVUTSRQPO_API_KEY: "openai-first",
      ANTHROPIC_API_KEY: "ant-first",
      OPENAI_API_KEY: "openai-first",
    });
  });

  it("skips malformed ids rather than constructing attacker-controlled env names", () => {
    expect(
      buildProviderDeploymentEnv([
        {
          id: "../../PATH",
          orgId: "org_1",
          provider: "openai",
          apiKey: "secret",
        },
      ]),
    ).toEqual({});
  });
});

const NOW = 1_000_000_000_000;

function conn(overrides: Partial<GatewayConnection> = {}): GatewayConnection {
  return {
    credentialVersion: 0,
    id: "conn_1",
    orgId: "org_1",
    provider: "codex",
    status: "active",
    accountId: "acct_1",
    accessToken: "fresh-access",
    refreshToken: "refresh-1",
    accessTokenExpiresAt: new Date(NOW + 60 * 60 * 1000),
    ...overrides,
  };
}

describe("getFreshAccessToken", () => {
  it("short-circuits a still-fresh token without refreshing", async () => {
    const refresh = vi.fn();
    const result = await getFreshAccessToken("conn_1", {
      load: async () => conn(),
      refresh: refresh as never,
      now: () => NOW,
    });
    expect(result).toEqual({
      credentialVersion: 0,
      accessToken: "fresh-access",
      accountId: "acct_1",
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and persists the rotated refresh token", async () => {
    const persisted: unknown[] = [];
    const result = await getFreshAccessToken("conn_1", {
      load: async () =>
        conn({
          accessTokenExpiresAt: new Date(NOW + REFRESH_MARGIN_MS - 1000),
        }),
      refresh: async () => ({
        accessToken: "new-access",
        refreshToken: "refresh-2",
        idToken: null,
        expiresIn: 3600,
      }),
      persist: async (id, tokens) => {
        persisted.push({ id, tokens });
      },
      now: () => NOW,
    });
    expect(result.accessToken).toBe("new-access");
    expect(persisted).toEqual([
      {
        id: "conn_1",
        tokens: {
          accessToken: "new-access",
          refreshToken: "refresh-2",
          expiresAt: new Date(NOW + 3600 * 1000),
        },
      },
    ]);
  });

  it("marks the connection expired and rethrows on invalid_grant", async () => {
    const marked: Array<[string, string]> = [];
    await expect(
      getFreshAccessToken("conn_1", {
        load: async () => conn({ accessTokenExpiresAt: new Date(NOW - 1000) }),
        refresh: async () => {
          throw new InvalidGrantError("dead");
        },
        markStatus: async (id, status) => {
          marked.push([id, status]);
        },
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect(marked).toEqual([["conn_1", "expired"]]);
  });

  it("throws for a non-active connection without calling refresh", async () => {
    const refresh = vi.fn();
    await expect(
      getFreshAccessToken("conn_1", {
        load: async () => conn({ status: "expired" }),
        refresh: refresh as never,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("collapses concurrent refreshes onto a single upstream call (single-flight)", async () => {
    const refresh = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        accessToken: "shared-access",
        refreshToken: "refresh-2",
        idToken: null,
        expiresIn: 3600,
      };
    });
    const load = async () =>
      conn({ id: "conn_sf", accessTokenExpiresAt: new Date(NOW - 1000) });
    const deps = { load, refresh, persist: async () => {}, now: () => NOW };
    const [a, b] = await Promise.all([
      getFreshAccessToken("conn_sf", deps),
      getFreshAccessToken("conn_sf", deps),
    ]);
    expect(a.accessToken).toBe("shared-access");
    expect(b.accessToken).toBe("shared-access");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("refresh racing credential renewal", () => {
  it.each(["success", "invalid_grant"])(
    "uses the new grant when an old refresh finishes with %s",
    async (outcome) => {
      let current = conn({ accessTokenExpiresAt: new Date(NOW - 1) });
      const persist = vi.fn(async () => false);
      const markStatus = vi.fn(async () => false);
      const result = await getFreshAccessToken(`race-${outcome}`, {
        load: async () => current,
        refresh: async () => {
          current = conn({ credentialVersion: 1, accessToken: "reauthorized" });
          if (outcome === "invalid_grant")
            throw new InvalidGrantError("old grant");
          return {
            accessToken: "stale",
            refreshToken: "stale",
            idToken: null,
            expiresIn: 3600,
          };
        },
        persist,
        markStatus,
        now: () => NOW,
      });
      expect(result.accessToken).toBe("reauthorized");
      expect(current.status).toBe("active");
      if (outcome === "success")
        expect(persist).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Object),
          0,
        );
      else
        expect(markStatus).toHaveBeenCalledWith(
          expect.any(String),
          "expired",
          0,
        );
    },
  );
  it("does not resurrect a connection disconnected during refresh", async () => {
    let current = conn({ accessTokenExpiresAt: new Date(NOW - 1) });
    await expect(
      getFreshAccessToken("race-disconnect", {
        load: async () => current,
        refresh: async () => {
          current = conn({
            credentialVersion: 1,
            status: "revoked",
            accessToken: null,
            refreshToken: null,
          });
          return {
            accessToken: "stale",
            refreshToken: "stale",
            idToken: null,
            expiresIn: 3600,
          };
        },
        persist: async () => false,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });
});
