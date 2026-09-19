import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "~/models/catalog.server";
import { selectedCatalogModel } from "~/components/model-select";

const mocks = vi.hoisted(() => ({
  resolveActiveWorkspace: vi.fn(),
  listWorkspaceModelCatalog: vi.fn(),
  findWorkspaceModel: vi.fn(),
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
