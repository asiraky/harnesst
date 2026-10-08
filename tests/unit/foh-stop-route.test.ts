/**
 * FOH stop route (app/routes/api.foh.stop.ts). Stop must always end harnesst's side of the turn:
 * a turn on a restarted instance never answers and eve hangs on its cancel, so a stop that
 * depended on eve's confirmation left the conversation stuck as running. Eve's answer only
 * changes what the caller is told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireFohProject: vi.fn(),
  getFohSessionForViewer: vi.fn(),
  markPlaygroundSessionStopped: vi.fn(),
  liveTargets: vi.fn(),
  cancelActiveTurn: vi.fn(),
  resolveInboxForSession: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
}));
vi.mock("~/foh/guard.server", () => ({
  requireFohProject: mocks.requireFohProject,
}));
vi.mock("~/playground/sessions.server", () => ({
  getFohSessionForViewer: mocks.getFohSessionForViewer,
  markPlaygroundSessionStopped: mocks.markPlaygroundSessionStopped,
}));
vi.mock("~/chat/playground.server", () => ({
  liveTargets: mocks.liveTargets,
}));
vi.mock("~/chat/turn-stream.server", () => ({
  asString: (value: FormDataEntryValue | null) =>
    typeof value === "string" ? value : "",
  cancelActiveTurn: mocks.cancelActiveTurn,
}));
vi.mock("~/foh/inbox.server", () => ({
  resolveInboxForSession: mocks.resolveInboxForSession,
}));

import { action } from "~/routes/api.foh.stop";

const target = { url: "http://eve.local", environmentId: "env_1", version: 3 };

function actionArgs() {
  return {
    request: new Request("http://localhost/api/foh/proj_1/stop", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ playgroundSessionId: "ps_1" }),
    }),
    params: { projectId: "proj_1" },
    context: {},
  } as never;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  mocks.getSessionAuth.mockResolvedValue({ user: { id: "user_1" } });
  mocks.requireFohProject.mockResolvedValue({
    project: { id: "proj_1" },
    backOfHouse: false,
  });
  mocks.getFohSessionForViewer.mockResolvedValue({
    id: "ps_1",
    agentId: "agent_1",
    environmentId: "env_1",
    externalSessionId: "eve_1",
  });
  mocks.liveTargets.mockResolvedValue([target]);
  mocks.cancelActiveTurn.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectStoppedLocally() {
  expect(mocks.cancelActiveTurn).toHaveBeenCalledWith("ps_1");
  expect(mocks.markPlaygroundSessionStopped).toHaveBeenCalledWith({
    id: "ps_1",
    target,
  });
  expect(mocks.resolveInboxForSession).toHaveBeenCalledWith("ps_1");
}

describe("POST /api/foh/:projectId/stop", () => {
  it("stops locally and reports a confirmed stop when eve accepts the cancel", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const result = await action(actionArgs());

    expectStoppedLocally();
    expect(result).toMatchObject({ ok: true, eveStopped: true });
  });

  it("still stops locally when eve can't be reached, and says the agent may carry on", async () => {
    fetchMock.mockRejectedValue(new Error("The operation timed out."));

    const result = await action(actionArgs());

    expectStoppedLocally();
    expect(result).toMatchObject({ ok: true, eveStopped: false });
    expect((result as { detail: string }).detail).toMatch(
      /may still finish this turn/,
    );
  });

  it("still stops locally when eve refuses the cancel", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    const result = await action(actionArgs());

    expectStoppedLocally();
    expect(result).toMatchObject({ ok: true, eveStopped: false });
  });
});
