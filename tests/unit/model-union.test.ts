import { describe, expect, it, vi } from "vitest";

import type { ModelCatalogEntry } from "~/models/catalog.server";
import type {
  ApiKeyConnectionSecret,
  ModelConnection,
} from "~/models/provider-connections.server";
import type { ModelProviderId } from "~/models/provider-reference";
import {
  findWorkspaceModel,
  listWorkspaceModelCatalog,
  listWorkspaceModels,
  ownsWorkspaceModelReference,
  qualifyConnectionCatalog,
  type WorkspaceModelDeps,
} from "~/models/union.server";

const IDS = {
  anthropic: "abcdefghijkl",
  codex: "mnopqrstuvwx",
  openrouter: "zyxwvutsrqpo",
} as const;

function connection(
  provider: ModelProviderId,
  overrides: Partial<ModelConnection> = {},
): ModelConnection {
  return {
    id: IDS[provider as keyof typeof IDS] ?? "aaaaaaaaaaaa",
    provider,
    label: `${provider} work`,
    accountEmail: provider === "codex" ? "me@example.com" : null,
    status: "active",
    createdAt: new Date(0),
    ...overrides,
  };
}

function rawModel(id: string, name = id): ModelCatalogEntry {
  return {
    id,
    name,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    tags: [],
    inputPerMTok: null,
    outputPerMTok: null,
    providers: [],
    upstreamModelId: id,
  };
}

