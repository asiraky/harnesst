import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "~/models/catalog.server";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  ModelSelect,
  selectedCatalogModel,
  groupPickerModels,
  type ModelsApiResponse,
} from "~/components/model-select";

const mocks = vi.hoisted(() => ({
  resolveActiveWorkspace: vi.fn(),
  listWorkspaceModelCatalog: vi.fn(),
  findWorkspaceModel: vi.fn(),
  listModelConnections: vi.fn(),
  resolveModelConnectionId: vi.fn(),
  hasPermission: vi.fn(),
  modelResponse: null as ModelsApiResponse | null,
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useFetcher: () => ({
    data: mocks.modelResponse,
    state: "idle",
    load: vi.fn(),
  }),
}));
vi.mock("~/auth/session.server", () => ({
  sessionLoader: (_args: unknown, run: (context: unknown) => unknown) =>
    run({ auth: {} }),
}));
vi.mock("~/auth/workspace.server", () => ({
  resolveActiveWorkspace: mocks.resolveActiveWorkspace,
}));
vi.mock("~/models/union.server", () => ({
  listWorkspaceModelCatalog: mocks.listWorkspaceModelCatalog,
  findWorkspaceModel: mocks.findWorkspaceModel,
}));
vi.mock("~/models/provider-connections.server", () => ({
  listModelConnections: mocks.listModelConnections,
  resolveModelConnectionId: mocks.resolveModelConnectionId,
}));
vi.mock("~/lib/auth.server", () => ({
  auth: { api: { hasPermission: mocks.hasPermission } },
}));
import { loader } from "~/routes/api.models";

const canonical = {
  id: "codex/abcdefghijkl/model",
  supportedEfforts: ["high"],
} as ModelCatalogEntry;
const recovered = { ...canonical, id: "codex/mnopqrstuvwx/model" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveActiveWorkspace.mockResolvedValue({ org: { id: "org_1" } });
  mocks.listWorkspaceModelCatalog.mockResolvedValue({
    models: [canonical],
    unavailable: [],
  });
  mocks.findWorkspaceModel.mockResolvedValue(recovered);
  mocks.listModelConnections.mockResolvedValue([
    {
      id: "abcdefghijkl",
      provider: "codex",
      label: "Account",
      status: "active",
    },
  ]);
  mocks.resolveModelConnectionId.mockResolvedValue("abcdefghijkl");
  mocks.hasPermission.mockResolvedValue({ success: true });
});

async function request(selected: string) {
  return loader({
    request: new Request(
      `http://localhost/api/models?${new URLSearchParams({ selected })}`,
    ),
    params: {},
    context: {},
  } as never);
}

describe("saved model selection metadata", () => {
  it("resolves an old recovered ID separately and keeps new picker choices canonical", async () => {
    const result = await request(recovered.id);
    expect(result).toMatchObject({
      models: [canonical],
      selectedModel: recovered,
      requestedModel: recovered.id,
    });
    expect(mocks.findWorkspaceModel).toHaveBeenCalledWith(
      "org_1",
      recovered.id,
    );
    expect(selectedCatalogModel(result as never, recovered.id)).toBe(recovered);
    expect(
      selectedCatalogModel(result as never, "codex/zzzzzzzzzzzz/other"),
    ).toBeUndefined();
  });

  it("links a disconnected recovered selection to its canonical row and preserves its status", async () => {
    mocks.findWorkspaceModel.mockResolvedValue(null);
    mocks.listModelConnections.mockResolvedValue([
      {
        id: "abcdefghijkl",
        provider: "codex",
        label: "Account",
        status: "revoked",
      },
    ]);
    const result = await request(recovered.id);
    expect(result).toMatchObject({
      selectedModel: null,
      canManageConnections: true,
      selectedConnection: {
        connectionId: "abcdefghijkl",
        status: "revoked",
        settingsUrl: "/settings/connections#connection-abcdefghijkl",
      },
    });
    expect(mocks.resolveModelConnectionId).toHaveBeenCalledWith(
      "org_1",
      "mnopqrstuvwx",
    );
  });

  it("keeps a healthy connection distinct from a failed catalogue", async () => {
    mocks.findWorkspaceModel.mockResolvedValue(null);
    mocks.listWorkspaceModelCatalog.mockResolvedValue({
      models: [],
      unavailable: [
        {
          connectionId: "abcdefghijkl",
          provider: "codex",
          connectionLabel: "Account",
          message: "upstream timeout",
        },
      ],
    });
    expect(await request(recovered.id)).toMatchObject({
      selectedModel: null,
      selectedConnection: { status: "active" },
    });
  });

  it("returns no canonical row link when the connection is outside the active workspace", async () => {
    mocks.findWorkspaceModel.mockResolvedValue(null);
    mocks.listModelConnections.mockResolvedValue([]);
    expect(await request(recovered.id)).toMatchObject({
      selectedConnection: {
        connectionId: null,
        status: "missing",
        settingsUrl: "/settings/connections",
      },
    });
  });

  it("uses the catalog entry for an ordinary selected model without another lookup", async () => {
    const result = await request(canonical.id);
    expect(selectedCatalogModel(result as never, canonical.id)).toBe(canonical);
    expect(mocks.findWorkspaceModel).not.toHaveBeenCalled();
  });

  it("does not resolve other workspaces' missing references", async () => {
    mocks.findWorkspaceModel.mockResolvedValue(null);
    const result = await request(recovered.id);
    expect(selectedCatalogModel(result as never, recovered.id)).toBeUndefined();
    expect(result).toMatchObject({ models: [canonical], selectedModel: null });
  });
});

