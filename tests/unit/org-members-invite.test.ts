/**
 * Workspace invitations and access management on /org/members. The one entry point has to say
 * what it grants: a workspace role (admin | member) plus per-repo read/write grants that are
 * stored against the invitation and applied on accept. The property under test throughout is
 * that no path can mint the old silent outcome — a `member` with no repo, who can reach
 * nothing at all — and that every id is resolved inside the ACTIVE workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  resolveActiveWorkspace: vi.fn(),
  requireWorkspaceAdmin: vi.fn(),
  ensureWorkspace: vi.fn(),
  listProjects: vi.fn(),
  createInvitation: vi.fn(),
  listInvitations: vi.fn(),
  cancelInvitation: vi.fn(),
  updateOrganization: vi.fn(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
  listMembers: vi.fn(),
  recordAudit: vi.fn(),
  setInvitationGrants: vi.fn(),
  listInvitationGrants: vi.fn(),
  setProjectAccess: vi.fn(),
  revokeAllProjectAccess: vi.fn(),
  grantsNoAccess: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  requireSession: mocks.requireSession,
  sessionLoader: vi.fn(),
}));
vi.mock("~/auth/workspace.server", async () => {
  const roles = await vi.importActual<typeof import("~/auth/roles")>(
    "~/auth/roles",
  );
  return {
    resolveActiveWorkspace: mocks.resolveActiveWorkspace,
    requireWorkspaceAdmin: mocks.requireWorkspaceAdmin,
    ensureWorkspace: mocks.ensureWorkspace,
    isWorkspaceOwner: roles.isWorkspaceOwner,
    isWorkspaceAdmin: roles.isWorkspaceAdmin,
  };
});
vi.mock("~/auth/project-access.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/auth/project-access.server")
  >("~/auth/project-access.server");
  return {
    parseProjectRole: actual.parseProjectRole,
    setInvitationGrants: mocks.setInvitationGrants,
    listInvitationGrants: mocks.listInvitationGrants,
    setProjectAccess: mocks.setProjectAccess,
    revokeAllProjectAccess: mocks.revokeAllProjectAccess,
    listOrgProjectAccess: vi.fn(async () => []),
  };
});
vi.mock("~/auth/invitation-grant.server", () => ({
  grantsNoAccess: mocks.grantsNoAccess,
}));
vi.mock("~/db/client.server", () => ({ db: {} }));
vi.mock("~/db/queries.server", () => ({ listProjects: mocks.listProjects }));
vi.mock("~/lib/auth.server", () => ({
  auth: {
    api: {
      createInvitation: mocks.createInvitation,
      listInvitations: mocks.listInvitations,
      cancelInvitation: mocks.cancelInvitation,
      updateOrganization: mocks.updateOrganization,
      updateMemberRole: mocks.updateMemberRole,
      removeMember: mocks.removeMember,
      listMembers: mocks.listMembers,
    },
  },
}));
vi.mock("~/managed/audit.server", () => ({ recordAudit: mocks.recordAudit }));

import { action } from "~/routes/org.members";

const ORG_ID = "org_1";
const EMAIL = "teammate@company.com";

const PROJECTS = [
  { id: "proj_a", name: "support-bot" },
  { id: "proj_b", name: "billing-agent" },
];

const MEMBERS = [
  {
    id: "m1",
    userId: "user_1",
    role: "owner",
    user: { email: "owner@example.com", name: "Owner" },
  },
  {
    id: "m2",
    userId: "user_2",
    role: "member",
    user: { email: "member@example.com", name: "Member" },
  },
  {
    id: "m3",
    userId: "user_3",
    role: "owner",
    user: { email: "other-owner@example.com", name: "Other owner" },
  },
];

const SESSION = {
  user: { id: "user_1", email: "owner@example.com" },
  requestHeaders: new Headers({ cookie: "s=1" }),
};

function actionArgs(fields: [string, string][]) {
  const body = new URLSearchParams(fields);
  return {
    request: new Request("http://localhost/org/members", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    params: {},
    context: {},
  } as never;
}

/** The success path throws a redirect; return it rather than letting it fail the test. */
async function expectRedirect(run: () => Promise<unknown>): Promise<Response> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("expected a redirect Response");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(SESSION);
  mocks.resolveActiveWorkspace.mockResolvedValue({
    org: { id: ORG_ID, name: "Acme", slug: "acme" },
    member: {
      id: "m1",
      organizationId: ORG_ID,
      userId: "user_1",
      role: "owner",
    },
  });
  mocks.listProjects.mockResolvedValue(PROJECTS.map((p) => ({ ...p })));
  mocks.listMembers.mockResolvedValue({ members: MEMBERS, total: MEMBERS.length });
  mocks.createInvitation.mockResolvedValue({ id: "inv_1" });
  mocks.listInvitations.mockResolvedValue([]);
  mocks.setProjectAccess.mockResolvedValue({ ok: true });
  mocks.setInvitationGrants.mockResolvedValue(undefined);
  mocks.cancelInvitation.mockResolvedValue({});
  mocks.grantsNoAccess.mockResolvedValue(false);
});

