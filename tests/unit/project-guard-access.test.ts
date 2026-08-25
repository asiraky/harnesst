/**
 * `requireProjectAccess` (app/project/guard.server.ts) — THE per-repo chokepoint. Owners are
 * implicit `write`; everyone else needs a grant; no grant is a 404 (never reveal the repo);
 * a read-only viewer hitting a write surface is redirected home on page loads and 403'd on
 * API calls; `requireProject` is the write shorthand and `requireFohProject` the read one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveActiveWorkspace: vi.fn(),
  ensureWorkspace: vi.fn(),
  listUserWorkspaces: vi.fn(),
  setActiveWorkspace: vi.fn(),
  getProject: vi.fn(),
  findProjectAnyOrg: vi.fn(),
  resolveProjectRole: vi.fn(),
  resolveProjectRoleForUser: vi.fn(),
}));

vi.mock("~/auth/workspace.server", () => ({
  resolveActiveWorkspace: mocks.resolveActiveWorkspace,
  ensureWorkspace: mocks.ensureWorkspace,
  listUserWorkspaces: mocks.listUserWorkspaces,
  setActiveWorkspace: mocks.setActiveWorkspace,
}));
vi.mock("~/db/queries.server", () => ({
  getProject: mocks.getProject,
  findProjectAnyOrg: mocks.findProjectAnyOrg,
}));
vi.mock("~/auth/project-access.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/auth/project-access.server")
  >("~/auth/project-access.server");
  return {
    roleSatisfies: actual.roleSatisfies,
    resolveProjectRole: mocks.resolveProjectRole,
    resolveProjectRoleForUser: mocks.resolveProjectRoleForUser,
  };
});
vi.mock("~/db/client.server", () => ({ db: {} }));

import { requireFohProject } from "~/foh/guard.server";
import { requireProject, requireProjectAccess } from "~/project/guard.server";

const AUTH = {
  user: { id: "user_1", email: "u@example.com", name: "U" },
  organizationId: "org_1",
  requestHeaders: new Headers(),
} as never;
const PROJECT = { id: "proj_1", orgId: "org_1", slug: "repo", name: "repo" };

function active(role: string) {
  return {
    org: { id: "org_1", name: "Acme", slug: "acme" },
    member: { id: "m1", organizationId: "org_1", userId: "user_1", role },
  };
}

/** `data()` throws a DataWithResponseInit, `redirect()`/`Response.json()` a Response. */
async function thrown(run: () => Promise<unknown>): Promise<Response> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Response) return error;
    const init = (error as { init?: { status?: number } }).init;
    if (init) return new Response(null, { status: init.status });
    throw error;
  }
  throw new Error("expected a thrown Response");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActiveWorkspace.mockResolvedValue(active("member"));
  mocks.getProject.mockResolvedValue(PROJECT);
  mocks.findProjectAnyOrg.mockResolvedValue(null);
  mocks.listUserWorkspaces.mockResolvedValue([]);
});

