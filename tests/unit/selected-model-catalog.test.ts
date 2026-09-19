import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "~/models/catalog.server";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  ModelSelect,
  selectedCatalogModel,
  type ModelsApiResponse,
} from "~/components/model-select";

const mocks = vi.hoisted(() => ({
  resolveActiveWorkspace: vi.fn(),
  listWorkspaceModelCatalog: vi.fn(),
  findWorkspaceModel: vi.fn(),
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
