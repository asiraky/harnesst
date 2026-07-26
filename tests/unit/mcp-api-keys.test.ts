import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ednBearerToken,
  hashEdnToken,
  isEdnToken,
  mintEdnToken,
} from "~/auth/edn-token.server";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
  type ApiKeyAdminDeps,
  type ApiKeyVerifierDeps,
  type McpScope,
} from "~/mcp/api-keys.server";

const NOW = new Date("2026-07-14T00:00:00.000Z");
const TOKEN = "edn_abcdefghijklmnopqrstuvwx12345678";

function record(overrides: Record<string, unknown> = {}) {
  return {
    keyId: "key_1",
    orgId: "org_1",
    userId: "user_1",
    scopes: ["read", "deploy"] as McpScope[],
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  };
}

function verifierDeps(
  overrides: Partial<ApiKeyVerifierDeps> = {},
): ApiKeyVerifierDeps {
  return {
    now: () => NOW,
    findByTokenHash: vi.fn().mockResolvedValue(record()),
    hasMembership: vi.fn().mockResolvedValue(true),
    markUsed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("shared opaque harnesst tokens", () => {
  it("mints the existing edn_ format with 192 bits of random payload", () => {
    const token = mintEdnToken();
    expect(token).toMatch(/^edn_[A-Za-z0-9_-]{32}$/);
    expect(isEdnToken(token)).toBe(true);
  });

  it("hashes credentials deterministically without retaining plaintext", () => {
    expect(hashEdnToken(TOKEN)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashEdnToken(TOKEN)).toBe(hashEdnToken(TOKEN));
    expect(hashEdnToken(`${TOKEN}x`)).not.toBe(hashEdnToken(TOKEN));
  });

  it("retains the ingest endpoint's exact Bearer parsing behavior", () => {
    expect(
      ednBearerToken(
        new Request("https://harnesst.test/api/ingest/runs", {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      ),
    ).toBe(TOKEN);
    expect(
      ednBearerToken(
        new Request("https://harnesst.test/api/ingest/runs", {
          headers: { authorization: `bearer ${TOKEN}` },
        }),
      ),
    ).toBeNull();
  });
});

describe("MCP API key verification", () => {
  let deps: ApiKeyVerifierDeps;

  beforeEach(() => {
    deps = verifierDeps();
  });

  it("returns tenant identity and records use for a live, scoped member key", async () => {
    await expect(
      verifyApiKey(`Bearer ${TOKEN}`, "read", deps),
    ).resolves.toEqual({
      keyId: "key_1",
      orgId: "org_1",
      userId: "user_1",
      scopes: ["read", "deploy"],
    });
    expect(deps.findByTokenHash).toHaveBeenCalledWith(hashEdnToken(TOKEN));
    expect(deps.hasMembership).toHaveBeenCalledWith("org_1", "user_1");
    expect(deps.markUsed).toHaveBeenCalledWith("key_1", NOW);
  });

  it("supports requiring every scope in a set", async () => {
    await expect(
      verifyApiKey(`Bearer ${TOKEN}`, ["read", "deploy"], deps),
    ).resolves.toMatchObject({ keyId: "key_1" });
  });

  it("rejects malformed and non-harnesst credentials before database lookup", async () => {
    await expect(verifyApiKey(null, "read", deps)).resolves.toBeNull();
    await expect(verifyApiKey(TOKEN, "read", deps)).resolves.toBeNull();
    await expect(
      verifyApiKey("Bearer other_token", "read", deps),
    ).resolves.toBeNull();
    await expect(
      verifyApiKey("Bearer edn_short", "read", deps),
    ).resolves.toBeNull();
    expect(deps.findByTokenHash).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", null],
    ["revoked", record({ revokedAt: new Date("2026-07-01T00:00:00.000Z") })],
    ["expired", record({ expiresAt: NOW })],
  ])("rejects a %s key", async (_label, found) => {
    deps = verifierDeps({ findByTokenHash: vi.fn().mockResolvedValue(found) });
    await expect(
      verifyApiKey(`Bearer ${TOKEN}`, "read", deps),
    ).resolves.toBeNull();
    expect(deps.markUsed).not.toHaveBeenCalled();
  });

  it("rejects a key without the required scope", async () => {
    deps = verifierDeps({
      findByTokenHash: vi.fn().mockResolvedValue(record({ scopes: ["read"] })),
    });
    await expect(
      verifyApiKey(`Bearer ${TOKEN}`, "deploy", deps),
    ).resolves.toBeNull();
    expect(deps.hasMembership).not.toHaveBeenCalled();
    expect(deps.markUsed).not.toHaveBeenCalled();
  });

  it("rejects a key after its issuing user leaves the organization", async () => {
    deps = verifierDeps({ hasMembership: vi.fn().mockResolvedValue(false) });
    await expect(
      verifyApiKey(`Bearer ${TOKEN}`, "read", deps),
    ).resolves.toBeNull();
    expect(deps.markUsed).not.toHaveBeenCalled();
  });
});

describe("MCP API key administration", () => {
  function adminDeps(
    overrides: Partial<ApiKeyAdminDeps> = {},
  ): ApiKeyAdminDeps {
    return {
      now: () => NOW,
      mintToken: vi.fn(() => TOKEN),
      hasMembership: vi.fn().mockResolvedValue(true),
      insert: vi.fn().mockResolvedValue({ id: "key_1" }),
      list: vi.fn().mockResolvedValue([]),
      revoke: vi.fn().mockResolvedValue({ id: "key_1", name: "terminal" }),
      audit: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("returns plaintext once while storing and auditing only safe metadata", async () => {
    const deps = adminDeps();
    await expect(
      createApiKey(
        {
          orgId: "org_1",
          userId: "user_1",
          name: "terminal",
          scopes: ["read", "deploy"],
        },
        deps,
      ),
    ).resolves.toEqual({ id: "key_1", token: TOKEN });

    expect(deps.insert).toHaveBeenCalledWith({
      orgId: "org_1",
      userId: "user_1",
      name: "terminal",
      tokenHash: hashEdnToken(TOKEN),
      scopes: ["read", "deploy"],
      expiresAt: null,
    });
    expect(JSON.stringify(vi.mocked(deps.insert).mock.calls)).not.toContain(
      TOKEN,
    );
    expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).not.toContain(
      TOKEN,
    );
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.created",
        target: "key_1",
        meta: expect.objectContaining({
          name: "terminal",
          scopes: ["read", "deploy"],
        }),
      }),
    );
  });

  it("requires current membership before minting or persisting a key", async () => {
    const deps = adminDeps({ hasMembership: vi.fn().mockResolvedValue(false) });
    await expect(
      createApiKey(
        {
          orgId: "org_1",
          userId: "user_1",
          name: "terminal",
          scopes: ["read"],
        },
        deps,
      ),
    ).rejects.toThrow(/not a member/i);
    expect(deps.mintToken).not.toHaveBeenCalled();
    expect(deps.insert).not.toHaveBeenCalled();
  });

  it("lists metadata and revokes only through the supplied org-scoped repository", async () => {
    const metadata = {
      id: "key_1",
      userId: "user_1",
      name: "terminal",
      scopes: ["read" as const],
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: NOW,
    };
    const deps = adminDeps({ list: vi.fn().mockResolvedValue([metadata]) });

    await expect(listApiKeys("org_1", deps)).resolves.toEqual([metadata]);
    expect(deps.list).toHaveBeenCalledWith("org_1");
    await expect(
      revokeApiKey(
        { orgId: "org_1", apiKeyId: "key_1", actorUserId: "user_1" },
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.revoke).toHaveBeenCalledWith("org_1", "key_1", NOW);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "api_key.revoked", target: "key_1" }),
    );
  });
});