describe("selected model warning", () => {
  function render() {
    return renderToString(
      createElement(
        MemoryRouter,
        null,
        createElement(ModelSelect, {
          value: recovered.id,
          busy: false,
          onCommit: vi.fn(),
        }),
      ),
    );
  }

  it("does not warn when an existing recovery alias resolved outside the picker union", () => {
    mocks.modelResponse = {
      models: [canonical],
      unavailable: [],
      requestedModel: recovered.id,
      selectedModel: recovered,
    };
    expect(render()).not.toContain(
      `href="/settings/connections#connection-mnopqrstuvwx"`,
    );
  });

  it("offers connection recovery when the current selected reference failed to resolve", () => {
    mocks.modelResponse = {
      models: [canonical],
      unavailable: [],
      requestedModel: recovered.id,
      selectedModel: null,
    };
    expect(render()).toContain(
      `href="/settings/connections#connection-mnopqrstuvwx"`,
    );
  });

  it("links an unavailable recovered selection to its canonical connection instead of the missing alias anchor", () => {
    mocks.modelResponse = {
      models: [],
      unavailable: [],
      requestedModel: recovered.id,
      selectedModel: null,
      canManageConnections: true,
      selectedConnection: {
        connectionId: "abcdefghijkl",
        status: "revoked",
        settingsUrl: "/settings/connections#connection-abcdefghijkl",
      },
    };
    const html = render();
    expect(html).toContain(
      'href="/settings/connections#connection-abcdefghijkl"',
    );
    expect(html).not.toContain(
      'href="/settings/connections#connection-mnopqrstuvwx"',
    );
  });

  it("waits for metadata for a newly selected reference before warning", () => {
    mocks.modelResponse = {
      models: [canonical],
      unavailable: [],
      requestedModel: canonical.id,
      selectedModel: canonical,
    };
    expect(render()).not.toContain(
      `href="/settings/connections#connection-mnopqrstuvwx"`,
    );
  });
});

describe("model picker account groups", () => {
  it("keeps equal labels in distinct identity groups even when their models interleave", () => {
    const one = {
      ...canonical,
      provider: "codex",
      providerName: "Codex",
      connectionLabel: "same@example.test",
      connectionId: "abcdefghijkl",
    } as ModelCatalogEntry;
    const two = {
      ...one,
      id: "codex/mnopqrstuvwx/model",
      connectionId: "mnopqrstuvwx",
    };
    const another = { ...one, id: "codex/abcdefghijkl/other" };
    const groups = groupPickerModels([one, two, another]);
    expect(
      groups.map((group) => group.models.map((model) => model.id)),
    ).toEqual([[one.id, another.id], [two.id]]);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
    expect(new Set(groups.map((group) => group.label)).size).toBe(2);
  });
});