function deps(
  input: {
    connections?: ModelConnection[];
    catalogs?: Partial<Record<ModelProviderId, ModelCatalogEntry[] | Error>>;
    missingKeyIds?: string[];
  } = {},
): WorkspaceModelDeps {
  const connections = input.connections ?? [];
  return {
    listConnections: async () => connections,
    getConnection: async (_orgId, id) =>
      connections.find((item) => item.id === id) ?? null,
    getApiKey: async (orgId, id): Promise<ApiKeyConnectionSecret | null> => {
      const item = connections.find((candidate) => candidate.id === id);
      if (
        !item ||
        item.provider === "codex" ||
        input.missingKeyIds?.includes(id)
      ) {
        return null;
      }
      return { id, orgId, provider: item.provider, apiKey: `key-${id}` };
    },
    listProvider: async (provider, apiKey) => {
      if (provider !== "codex") expect(apiKey).toMatch(/^key-/);
      const value = input.catalogs?.[provider] ?? [];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe("qualifyConnectionCatalog", () => {
  it("adds exact provider/connection ownership while preserving the native model name", () => {
    const conn = connection("openrouter");
    const [model] = qualifyConnectionCatalog(conn, [
      rawModel("anthropic/claude-sonnet-5", "Claude Sonnet 5"),
    ]);
    expect(model).toMatchObject({
      id: "openrouter/zyxwvutsrqpo/anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      provider: "openrouter",
      providerName: "OpenRouter",
      connectionId: IDS.openrouter,
      connectionLabel: "openrouter work",
      upstreamModelId: "anthropic/claude-sonnet-5",
      providers: ["openrouter"],
    });
  });

  it("includes Codex account display metadata without exposing a credential", () => {
    const [model] = qualifyConnectionCatalog(connection("codex"), [
      rawModel("gpt-5.4", "GPT-5.4"),
    ]);
    expect(model.description).toContain("me@example.com");
    expect(model).not.toHaveProperty("apiKey");
    expect(model).not.toHaveProperty("accessToken");
  });
});

describe("listWorkspaceModelCatalog", () => {
  it("returns the connected-provider union using each exact API key", async () => {
    const connections = [connection("anthropic"), connection("codex")];
    const listProvider = vi.fn(
      async (provider: ModelProviderId, apiKey: string | null) => {
        if (provider === "anthropic")
          expect(apiKey).toBe(`key-${IDS.anthropic}`);
        if (provider === "codex") expect(apiKey).toBeNull();
        return [rawModel(provider === "codex" ? "gpt-5.4" : "claude-sonnet-5")];
      },
    );
    const injected = deps({ connections });
    injected.listProvider = listProvider;
    const result = await listWorkspaceModelCatalog("org_1", injected);
    expect(result.unavailable).toEqual([]);
    expect(result.models.map((model) => model.id)).toEqual([
      `anthropic/${IDS.anthropic}/claude-sonnet-5`,
      `codex/${IDS.codex}/gpt-5.4`,
    ]);
    expect(listProvider).toHaveBeenCalledTimes(2);
  });

  it("keeps duplicate upstream models distinct and in stable same-provider connection order", async () => {
    const first = connection("anthropic", {
      id: "aaaaaaaaaaaa",
      label: "First account",
    });
    const second = connection("anthropic", {
      id: "bbbbbbbbbbbb",
      label: "Second account",
    });
    const result = await listWorkspaceModelCatalog(
      "org_1",
      deps({
        connections: [first, second],
        catalogs: { anthropic: [rawModel("claude-sonnet-5")] },
      }),
    );
    expect(result.models.map((model) => model.id)).toEqual([
      "anthropic/aaaaaaaaaaaa/claude-sonnet-5",
      "anthropic/bbbbbbbbbbbb/claude-sonnet-5",
    ]);
    expect(result.models.map((model) => model.connectionLabel)).toEqual([
      "First account",
      "Second account",
    ]);
  });

  it("isolates a failed connection and reports availability metadata", async () => {
    const connections = [connection("anthropic"), connection("codex")];
    const result = await listWorkspaceModelCatalog(
      "org_1",
      deps({
        connections,
        catalogs: {
          anthropic: new Error("Anthropic rejected the credential (HTTP 401)."),
          codex: [rawModel("gpt-5.4")],
        },
      }),
    );
    expect(result.models.map((model) => model.id)).toEqual([
      `codex/${IDS.codex}/gpt-5.4`,
    ]);
    expect(result.unavailable).toEqual([
      {
        connectionId: IDS.anthropic,
        provider: "anthropic",
        connectionLabel: "anthropic work",
        message: "Anthropic rejected the credential (HTTP 401).",
      },
    ]);
  });

  it("distinguishes no connections from provider failure and never falls back", async () => {
    await expect(listWorkspaceModelCatalog("org_1", deps())).resolves.toEqual({
      models: [],
      unavailable: [],
    });
    await expect(listWorkspaceModels("org_1", deps())).resolves.toEqual([]);
  });
});

describe("findWorkspaceModel", () => {
  const anthropic = connection("anthropic");
  const injected = deps({
    connections: [anthropic],
    catalogs: { anthropic: [rawModel("claude-sonnet-5")] },
  });

  it("resolves a known model only through its active owned connection", async () => {
    const id = `anthropic/${IDS.anthropic}/claude-sonnet-5`;
    await expect(
      findWorkspaceModel("org_1", id, injected),
    ).resolves.toMatchObject({
      id,
      connectionId: IDS.anthropic,
      provider: "anthropic",
    });
  });

  it("rejects malformed, missing, provider-mismatched, and unknown model references", async () => {
    await expect(
      findWorkspaceModel("org_1", "claude-sonnet-5", injected),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceModel("org_1", "anthropic/short/claude-sonnet-5", injected),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceModel("org_1", `openai/${IDS.anthropic}/gpt-5.4`, injected),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceModel(
        "org_1",
        `anthropic/${IDS.anthropic}/does-not-exist`,
        injected,
      ),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceModel(
        "org_1",
        "anthropic/aaaaaaaaaaaa/claude-sonnet-5",
        injected,
      ),
    ).resolves.toBeNull();
  });
});

describe("ownsWorkspaceModelReference", () => {
  it("checks active org connection ownership without fetching a provider catalog", async () => {
    const anthropic = connection("anthropic");
    const injected = deps({ connections: [anthropic] });
    injected.listProvider = vi.fn();

    await expect(
      ownsWorkspaceModelReference(
        "org_1",
        `anthropic/${IDS.anthropic}/claude-sonnet-5`,
        injected,
      ),
    ).resolves.toBe(true);
    await expect(
      ownsWorkspaceModelReference(
        "org_1",
        `openai/${IDS.anthropic}/gpt-5.4`,
        injected,
      ),
    ).resolves.toBe(false);
    expect(injected.listProvider).not.toHaveBeenCalled();
  });
});

describe("connection ownership versus model availability", () => {
  it.each([[], new Error("Provider offline")])(
    "keeps healthy connection ownership when its catalog is missing or unavailable",
    async (catalog) => {
      const injected = deps({
        connections: [connection("codex")],
        catalogs: { codex: catalog },
      });
      const model = `codex/${IDS.codex}/missing-model`;
      await expect(
        findWorkspaceModel("org_1", model, injected),
      ).resolves.toBeNull();
      await expect(
        ownsWorkspaceModelReference("org_1", model, injected),
      ).resolves.toBe(true);
    },
  );
});
