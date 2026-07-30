/**
 * FOH archive/undo route (app/routes/api.foh.archive.ts) — one endpoint, two directions (#278).
 *
 * The branch that matters: a "still working" refusal is a 200 with `ok: false`, because it is
 * inline copy next to the row, not an error — only an unresolvable session is a 404. Both
 * directions run under the FOH viewer scope, so the person who archived can undo without an
 * admin; the admin flag is passed through as `includeAll`, never assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireFohProject: vi.fn(),
  archiveFohSession: vi.fn(),
  unarchiveFohSessionForViewer: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
}));
vi.mock("~/foh/guard.server", () => ({
  requireFohProject: mocks.requireFohProject,
}));
vi.mock("~/playground/sessions.server", () => ({
  archiveFohSession: mocks.archiveFohSession,
  unarchiveFohSessionForViewer: mocks.unarchiveFohSessionForViewer,
}));
vi.mock("~/chat/turn-stream.server", () => ({
  asString: (value: FormDataEntryValue | null) =>
    typeof value === "string" ? value : "",
}));

import { action } from "~/routes/api.foh.archive";

function actionArgs(form: Record<string, string>) {
  return {
    request: new Request("http://localhost/api/foh/proj_1/archive", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    }),
    params: { projectId: "proj_1" },
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
});

describe("POST /api/foh/:projectId/archive", () => {
  it("archives under the viewer's own scope and names the session for the undo strip", async () => {
    mocks.archiveFohSession.mockResolvedValue({
      ok: true,
      session: { id: "sess_1", title: "Invoice run" },
    });

    const result = await action(actionArgs({ playgroundSessionId: "sess_1" }));

    expect(result).toEqual({
      ok: true,
      intent: "archive",
      sessionId: "sess_1",
      title: "Invoice run",
    });
    expect(mocks.archiveFohSession).toHaveBeenCalledWith({
      id: "sess_1",
      projectId: "proj_1",
      viewerId: "user_1",
      includeAll: false,
    });
  });

  it("widens the scope for an admin/owner", async () => {
    mocks.requireFohProject.mockResolvedValue({
      project: { id: "proj_1" },
      backOfHouse: true,
    });
    mocks.archiveFohSession.mockResolvedValue({
      ok: true,
      session: { id: "sess_1", title: null },
    });

    const result = await action(actionArgs({ playgroundSessionId: "sess_1" }));

    expect(mocks.archiveFohSession).toHaveBeenCalledWith(
      expect.objectContaining({ includeAll: true }),
    );
    expect(result).toMatchObject({ title: "New conversation" });
  });

  it("returns a working refusal as ordinary data, not an error", async () => {
    mocks.archiveFohSession.mockResolvedValue({ ok: false, reason: "working" });

    const result = await action(actionArgs({ playgroundSessionId: "sess_1" }));

    expect(result).toMatchObject({ ok: false, sessionId: "sess_1" });
    expect((result as { error: string }).error).toMatch(/stop it first/i);
  });

  it("404s for a session the viewer cannot resolve", async () => {
    mocks.archiveFohSession.mockResolvedValue({
      ok: false,
      reason: "not_found",
    });

    await expect(
      action(actionArgs({ playgroundSessionId: "sess_hidden" })),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("undoes an archive through the same viewer scope", async () => {
    mocks.unarchiveFohSessionForViewer.mockResolvedValue({
      ok: true,
      session: { id: "sess_1", title: "Invoice run" },
    });

    const result = await action(
      actionArgs({ playgroundSessionId: "sess_1", intent: "unarchive" }),
    );

    expect(result).toEqual({
      ok: true,
      intent: "unarchive",
      sessionId: "sess_1",
      title: "Invoice run",
    });
    expect(mocks.archiveFohSession).not.toHaveBeenCalled();
  });

  it("404s an undo that matches no archived row", async () => {
    mocks.unarchiveFohSessionForViewer.mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    await expect(
      action(
        actionArgs({ playgroundSessionId: "sess_1", intent: "unarchive" }),
      ),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("400s without a session id, and on an intent it does not know", async () => {
    await expect(action(actionArgs({}))).rejects.toMatchObject({
      init: { status: 400 },
    });
    await expect(
      action(actionArgs({ playgroundSessionId: "sess_1", intent: "delete" })),
    ).rejects.toMatchObject({ init: { status: 400 } });
    expect(mocks.archiveFohSession).not.toHaveBeenCalled();
    expect(mocks.unarchiveFohSessionForViewer).not.toHaveBeenCalled();
  });

  it("redirects an unauthenticated post to login without touching the session", async () => {
    mocks.getSessionAuth.mockResolvedValue({ user: null });
    await expect(
      action(actionArgs({ playgroundSessionId: "sess_1" })),
    ).rejects.toMatchObject({ status: 302 });
    expect(mocks.requireFohProject).not.toHaveBeenCalled();
  });
});