describe("workspace invite — access is explicit", () => {
  it("stores the per-repo grants chosen with a member invitation", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "invite"],
          ["email", EMAIL],
          ["role", "member"],
          ["access:proj_a", "read"],
          ["access:proj_b", "write"],
        ]),
      ),
    );

    expect(mocks.createInvitation).toHaveBeenCalledOnce();
    expect(mocks.createInvitation.mock.calls[0][0].body).toEqual({
      email: EMAIL,
      role: "member",
      organizationId: ORG_ID,
    });
    expect(mocks.setInvitationGrants).toHaveBeenCalledWith({
      orgId: ORG_ID,
      invitationId: "inv_1",
      grants: [
        { projectId: "proj_a", role: "read" },
        { projectId: "proj_b", role: "write" },
      ],
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member_invited", target: EMAIL }),
    );
  });

  it("cancels the just-sent invitation when its grants cannot be stored", async () => {
    mocks.setInvitationGrants.mockRejectedValue(new Error("db down"));
    const result = await action(
      actionArgs([
        ["intent", "invite"],
        ["email", EMAIL],
        ["role", "member"],
        ["access:proj_a", "read"],
      ]),
    );
    expect(result).toMatchObject({ error: expect.stringContaining("access") });
    expect(mocks.cancelInvitation).toHaveBeenCalledWith({
      body: { invitationId: "inv_1" },
      headers: SESSION.requestHeaders,
    });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a member invitation with no repositories", async () => {
    const result = await action(
      actionArgs([
        ["intent", "invite"],
        ["email", EMAIL],
        ["role", "member"],
        ["access:proj_a", "none"],
      ]),
    );

    expect(result).toEqual({
      error: "Choose at least one repository this member can work with.",
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(mocks.setInvitationGrants).not.toHaveBeenCalled();
  });

  it("refuses a repository id from outside the workspace", async () => {
    const result = await action(
      actionArgs([
        ["intent", "invite"],
        ["email", EMAIL],
        ["role", "member"],
        ["access:proj_a", "read"],
        ["access:proj_from_another_workspace", "write"],
      ]),
    );

    expect(result).toEqual({
      error: "That repository is not part of this workspace.",
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("rejects an access level that does not exist", async () => {
    const result = await action(
      actionArgs([
        ["intent", "invite"],
        ["email", EMAIL],
        ["role", "member"],
        ["access:proj_a", "admin"],
      ]),
    );
    expect(result).toEqual({ error: "Choose read, write or none." });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("invites an administrator with no repos — admins can create their own", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "invite"],
          ["email", EMAIL],
          ["role", "admin"],
        ]),
      ),
    );

    expect(mocks.createInvitation.mock.calls[0][0].body).toEqual({
      email: EMAIL,
      role: "admin",
      organizationId: ORG_ID,
    });
    expect(mocks.setInvitationGrants).toHaveBeenCalledWith(
      expect.objectContaining({ grants: [] }),
    );
  });

  it("an administrator's repo choices are stored too — admins hold no implicit access", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "invite"],
          ["email", EMAIL],
          ["role", "admin"],
          ["access:proj_a", "write"],
        ]),
      ),
    );
    expect(mocks.setInvitationGrants).toHaveBeenCalledWith(
      expect.objectContaining({
        grants: [{ projectId: "proj_a", role: "write" }],
      }),
    );
  });

  it("rejects a role the workspace does not offer", async () => {
    const result = await action(
      actionArgs([
        ["intent", "invite"],
        ["email", EMAIL],
        ["role", "owner"],
      ]),
    );

    expect(result).toEqual({
      error: "Choose what access this invitation grants.",
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });
});

