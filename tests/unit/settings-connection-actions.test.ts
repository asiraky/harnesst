import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  create: vi.fn(),
  disconnect: vi.fn(),
  remove: vi.fn(),
  removeAlias: vi.fn(),
  list: vi.fn(),
  audit: vi.fn(),
  invalidate: vi.fn(),
  permission: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toast } }));
vi.mock("~/auth/session.server", () => ({
  getSessionAuth: async () => ({
    user: { id: "admin" },
    requestHeaders: new Headers(),
  }),
  sessionLoader: vi.fn(),
}));
vi.mock("~/auth/workspace.server", () => ({
  resolveActiveWorkspace: async () => ({ org: { id: "workspace" } }),
  requireWorkspaceAdmin: vi.fn(),
  ensureWorkspace: vi.fn(),
}));
vi.mock("~/lib/auth.server", () => ({
  auth: { api: { hasPermission: mocks.permission } },
}));
vi.mock("~/models/provider-connections.server", () => ({
  createApiKeyConnection: mocks.create,
  disconnectModelConnection: mocks.disconnect,
  deleteModelConnection: mocks.remove,
  deleteModelConnectionAlias: mocks.removeAlias,
  listModelConnections: mocks.list,
}));
vi.mock("~/managed/audit.server", () => ({ recordAudit: mocks.audit }));
vi.mock("~/deploy/env-reconcile.server", () => ({
  invalidateOrganizationEnvironments: mocks.invalidate,
}));
vi.mock("~/components/model-select", () => ({ ModelSelection: () => null }));
vi.mock("~/components/shell", () => ({
  AppShell: () => null,
  PageHeader: () => null,
  accentText: {},
}));
vi.mock("~/org/workspace.server", () => ({}));
vi.mock("~/models/agent-model-config.server", () => ({}));
vi.mock("~/models/union.server", () => ({}));
vi.mock("~/managed/billing.server", () => ({}));
vi.mock("~/db/queries.server", () => ({}));
vi.mock("~/auth/project-access.server", () => ({}));
vi.mock("~/seams/index.server", () => ({}));

import { action, clientAction } from "~/routes/settings";
function submit(fields: Record<string, string>) {
  const request = new Request("http://localhost/settings/connections.data", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
  return action({
    request,
    params: {},
    context: new RouterContextProvider(),
    url: new URL(request.url),
    pattern: "/settings/connections",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({ success: true });
  mocks.list.mockResolvedValue([
    { id: "existing", provider: "openai", status: "active" },
  ]);
  mocks.disconnect.mockResolvedValue(true);
  mocks.remove.mockResolvedValue(true);
  mocks.removeAlias.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ id: "existing" });
});

describe("Settings connection mutations", () => {
  it("updates a named existing key connection and records renewal", async () => {
    const result = await submit({
      intent: "connect-api-key",
      connectionId: "existing",
      label: "Renamed",
      provider: "openai",
      apiKey: "new-key",
    });
    expect(result).toEqual({ ok: true });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "existing",
        label: "Renamed",
        apiKey: "new-key",
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "model_provider_reauthenticated",
        target: "existing",
      }),
    );
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it("records initial connection separately from renewal", async () => {
    await submit({
      intent: "connect-api-key",
      label: "New",
      provider: "openai",
      apiKey: "new-key",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "model_provider_connected" }),
    );
  });
  it("does not record a disconnection for an unknown ID", async () => {
    const result = await submit({
      intent: "remove-connection",
      connectionId: "missing",
    });
    expect(result).toHaveProperty("error");
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("does not duplicate an audit entry for an already disconnected connection", async () => {
    mocks.disconnect.mockResolvedValue(false);
    await expect(
      submit({ intent: "remove-connection", connectionId: "existing" }),
    ).rejects.toMatchObject({ status: 302 });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("requires confirmation before permanently deleting a connection", async () => {
    expect(
      await submit({ intent: "delete-connection", connectionId: "existing" }),
    ).toHaveProperty("error");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(
      await submit({
        intent: "delete-connection",
        connectionId: "existing",
        confirmed: "yes",
      }),
    ).toEqual({ ok: true, deletedConnection: "existing" });
    expect(mocks.remove).toHaveBeenCalledWith("workspace", "existing");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "model_provider_deleted",
        target: "existing",
      }),
    );
  });
  it("requires confirmation and scopes recovery mapping removal to the workspace", async () => {
    expect(
      await submit({ intent: "delete-connection-alias", oldId: "old" }),
    ).toHaveProperty("error");
    expect(mocks.removeAlias).not.toHaveBeenCalled();
    expect(
      await submit({
        intent: "delete-connection-alias",
        oldId: "old",
        confirmed: "yes",
      }),
    ).toEqual({ ok: true });
    expect(mocks.removeAlias).toHaveBeenCalledWith("workspace", "old");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "model_provider_recovery_removed",
        target: "old",
      }),
    );
  });
  it("rejects unauthorized mutation before validating a provider grant", async () => {
    mocks.permission.mockResolvedValue({ success: false });
    await expect(
      submit({
        intent: "connect-api-key",
        label: "New",
        provider: "openai",
        apiKey: "new-key",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("Settings mutation feedback", () => {
  it("announces successful deletion before returning to revalidation", async () => {
    const result = { ok: true as const, deletedConnection: "existing" };
    const serverAction = vi.fn(async () => result);
    expect(
      await clientAction({ serverAction } as unknown as Parameters<
        typeof clientAction
      >[0]),
    ).toBe(result);
    expect(mocks.toast).toHaveBeenCalledOnce();
  });
  it("does not announce success for a failed deletion", async () => {
    const result = { error: "Unable to delete" };
    const serverAction = vi.fn(async () => result);
    expect(
      await clientAction({ serverAction } as unknown as Parameters<
        typeof clientAction
      >[0]),
    ).toBe(result);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
