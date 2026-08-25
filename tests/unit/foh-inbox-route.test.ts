/**
 * FOH inbox resource route (app/routes/api.foh.inbox.ts): D5 visibility on GET (own +
 * team-wide items within the viewer's scoped projects, enriched with session titles and D14
 * jump paths) and the ownership/tenant guard on POST intent=resolve — another user's personal
 * item and out-of-scope items are unreachable by construction, and only `finished` items are
 * dismissible (question/approval state resolves exclusively at the drain chokepoints).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeStore, type FakeStore } from "../fakes/store";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  resolveActiveWorkspace: vi.fn(),
  listViewerProjectIds: vi.fn(),
  listFohSessionsByIds: vi.fn(),
}));

let store: FakeStore;

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
  sessionLoader: async (
    _args: unknown,
    callback: (context: { auth: unknown }) => Promise<object>,
  ) => {
    const session = (await mocks.getSessionAuth(_args)) as { user: unknown };
    return { ...(await callback({ auth: session })), user: session.user };
  },
}));
vi.mock("~/auth/workspace.server", () => ({
  resolveActiveWorkspace: mocks.resolveActiveWorkspace,
}));
vi.mock("~/foh/sidebar.server", () => ({
  listViewerProjectIds: mocks.listViewerProjectIds,
}));
vi.mock("~/playground/sessions.server", () => ({
  clearSessionPendingInput: vi.fn(async () => {}),
  listFohSessionsByIds: mocks.listFohSessionsByIds,
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: store }),
}));

import { action, loader } from "~/routes/api.foh.inbox";

const SESSION = {
  user: { id: "user_1", email: "member@example.com" },
  requestHeaders: new Headers(),
};

function loaderArgs() {
  return {
    request: new Request("http://localhost/api/foh/inbox"),
    params: {},
    context: {},
  } as never;
}

function actionArgs(form: Record<string, string>) {
  const body = new URLSearchParams(form);
  return {
    request: new Request("http://localhost/api/foh/inbox", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    params: {},
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  store = makeFakeStore();
  store.seedProject({ id: "proj_a", orgId: "org_1" });
  store.seedProject({ id: "proj_b", orgId: "org_1" });
  store.seedAgent({ id: "agent_ivy", projectId: "proj_a", name: "ivy" });
  mocks.getSessionAuth.mockResolvedValue(SESSION);
  mocks.resolveActiveWorkspace.mockResolvedValue({
    org: { id: "org_1", name: "org", slug: "org" },
    member: { id: "m1", organizationId: "org_1", userId: "user_1", role: "member" },
  });
  mocks.listViewerProjectIds.mockResolvedValue(["proj_a"]);
  mocks.listFohSessionsByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, agentId: "agent_ivy", title: `Session ${id}` })),
  );

  store.seedInboxItem({
    id: "i_own",
    projectId: "proj_a",
    sessionId: "sess_1",
    kind: "question",
    prompt: "Sign-in page or notice?",
    agentId: "agent_ivy",
    userId: "user_1",
  });
  store.seedInboxItem({
    id: "i_team",
    projectId: "proj_a",
    sessionId: "sess_2",
    kind: "question",
    agentId: "agent_ivy",
    userId: null,
  });
  store.seedInboxItem({
    id: "i_other",
    projectId: "proj_a",
    sessionId: "sess_3",
    kind: "question",
    agentId: "agent_ivy",
    userId: "user_2",
  });
  store.seedInboxItem({
    id: "i_out_of_scope",
    projectId: "proj_b",
    sessionId: "sess_4",
    kind: "question",
    agentId: "agent_ivy",
    userId: "user_1",
  });
  store.seedInboxItem({
    id: "i_finished_own",
    projectId: "proj_a",
    sessionId: "sess_1",
    kind: "finished",
    agentId: "agent_ivy",
    userId: "user_1",
  });
  store.seedInboxItem({
    id: "i_finished_team",
    projectId: "proj_a",
    sessionId: "sess_2",
    kind: "finished",
    agentId: "agent_ivy",
    userId: null,
  });
});

describe("GET /api/foh/inbox", () => {
  it("lists own + team-wide items within scope, enriched with jump targets", async () => {
    const result = (await loader(loaderArgs())) as {
      items: Array<{ id: string; href: string; sessionTitle: string; agentName: string | null }>;
      count: number;
    };
    expect(new Set(result.items.map((item) => item.id))).toEqual(
      new Set(["i_own", "i_team", "i_finished_own", "i_finished_team"]),
    );
    expect(result.count).toBe(4);
    const own = result.items.find((item) => item.id === "i_own")!;
    expect(own.href).toBe("/t/proj_a/agent_ivy/s/sess_1");
    expect(own.sessionTitle).toBe("Session sess_1");
    expect(own.agentName).toBe("ivy");
  });

  it("returns an empty inbox without a workspace", async () => {
    mocks.resolveActiveWorkspace.mockResolvedValue(null);
    const result = (await loader(loaderArgs())) as { items: unknown[]; count: number };
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  });
});

describe("POST /api/foh/inbox intent=resolve", () => {
  it("resolves the viewer's own finished item", async () => {
    const result = await action(
      actionArgs({ intent: "resolve", itemId: "i_finished_own" }),
    );
    expect(result).toEqual({ ok: true });
    expect(store.getInboxItem("i_finished_own")?.status).toBe("resolved");
  });

  it("resolves a team-wide finished item", async () => {
    const result = await action(
      actionArgs({ intent: "resolve", itemId: "i_finished_team" }),
    );
    expect(result).toEqual({ ok: true });
    expect(store.getInboxItem("i_finished_team")?.status).toBe("resolved");
  });

  it("refuses to resolve a question item — drain chokepoints own that state", async () => {
    const result = await action(actionArgs({ intent: "resolve", itemId: "i_own" }));
    expect(result).toEqual({ ok: false });
    expect(store.getInboxItem("i_own")?.status).toBe("pending");
  });

  it("refuses to resolve a team-wide question item", async () => {
    const result = await action(actionArgs({ intent: "resolve", itemId: "i_team" }));
    expect(result).toEqual({ ok: false });
    expect(store.getInboxItem("i_team")?.status).toBe("pending");
  });

  it("refuses another user's personal item", async () => {
    const result = await action(actionArgs({ intent: "resolve", itemId: "i_other" }));
    expect(result).toEqual({ ok: false });
    expect(store.getInboxItem("i_other")?.status).toBe("pending");
  });

  it("refuses an item outside the viewer's project scope", async () => {
    const result = await action(
      actionArgs({ intent: "resolve", itemId: "i_out_of_scope" }),
    );
    expect(result).toEqual({ ok: false });
    expect(store.getInboxItem("i_out_of_scope")?.status).toBe("pending");
  });
});
