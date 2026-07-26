/**
 * FOH invites & roles against a REAL Postgres (WP5): Better Auth teams end-to-end — repo team
 * minting (ensureProjectTeam), an invitation carrying the team id, the invitee accepting into
 * the team as a workspace `member`, member repo scoping (listMemberProjectIds), and team
 * teardown — the Drizzle + Better Auth adapter behavior the unit mocks can't prove.
 *
 * Opt-in: runs only when HARNESST_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`HARNESST_DB_SMOKE=1 npx vitest run tests/integration/foh-teams.db.test.ts` with .env.local
 * sourced). Creates its own org/user/project rows and deletes them, so it's safe to re-run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";
const ORIGIN = "http://localhost:5277";

process.env.BETTER_AUTH_SECRET ??=
  "harnesst-auth-integration-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= ORIGIN;
// The invitation flow sends a real email through the module-load-singleton email client;
// route it to a throwaway file mailbox so the test never needs SMTP/Postmark.
process.env.MAILBOX_DIR ??= mkdtempSync(join(tmpdir(), "foh-teams-mailbox-"));

function jsonRequest(path: string, body: Record<string, unknown>) {
  return new Request(`${ORIGIN}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header)
    throw new Error("Better Auth response did not set a session cookie.");
  return header.split(";", 1)[0];
}

describe.runIf(LIVE)("FOH teams against real Postgres", () => {
  it("mints a repo team, invites into it, accepts as member, scopes repos, tears down", async () => {
    const { auth } = await import("~/lib/auth.server");
    const { db } = await import("~/db/client.server");
    const { invitation, member, team, teamMember, user } =
      await import("~/db/auth-schema");
    const { organization } = await import("~/db/auth-schema");
    const { projects } = await import("~/db/schema");
    const { drizzleDataStore: store } = await import("~/data/drizzle.server");
    const { createProject } = await import("~/db/queries.server");
    const { deleteProjectTeam, ensureProjectTeam, listMemberProjectIds } =
      await import("~/auth/teams.server");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerEmail = `foh-owner-${suffix}@smoke.test`;
    const inviteeEmail = `foh-invitee-${suffix}@smoke.test`;
    let ownerId: string | undefined;
    let inviteeId: string | undefined;
    let organizationId: string | undefined;

    try {
      // Owner signs up and creates the workspace (becomes role "owner", org set active).
      const ownerSignup = await auth.handler(
        jsonRequest("sign-up/email", {
          name: "Foh Owner",
          email: ownerEmail,
          password: "correct-horse-battery-staple",
        }),
      );
      expect(ownerSignup.status).toBe(200);
      const ownerHeaders = new Headers({ cookie: cookieFrom(ownerSignup) });
      ownerId = (await auth.api.getSession({ headers: ownerHeaders }))?.user.id;

      const org = await auth.api.createOrganization({
        body: { name: "FOH Smoke Workspace", slug: `foh-smoke-${suffix}` },
        headers: ownerHeaders,
      });
      expect(org?.id).toBeTruthy();
      organizationId = org!.id;

      // defaultTeam is disabled: creating the organization minted NO team.
      expect(
        await db
          .select({ id: team.id })
          .from(team)
          .where(eq(team.organizationId, organizationId)),
      ).toHaveLength(0);

      // Connected repo → ensureProjectTeam mints its team and persists projects.team_id.
      const project = await createProject(
        { orgId: organizationId, name: "foh-smoke-repo" },
        store,
      );
      const teamId = await ensureProjectTeam(organizationId, project);
      const [teamRow] = await db
        .select()
        .from(team)
        .where(eq(team.id, teamId));
      expect(teamRow?.organizationId).toBe(organizationId);
      expect(teamRow?.name).toBe("foh-smoke-repo");
      const [projectRow] = await db
        .select({ teamId: projects.teamId })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(projectRow?.teamId).toBe(teamId);

      // Idempotent: a second ensure (fresh project row) returns the same team.
      expect(
        await ensureProjectTeam(organizationId, { ...project, teamId }),
      ).toBe(teamId);
      expect(
        await db
          .select({ id: team.id })
          .from(team)
          .where(eq(team.organizationId, organizationId)),
      ).toHaveLength(1);

      // Invite-to-repo: the org invitation carries the repo team's id.
      await auth.api.createInvitation({
        body: {
          email: inviteeEmail,
          role: "member",
          organizationId,
          teamId,
        },
        headers: ownerHeaders,
      });
      const [invitationRow] = await db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organizationId),
            eq(invitation.email, inviteeEmail),
          ),
        );
      expect(invitationRow?.teamId).toBe(teamId);
      expect(invitationRow?.status).toBe("pending");

      // Invitee signs up; the delivery-token redemption is mirrored by marking the mailbox
      // verified directly (requireEmailVerificationOnInvitation gate).
      const inviteeSignup = await auth.handler(
        jsonRequest("sign-up/email", {
          name: "Foh Invitee",
          email: inviteeEmail,
          password: "correct-horse-battery-staple",
        }),
      );
      expect(inviteeSignup.status).toBe(200);
      const inviteeHeaders = new Headers({
        cookie: cookieFrom(inviteeSignup),
      });
      inviteeId = (await auth.api.getSession({ headers: inviteeHeaders }))
        ?.user.id;
      await db
        .update(user)
        .set({ emailVerified: true })
        .where(eq(user.id, inviteeId!));

      // Accept: Better Auth creates the membership AND the teamMember row (invitation.teamId).
      await auth.api.acceptInvitation({
        body: { invitationId: invitationRow!.id },
        headers: inviteeHeaders,
      });
      const [membership] = await db
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, inviteeId!),
          ),
        );
      expect(membership?.role).toBe("member");
      const teamMemberships = await db
        .select()
        .from(teamMember)
        .where(eq(teamMember.teamId, teamId));
      expect(teamMemberships.map((row) => row.userId)).toEqual([inviteeId]);

      // Member repo scoping: the invitee sees the repo; the owner has no teamMember row
      // (admins/owners never consult listMemberProjectIds — they see every org project).
      expect(await listMemberProjectIds(inviteeId!, organizationId)).toEqual([
        project.id,
      ]);
      expect(await listMemberProjectIds(ownerId!, organizationId)).toEqual([]);

      // Teardown: removing the org's ONLY team must work (allowRemovingAllTeams), cascade
      // the teamMember rows, and set-null the projects.team_id FK.
      await deleteProjectTeam(organizationId, teamId);
      expect(
        await db.select({ id: team.id }).from(team).where(eq(team.id, teamId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(teamMember)
          .where(eq(teamMember.teamId, teamId)),
      ).toHaveLength(0);
      const [projectAfter] = await db
        .select({ teamId: projects.teamId })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(projectAfter?.teamId).toBeNull();
      expect(await listMemberProjectIds(inviteeId!, organizationId)).toEqual(
        [],
      );
    } finally {
      // Organization cascade removes members/invitations/teams/projects; users go last.
      if (organizationId) {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
      if (ownerId) await db.delete(user).where(eq(user.id, ownerId));
      if (inviteeId) await db.delete(user).where(eq(user.id, inviteeId));
    }
  });

  it("grants existing members directly and merges pending invitations across repos (issue #221)", async () => {
    const { auth } = await import("~/lib/auth.server");
    const { db } = await import("~/db/client.server");
    const { invitation, member, organization, team, teamMember, user } =
      await import("~/db/auth-schema");
    const { drizzleDataStore: store } = await import("~/data/drizzle.server");
    const { createProject } = await import("~/db/queries.server");
    const { ensureProjectTeam, listMemberProjectIds } =
      await import("~/auth/teams.server");
    const { action } = await import("~/routes/api.repos.$projectId.invite");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerEmail = `foh-grant-owner-${suffix}@smoke.test`;
    const memberEmail = `foh-grant-member-${suffix}@smoke.test`;
    const inviteeEmail = `foh-grant-invitee-${suffix}@smoke.test`;
    let ownerId: string | undefined;
    let memberId: string | undefined;
    let inviteeId: string | undefined;
    let organizationId: string | undefined;

    /** Drive the REAL route action as the signed-in admin (fresh per-request context). */
    function inviteArgs(projectId: string, cookie: string, email: string) {
      return {
        request: new Request(`${ORIGIN}/api/repos/${projectId}/invite`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
            origin: ORIGIN,
          },
          body: new URLSearchParams({ intent: "invite", email }),
        }),
        params: { projectId },
        // No framework middleware ran: an empty context makes getSessionAuth fall back to
        // reading the session straight from the request cookie.
        context: { get: () => null, set: () => {} },
      } as never;
    }

    try {
      const ownerSignup = await auth.handler(
        jsonRequest("sign-up/email", {
          name: "Foh Grant Owner",
          email: ownerEmail,
          password: "correct-horse-battery-staple",
        }),
      );
      expect(ownerSignup.status).toBe(200);
      const ownerCookie = cookieFrom(ownerSignup);
      const ownerHeaders = new Headers({ cookie: ownerCookie });
      ownerId = (await auth.api.getSession({ headers: ownerHeaders }))?.user.id;

      const org = await auth.api.createOrganization({
        body: { name: "FOH Grant Workspace", slug: `foh-grant-${suffix}` },
        headers: ownerHeaders,
      });
      expect(org?.id).toBeTruthy();
      organizationId = org!.id;
      // requireProject resolves the ACTIVE workspace; pin it in case creation didn't.
      await auth.api.setActiveOrganization({
        body: { organizationId },
        headers: ownerHeaders,
      });

      // Two connected repos, each with its team.
      const projectA = await createProject(
        { orgId: organizationId, name: "foh-grant-repo-a" },
        store,
      );
      const projectB = await createProject(
        { orgId: organizationId, name: "foh-grant-repo-b" },
        store,
      );
      const teamA = await ensureProjectTeam(organizationId, projectA);
      const teamB = await ensureProjectTeam(organizationId, projectB);

      // A pre-team org member: real account, membership row only — NO teamMember rows,
      // exactly the pre-#210 shape the direct-grant repair path exists for.
      const memberSignup = await auth.handler(
        jsonRequest("sign-up/email", {
          name: "Foh Grant Member",
          email: memberEmail,
          password: "correct-horse-battery-staple",
        }),
      );
      expect(memberSignup.status).toBe(200);
      memberId = (
        await auth.api.getSession({
          headers: new Headers({ cookie: cookieFrom(memberSignup) }),
        })
      )?.user.id;
      await db.insert(member).values({
        id: crypto.randomUUID(),
        organizationId,
        userId: memberId!,
        role: "member",
        createdAt: new Date(),
      });

      // 1) Granting repo A to the existing member is a direct team grant, not an invitation.
      expect(
        await action(inviteArgs(projectA.id, ownerCookie, memberEmail)),
      ).toEqual({ ok: true });
      expect(
        await db
          .select()
          .from(teamMember)
          .where(
            and(
              eq(teamMember.teamId, teamA),
              eq(teamMember.userId, memberId!),
            ),
          ),
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: invitation.id })
          .from(invitation)
          .where(
            and(
              eq(invitation.organizationId, organizationId),
              eq(invitation.email, memberEmail),
            ),
          ),
      ).toHaveLength(0);
      expect(await listMemberProjectIds(memberId!, organizationId)).toEqual([
        projectA.id,
      ]);

      // 2) A later grant of repo B stacks: both repos listed.
      expect(
        await action(inviteArgs(projectB.id, ownerCookie, memberEmail)),
      ).toEqual({ ok: true });
      expect(
        (await listMemberProjectIds(memberId!, organizationId)).sort(),
      ).toEqual([projectA.id, projectB.id].sort());

      // 3) A brand-new email invited to repo A gets a single-team pending invitation.
      expect(
        await action(inviteArgs(projectA.id, ownerCookie, inviteeEmail)),
      ).toEqual({ ok: true });
      const [firstInvite] = await db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organizationId),
            eq(invitation.email, inviteeEmail),
            eq(invitation.status, "pending"),
          ),
        );
      expect(firstInvite?.teamId).toBe(teamA);

      // Re-inviting for repo B cancels the old invitation and mints ONE replacement
      // carrying BOTH team ids (comma-separated on the row).
      expect(
        await action(inviteArgs(projectB.id, ownerCookie, inviteeEmail)),
      ).toEqual({ ok: true });
      const [firstAfter] = await db
        .select({ status: invitation.status })
        .from(invitation)
        .where(eq(invitation.id, firstInvite!.id));
      expect(firstAfter?.status).toBe("canceled");
      const pendingRows = await db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organizationId),
            eq(invitation.email, inviteeEmail),
            eq(invitation.status, "pending"),
          ),
        );
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0].teamId).toBe(`${teamA},${teamB}`);

      // Accepting the merged invitation lands the invitee in BOTH repo teams.
      const inviteeSignup = await auth.handler(
        jsonRequest("sign-up/email", {
          name: "Foh Grant Invitee",
          email: inviteeEmail,
          password: "correct-horse-battery-staple",
        }),
      );
      expect(inviteeSignup.status).toBe(200);
      const inviteeHeaders = new Headers({
        cookie: cookieFrom(inviteeSignup),
      });
      inviteeId = (await auth.api.getSession({ headers: inviteeHeaders }))
        ?.user.id;
      await db
        .update(user)
        .set({ emailVerified: true })
        .where(eq(user.id, inviteeId!));
      await auth.api.acceptInvitation({
        body: { invitationId: pendingRows[0].id },
        headers: inviteeHeaders,
      });
      const inviteeTeams = await db
        .select({ teamId: teamMember.teamId })
        .from(teamMember)
        .where(eq(teamMember.userId, inviteeId!));
      expect(inviteeTeams.map((row) => row.teamId).sort()).toEqual(
        [teamA, teamB].sort(),
      );
      expect(
        (await listMemberProjectIds(inviteeId!, organizationId)).sort(),
      ).toEqual([projectA.id, projectB.id].sort());
      // Sanity: the teams still exist and belong to the org (nothing was torn down).
      expect(
        await db
          .select({ id: team.id })
          .from(team)
          .where(eq(team.organizationId, organizationId)),
      ).toHaveLength(2);
    } finally {
      // Organization cascade removes members/invitations/teams/projects/audit; users go last.
      if (organizationId) {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
      if (ownerId) await db.delete(user).where(eq(user.id, ownerId));
      if (memberId) await db.delete(user).where(eq(user.id, memberId));
      if (inviteeId) await db.delete(user).where(eq(user.id, inviteeId));
    }
  });
});

describe.runIf(!LIVE)("foh teams db smoke (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
