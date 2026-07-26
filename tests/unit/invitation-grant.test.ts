/**
 * The acceptance-side half of issue #220 §4. Refusing to MINT a teamless `member` invitation is
 * not enough to hold "no workspace invite can leave a user as a `member` with no team": a stored
 * grant decays afterwards — legacy rows carry no team at all, and Better Auth strips a deleted
 * team from every pending invitation. These cases pin the check that runs where it matters.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  dbSelect: vi.fn(),
  dbLimit: vi.fn(),
}));

vi.mock("~/db/queries.server", () => ({ listProjects: mocks.listProjects }));
vi.mock("~/db/client.server", () => ({ db: { select: mocks.dbSelect } }));

import {
  grantsNoAccess,
  invitationGrantsNoAccess,
  splitInvitationTeamIds,
} from "~/auth/invitation-grant.server";

const ORG_ID = "org_1";

beforeEach(() => {
  vi.clearAllMocks();
  // One repo, wired to team_live. Anything else names a team no repository points at.
  mocks.listProjects.mockResolvedValue([
    { id: "proj_a", name: "support-bot", teamId: "team_live" },
    { id: "proj_b", name: "no-team-yet", teamId: null },
  ]);
  mocks.dbLimit.mockResolvedValue([]);
  mocks.dbSelect.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: mocks.dbLimit }) }),
  }));
});

describe("grantsNoAccess", () => {
  it("passes a member whose invitation names a live repo team", async () => {
    await expect(
      grantsNoAccess({
        role: "member",
        teamId: "team_live",
        organizationId: ORG_ID,
      }),
    ).resolves.toBe(false);
  });

  it("refuses a member invitation carrying no team at all", async () => {
    // The shape every pre-#220 workspace invitation has.
    await expect(
      grantsNoAccess({ role: "member", teamId: null, organizationId: ORG_ID }),
    ).resolves.toBe(true);
  });

  it("refuses a member invitation whose team no longer maps to a repo", async () => {
    // Better Auth nulls a deleted team out of pending invitations; a repo deleted after the
    // invite was sent leaves the id behind with nothing pointing at it.
    await expect(
      grantsNoAccess({
        role: "member",
        teamId: "team_deleted",
        organizationId: ORG_ID,
      }),
    ).resolves.toBe(true);
  });

  it("passes a member who keeps one live team after another was deleted", async () => {
    await expect(
      grantsNoAccess({
        role: "member",
        teamId: "team_deleted,team_live",
        organizationId: ORG_ID,
      }),
    ).resolves.toBe(false);
  });

  it("never blocks a role that reaches the workspace on its own", async () => {
    for (const role of ["admin", "owner", "member,admin"]) {
      await expect(
        grantsNoAccess({ role, teamId: null, organizationId: ORG_ID }),
      ).resolves.toBe(false);
    }
    // Back of house does not depend on teams, so the repo list is never consulted.
    expect(mocks.listProjects).not.toHaveBeenCalled();
  });

  it("treats a missing role as the member default", async () => {
    await expect(
      grantsNoAccess({ role: null, teamId: null, organizationId: ORG_ID }),
    ).resolves.toBe(true);
  });
});

describe("invitationGrantsNoAccess", () => {
  it("reads the stored grant and applies the same rule", async () => {
    mocks.dbLimit.mockResolvedValue([
      { role: "member", teamId: null, organizationId: ORG_ID },
    ]);

    await expect(invitationGrantsNoAccess("inv_1")).resolves.toBe(true);
  });

  it("leaves an unknown invitation to Better Auth's own error", async () => {
    mocks.dbLimit.mockResolvedValue([]);

    await expect(invitationGrantsNoAccess("inv_missing")).resolves.toBe(false);
    expect(mocks.listProjects).not.toHaveBeenCalled();
  });

  it("does not query for an empty id", async () => {
    await expect(invitationGrantsNoAccess("")).resolves.toBe(false);
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });
});

describe("splitInvitationTeamIds", () => {
  it("splits Better Auth's comma-separated storage and drops blanks", () => {
    expect(splitInvitationTeamIds("a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(splitInvitationTeamIds(null)).toEqual([]);
    expect(splitInvitationTeamIds("")).toEqual([]);
  });
});