describe("workspace invite — resend replays the stored grant", () => {
  it("re-sends a grant that still reaches a repository", async () => {
    mocks.listInvitations.mockResolvedValue([
      { id: "inv_1", email: EMAIL, status: "pending", role: "member" },
    ]);

    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "resend-invite"],
          ["email", EMAIL],
        ]),
      ),
    );

    // Better Auth ignores role under `resend: true` — it re-sends the stored invitation and
    // extends its expiry — so the guard above is what keeps a dead invitation from being
    // extended.
    expect(mocks.createInvitation.mock.calls[0][0].body).toEqual({
      email: EMAIL,
      role: "member",
      organizationId: ORG_ID,
      resend: true,
    });
  });

  it("refuses to extend a member invitation that reaches no repository", async () => {
    mocks.listInvitations.mockResolvedValue([
      { id: "inv_1", email: EMAIL, status: "pending", role: "member" },
    ]);
    mocks.grantsNoAccess.mockResolvedValue(true);

    const result = await action(
      actionArgs([
        ["intent", "resend-invite"],
        ["email", EMAIL],
      ]),
    );

    expect(result).toEqual({
      error:
        "That invitation no longer gives access to any repository. Cancel it and send a new one.",
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("will not invent a grant when nothing is pending", async () => {
    const result = await action(
      actionArgs([
        ["intent", "resend-invite"],
        ["email", EMAIL],
      ]),
    );

    expect(result).toEqual({
      error:
        "That invitation is no longer pending. Send a new invitation instead.",
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });
});

describe("per-repo access", () => {
  it("sets a member's access on one repo and audits it", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "set-access"],
          ["memberId", "m2"],
          ["projectId", "proj_a"],
          ["role", "write"],
        ]),
      ),
    );
    expect(mocks.setProjectAccess).toHaveBeenCalledWith({
      orgId: ORG_ID,
      projectId: "proj_a",
      userId: "user_2",
      role: "write",
      grantedBy: "user_1",
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project_access_changed",
        target: "member@example.com",
      }),
    );
  });

  it("`none` revokes the grant", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "set-access"],
          ["memberId", "m2"],
          ["projectId", "proj_a"],
          ["role", "none"],
        ]),
      ),
    );
    expect(mocks.setProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ role: null }),
    );
  });

  it("refuses a member id that is not in the active workspace", async () => {
    const result = await action(
      actionArgs([
        ["intent", "set-access"],
        ["memberId", "m_elsewhere"],
        ["projectId", "proj_a"],
        ["role", "read"],
      ]),
    );
    expect(result).toEqual({
      error: "That member is not part of this workspace.",
    });
    expect(mocks.setProjectAccess).not.toHaveBeenCalled();
  });

  it("never writes a per-repo row for an owner", async () => {
    const result = await action(
      actionArgs([
        ["intent", "set-access"],
        ["memberId", "m3"],
        ["projectId", "proj_a"],
        ["role", "read"],
      ]),
    );
    expect(result).toEqual({
      error: "Owners already have access to every repository.",
    });
    expect(mocks.setProjectAccess).not.toHaveBeenCalled();
  });

  it("surfaces the helper's refusal (e.g. repo from another workspace)", async () => {
    mocks.setProjectAccess.mockResolvedValue({
      ok: false,
      error: "That repository is not part of this workspace.",
    });
    const result = await action(
      actionArgs([
        ["intent", "set-access"],
        ["memberId", "m2"],
        ["projectId", "proj_x"],
        ["role", "read"],
      ]),
    );
    expect(result).toEqual({
      error: "That repository is not part of this workspace.",
    });
  });
});

describe("workspace roles and removal", () => {
  it("changes another member's role through Better Auth", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "set-role"],
          ["memberId", "m2"],
          ["role", "admin"],
        ]),
      ),
    );
    expect(mocks.updateMemberRole).toHaveBeenCalledWith({
      body: { memberId: "m2", role: "admin", organizationId: ORG_ID },
      headers: SESSION.requestHeaders,
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member_role_changed",
        meta: { from: "member", to: "admin" },
      }),
    );
  });

  it("refuses to change your own role", async () => {
    const result = await action(
      actionArgs([
        ["intent", "set-role"],
        ["memberId", "m1"],
        ["role", "member"],
      ]),
    );
    expect(result).toEqual({ error: "You cannot change your own role." });
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it("rejects an unknown role before touching Better Auth", async () => {
    const result = await action(
      actionArgs([
        ["intent", "set-role"],
        ["memberId", "m2"],
        ["role", "superuser"],
      ]),
    );
    expect(result).toEqual({ error: "Choose a role." });
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it("removes a member and revokes every repo grant they held", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "remove-member"],
          ["memberId", "m2"],
        ]),
      ),
    );
    expect(mocks.removeMember).toHaveBeenCalledWith({
      body: { memberIdOrEmail: "m2", organizationId: ORG_ID },
      headers: SESSION.requestHeaders,
    });
    expect(mocks.revokeAllProjectAccess).toHaveBeenCalledWith(ORG_ID, "user_2");
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member_removed" }),
    );
  });

  it("revokes grants BEFORE the membership so a failed removal never leaves stale access", async () => {
    const order: string[] = [];
    mocks.revokeAllProjectAccess.mockImplementation(async () => {
      order.push("revoke");
    });
    mocks.removeMember.mockImplementation(async () => {
      order.push("remove");
      throw new Error("nope");
    });
    const result = await action(
      actionArgs([
        ["intent", "remove-member"],
        ["memberId", "m3"],
      ]),
    );
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(order).toEqual(["revoke", "remove"]);
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("refuses to remove yourself", async () => {
    const result = await action(
      actionArgs([
        ["intent", "remove-member"],
        ["memberId", "m1"],
      ]),
    );
    expect(result).toMatchObject({ error: expect.stringContaining("yourself") });
    expect(mocks.removeMember).not.toHaveBeenCalled();
  });
});
