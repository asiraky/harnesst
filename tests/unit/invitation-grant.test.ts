/**
 * The acceptance-side half of the invitation invariant. Refusing to MINT a repo-less `member`
 * invitation is not enough to hold "no workspace invite can leave a user as a `member` with no
 * access": a stored grant decays afterwards — every repo it named can be deleted, and the grant
 * rows cascade away with them. These cases pin the check that runs where it matters.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listInvitationGrants: vi.fn(),
  dbSelect: vi.fn(),
  dbLimit: vi.fn(),
}));

vi.mock("~/auth/project-access.server", () => ({
  listInvitationGrants: mocks.listInvitationGrants,
}));
vi.mock("~/db/client.server", () => ({ db: { select: mocks.dbSelect } }));

import {
  grantsNoAccess,
  invitationGrantsNoAccess,
} from "~/auth/invitation-grant.server";

beforeEach(() => {
  vi.clearAllMocks();
  // inv_live still names a repo that exists; everything else has decayed to nothing.
  mocks.listInvitationGrants.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, unknown[]>();
    for (const id of ids) {
      map.set(
        id,
        id === "inv_live"
          ? [{ projectId: "proj_a", role: "read", projectName: "support-bot" }]
          : [],
      );
    }
    return map;
  });
  mocks.dbLimit.mockResolvedValue([]);
  mocks.dbSelect.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: mocks.dbLimit }) }),
  }));
});

describe("grantsNoAccess", () => {
  it("passes a member whose invitation still names a live repo", async () => {
    await expect(
      grantsNoAccess({ id: "inv_live", role: "member" }),
    ).resolves.toBe(false);
  });

  it("refuses a member invitation whose repos are all gone", async () => {
    await expect(
      grantsNoAccess({ id: "inv_decayed", role: "member" }),
    ).resolves.toBe(true);
  });

  it("never blocks a role that reaches the workspace on its own", async () => {
    for (const role of ["admin", "owner", "member,admin"]) {
      await expect(
        grantsNoAccess({ id: "inv_decayed", role }),
      ).resolves.toBe(false);
    }
    // Admins can create repos, so the grant table is never consulted.
    expect(mocks.listInvitationGrants).not.toHaveBeenCalled();
  });

  it("treats a missing role as the member default", async () => {
    await expect(grantsNoAccess({ id: "inv_decayed", role: null })).resolves.toBe(
      true,
    );
  });
});

describe("invitationGrantsNoAccess", () => {
  it("reads the stored invitation and applies the same rule", async () => {
    mocks.dbLimit.mockResolvedValue([{ id: "inv_decayed", role: "member" }]);

    await expect(invitationGrantsNoAccess("inv_decayed")).resolves.toBe(true);
  });

  it("leaves an unknown invitation to Better Auth's own error", async () => {
    mocks.dbLimit.mockResolvedValue([]);

    await expect(invitationGrantsNoAccess("inv_missing")).resolves.toBe(false);
    expect(mocks.listInvitationGrants).not.toHaveBeenCalled();
  });

  it("does not query for an empty id", async () => {
    await expect(invitationGrantsNoAccess("")).resolves.toBe(false);
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });
});
