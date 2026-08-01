import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireFohProject: vi.fn(),
  agentsFindById: vi.fn(),
  renameFohSession: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
  sessionLoader: vi.fn(),
}));
vi.mock("~/foh/guard.server", () => ({
  requireFohProject: mocks.requireFohProject,
}));
vi.mock("~/playground/sessions.server", () => ({
  countArchivedFohSessions: vi.fn(),
  createPlaygroundSession: vi.fn(),
  listFohSessionsForAgent: vi.fn(),
  renameFohSession: mocks.renameFohSession,
  summarizePlaygroundSession: vi.fn(),
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: { agents: { findById: mocks.agentsFindById } } }),
}));

import { action } from "~/routes/foh.agent";

const AGENT = {
  id: "agent_1",
  projectId: "proj_1",
  name: "ivy",
  kind: "member",
};

function actionArgs(form: Record<string, string>) {
  return {
    request: new Request("http://localhost/t/proj_1/agent_1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    }),
    params: { projectId: "proj_1", agentId: "agent_1" },
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionAuth.mockResolvedValue({ user: { id: "user_1" } });
  mocks.requireFohProject.mockResolvedValue({
    project: { id: "proj_1" },
    backOfHouse: false,
  });
  mocks.agentsFindById.mockResolvedValue(AGENT);
  mocks.renameFohSession.mockResolvedValue({
    id: "sess_1",
    title: "Portal 404 fix",
  });
});

describe("FOH session rename action", () => {
  it("normalizes and saves a title under the viewer's session scope", async () => {
    const result = await action(
      actionArgs({
        intent: "rename-session",
        playgroundSessionId: "sess_1",
        title: "  Portal   404 fix  ",
      }),
    );

    expect(result).toEqual({
      error: null,
      renamed: { id: "sess_1", title: "Portal 404 fix" },
    });
    expect(mocks.renameFohSession).toHaveBeenCalledWith({
      id: "sess_1",
      projectId: "proj_1",
      agentId: "agent_1",
      viewerId: "user_1",
      includeAll: false,
      title: "Portal 404 fix",
    });
  });

  it("does not persist an empty title", async () => {
    const result = await action(
      actionArgs({
        intent: "rename-session",
        playgroundSessionId: "sess_1",
        title: "   ",
      }),
    );

    expect(result).toMatchObject({
      data: { error: "A session title is required." },
      init: { status: 400 },
    });
    expect(mocks.renameFohSession).not.toHaveBeenCalled();
  });

  it("widens the rename scope for admins and reports stale or hidden rows", async () => {
    mocks.requireFohProject.mockResolvedValue({
      project: { id: "proj_1" },
      backOfHouse: true,
    });
    mocks.renameFohSession.mockResolvedValue(null);

    const result = await action(
      actionArgs({
        intent: "rename-session",
        playgroundSessionId: "sess_hidden",
        title: "New title",
      }),
    );

    expect(mocks.renameFohSession).toHaveBeenCalledWith(
      expect.objectContaining({ includeAll: true }),
    );
    expect(result).toMatchObject({
      data: { error: "That session was not found." },
      init: { status: 404 },
    });
  });
});