describe("requireProjectAccess", () => {
  it("returns the project and the viewer's role when the grant suffices", async () => {
    mocks.resolveProjectRole.mockResolvedValue("write");
    const access = await requireProjectAccess(AUTH, "proj_1", "read");
    expect(access.project).toEqual(PROJECT);
    expect(access.role).toBe("write");
    expect(mocks.resolveProjectRole).toHaveBeenCalledWith({
      userId: "user_1",
      workspaceRole: "member",
      orgId: "org_1",
      projectId: "proj_1",
    });
  });

  it("404s a repo the viewer holds no grant on — indistinguishable from nonexistent", async () => {
    mocks.resolveProjectRole.mockResolvedValue(null);
    const response = await thrown(() =>
      requireProjectAccess(AUTH, "proj_1", "read"),
    );
    expect(response.status).toBe(404);
    // Same status as an unknown id, so nobody can probe which repos exist.
    mocks.getProject.mockResolvedValue(undefined);
    const missing = await thrown(() =>
      requireProjectAccess(AUTH, "proj_nope", "read"),
    );
    expect(missing.status).toBe(404);
  });

  it("an admin without a grant is also 404'd — admins hold no implicit repo access", async () => {
    mocks.resolveActiveWorkspace.mockResolvedValue(active("admin"));
    mocks.resolveProjectRole.mockResolvedValue(null);
    const response = await thrown(() =>
      requireProjectAccess(AUTH, "proj_1", "read"),
    );
    expect(response.status).toBe(404);
  });

  it("read-only viewer on a write API surface → 403 JSON", async () => {
    mocks.resolveProjectRole.mockResolvedValue("read");
    const response = await thrown(() =>
      requireProjectAccess(AUTH, "proj_1", "write"),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /read-only/i,
    );
  });

  it("read-only viewer on a write page → redirect to front of house", async () => {
    mocks.resolveProjectRole.mockResolvedValue("read");
    const response = await thrown(() =>
      requireProjectAccess(AUTH, "proj_1", "write", {
        request: new Request("http://localhost/repos/proj_1/edit"),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });

  it("404s a project from another workspace without a request (stale-tab POST)", async () => {
    mocks.getProject.mockResolvedValue(undefined);
    mocks.findProjectAnyOrg.mockResolvedValue({ ...PROJECT, orgId: "org_2" });
    mocks.listUserWorkspaces.mockResolvedValue([{ id: "org_2", name: "Other" }]);
    const response = await thrown(() =>
      requireProjectAccess(AUTH, "proj_1", "write"),
    );
    expect(response.status).toBe(404);
    expect(mocks.setActiveWorkspace).not.toHaveBeenCalled();
  });

  it("switches workspace for a granted repo and replays the PAGE url, not the .data url", async () => {
    mocks.getProject.mockResolvedValue(undefined);
    mocks.findProjectAnyOrg.mockResolvedValue({ ...PROJECT, orgId: "org_2" });
    mocks.resolveProjectRoleForUser.mockResolvedValue("write");
    const response = await thrown(() =>
      requireProjectAccess(AUTH, "proj_1", "write", {
        request: new Request("http://localhost/repos/proj_1/settings.data?tab=x"),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/repos/proj_1/settings?tab=x");
    expect(mocks.setActiveWorkspace).toHaveBeenCalledWith(AUTH, "org_2");
  });

  it("404s a repo in another workspace the viewer holds no grant on, even with a request", async () => {
    mocks.getProject.mockResolvedValue(undefined);
    mocks.findProjectAnyOrg.mockResolvedValue({ ...PROJECT, orgId: "org_2" });
    mocks.resolveProjectRoleForUser.mockResolvedValue(null);
    const response = await thrown(() =>
      requireProjectAccess(AUTH, "proj_1", "write", {
        request: new Request("http://localhost/repos/proj_1/settings"),
      }),
    );
    expect(response.status).toBe(404);
    expect(mocks.setActiveWorkspace).not.toHaveBeenCalled();
  });
});

describe("requireProject / requireFohProject", () => {
  it("requireProject demands write", async () => {
    mocks.resolveProjectRole.mockResolvedValue("read");
    const response = await thrown(() => requireProject(AUTH, "proj_1"));
    expect(response.status).toBe(403);
    mocks.resolveProjectRole.mockResolvedValue("write");
    await expect(requireProject(AUTH, "proj_1")).resolves.toEqual(PROJECT);
  });

  it("requireFohProject accepts read and reports backOfHouse only for write", async () => {
    mocks.resolveProjectRole.mockResolvedValue("read");
    const reader = await requireFohProject(AUTH, "proj_1");
    expect(reader.project).toEqual(PROJECT);
    expect(reader.backOfHouse).toBe(false);

    mocks.resolveProjectRole.mockResolvedValue("write");
    const writer = await requireFohProject(AUTH, "proj_1");
    expect(writer.backOfHouse).toBe(true);
  });
});
