/**
 * Workspace invitations (issue #220 §4, Option B). The one entry point on /org/members now has
 * to say what it grants: `admin` is back of house, `member` is front-of-house chat scoped to the
 * repos chosen with the invite. The property under test throughout is that no path can mint the
 * old silent outcome — a `member` with no team, who can reach nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  resolveActiveWorkspace: vi.fn(),
  requireBackOfHouse: vi.fn(),
  ensureWorkspace: vi.fn(),
  ensureProjectTeam: vi.fn(),
  listProjects: vi.fn(),
  createInvitation: vi.fn(),
  listInvitations: vi.fn(),
  cancelInvitation: vi.fn(),
  updateOrganization: vi.fn(),
  listMembers: vi.fn(),
  hasPermission: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  requireSession: mocks.requireSession,
  sessionLoader: vi.fn(),
}));
vi.mock("~/auth/workspace.server", () => ({
  resolveActiveWorkspace: mocks.resolveActiveWorkspace,
  requireBackOfHouse: mocks.requireBackOfHouse,
  ensureWorkspace: mocks.ensureWorkspace,
}));
vi.mock("~/auth/teams.server", () => ({
  ensureProjectTeam: mocks.ensureProjectTeam,
}));
vi.mock("~/db/queries.server", () => ({ listProjects: mocks.listProjects }));
vi.mock("~/lib/auth.server", () => ({
  auth: {
    api: {
      createInvitation: mocks.createInvitation,
      listInvitations: mocks.listInvitations,
      cancelInvitation: mocks.cancelInvitation,
      updateOrganization: mocks.updateOrganization,
      listMembers: mocks.listMembers,
      hasPermission: mocks.hasPermission,
    },
  },
}));
vi.mock("~/managed/audit.server", () => ({ recordAudit: mocks.recordAudit }));

import { action } from "~/routes/org.members";

const ORG_ID = "org_1";
const EMAIL = "teammate@company.com";

const PROJECTS = [
  { id: "proj_a", name: "support-bot", teamId: null as string | null },
  { id: "proj_b", name: "billing-agent", teamId: "team_b" as string | null },
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
  // Minting a team is idempotent per repo; return a stable id derived from the project.
  mocks.ensureProjectTeam.mockImplementation(
    async (_orgId: string, project: { id: string }) =>
      project.id === "proj_a" ? "team_a" : "team_b",
  );
  mocks.createInvitation.mockResolvedValue({ id: "inv_1" });
  mocks.listInvitations.mockResolvedValue([]);
});

describe("workspace invite — access is explicit", () => {
  it("scopes a member invitation to the repos picked with it", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "invite"],
          ["email", EMAIL],
          ["role", "member"],
          ["repoIds", "proj_a"],
          ["repoIds", "proj_b"],
        ]),
      ),
    );

    expect(mocks.ensureProjectTeam).toHaveBeenCalledTimes(2);
    expect(mocks.createInvitation).toHaveBeenCalledOnce();
    expect(mocks.createInvitation.mock.calls[0][0].body).toEqual({
      email: EMAIL,
      role: "member",
      organizationId: ORG_ID,
      teamId: ["team_a", "team_b"],
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member_invited",
        target: EMAIL,
        meta: {
          role: "member",
          projectIds: ["proj_a", "proj_b"],
          teamIds: ["team_a", "team_b"],
        },
      }),
    );
  });

  it("refuses a member invitation with no repositories", async () => {
    const result = await action(
      actionArgs([
        ["intent", "invite"],
        ["email", EMAIL],
        ["role", "member"],
      ]),
    );

    expect(result).toEqual({
      error: "Choose at least one repository this member can work with.",
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(mocks.ensureProjectTeam).not.toHaveBeenCalled();
  });

  it("refuses a repository id from outside the workspace", async () => {
    const result = await action(
      actionArgs([
        ["intent", "invite"],
        ["email", EMAIL],
        ["role", "member"],
        ["repoIds", "proj_a"],
        ["repoIds", "proj_from_another_workspace"],
      ]),
    );

    expect(result).toEqual({
      error: "That repository is not part of this workspace.",
    });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    // No team may be minted for an id the workspace does not own.
    expect(mocks.ensureProjectTeam).not.toHaveBeenCalled();
  });

  it("invites an administrator without any repo scoping", async () => {
    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "invite"],
          ["email", EMAIL],
          ["role", "admin"],
          // A stray selection must not silently scope an admin.
          ["repoIds", "proj_a"],
        ]),
      ),
    );

    expect(mocks.ensureProjectTeam).not.toHaveBeenCalled();
    expect(mocks.createInvitation.mock.calls[0][0].body).toEqual({
      email: EMAIL,
      role: "admin",
      organizationId: ORG_ID,
    });
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
      {
        id: "inv_1",
        email: EMAIL,
        status: "pending",
        role: "member",
        // team_b is still wired to proj_b, so this grant is live.
        teamId: "team_b",
      },
    ]);

    await expectRedirect(() =>
      action(
        actionArgs([
          ["intent", "resend-invite"],
          ["email", EMAIL],
        ]),
      ),
    );

    // Better Auth ignores role/teamId under `resend: true` — it re-sends the stored invitation
    // and extends its expiry — so the body carries no grant to re-write, and the guard above is
    // what keeps a dead invitation from being extended.
    expect(mocks.createInvitation.mock.calls[0][0].body).toEqual({
      email: EMAIL,
      role: "member",
      organizationId: ORG_ID,
      resend: true,
    });
  });

  it("refuses to extend a member invitation that reaches no repository", async () => {
    mocks.listInvitations.mockResolvedValue([
      {
        id: "inv_1",
        email: EMAIL,
        status: "pending",
        role: "member",
        // The shape a pre-#220 invite has, and the shape Better Auth leaves behind when the
        // last selected repo is deleted.
        teamId: null,
      },
    ]);

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

  it("refuses one whose team outlived the repository it belonged to", async () => {
    mocks.listInvitations.mockResolvedValue([
      {
        id: "inv_1",
        email: EMAIL,
        status: "pending",
        role: "member",
        teamId: "team_deleted",
      },
    ]);

    const result = await action(
      actionArgs([
        ["intent", "resend-invite"],
        ["email", EMAIL],
      ]),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("Cancel") });
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
