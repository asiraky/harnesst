/**
 * Per-repo access (the workspace permissions model).
 *
 * Two layers, deliberately small:
 *
 *  - **Workspace role** (Better Auth member role): `owner` sees and administers everything;
 *    `admin` manages people, workspace settings, GitHub installations and creates repos, but
 *    reaches a repo only when granted one like anyone else; `member` has no workspace powers.
 *  - **Repo role** (`project_access` rows): `read` = front of house for that repo; `write` = front
 *    AND back of house — build, deploy, secrets, settings. There is no repo-level admin: anyone
 *    who can edit and deploy an agent can already make it exfiltrate the secrets it holds, so
 *    "write but not secrets" would be theatre.
 *
 * Only workspace owners/admins grant or revoke repo access, from /org/members. The creator of a
 * repo gets `write` on it. Every check here is scoped to the org so a grant can never be read or
 * written across tenants.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { invitation, member, user } from "~/db/auth-schema";
import {
  invitationProjectGrants,
  PROJECT_ROLES,
  projectAccess,
  projects,
  type ProjectRole,
} from "~/db/schema";
import { isWorkspaceOwner } from "./roles";

export { PROJECT_ROLES, type ProjectRole };

export function parseProjectRole(value: unknown): ProjectRole | null {
  return PROJECT_ROLES.includes(value as ProjectRole)
    ? (value as ProjectRole)
    : null;
}

/** `write` satisfies a `read` requirement; nothing satisfies `write` but `write`. */
export function roleSatisfies(
  role: ProjectRole | null | undefined,
  required: ProjectRole,
): boolean {
  if (!role) return false;
  return required === "read" || role === "write";
}

export type ProjectGrant = { projectId: string; role: ProjectRole };

/**
 * The viewer's effective role on ONE repo, or null when they have none. Owners are implicit
 * `write` everywhere; every other workspace role reads its row. The project must belong to the
 * org — callers already resolved it org-scoped, and the query re-checks anyway.
 */
export async function resolveProjectRole(input: {
  userId: string;
  workspaceRole: string;
  orgId: string;
  projectId: string;
}): Promise<ProjectRole | null> {
  if (isWorkspaceOwner(input.workspaceRole)) return "write";
  const rows = await db
    .select({ role: projectAccess.role })
    .from(projectAccess)
    .innerJoin(projects, eq(projects.id, projectAccess.projectId))
    .where(
      and(
        eq(projectAccess.projectId, input.projectId),
        eq(projectAccess.userId, input.userId),
        eq(projects.orgId, input.orgId),
      ),
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

/** Every repo in the org the viewer can reach, with their role on each. Owners get all. */
export async function listAccessibleProjects(input: {
  userId: string;
  workspaceRole: string;
  orgId: string;
}): Promise<ProjectGrant[]> {
  if (isWorkspaceOwner(input.workspaceRole)) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, input.orgId));
    return rows.map((row) => ({ projectId: row.id, role: "write" as const }));
  }
  const rows = await db
    .select({ projectId: projectAccess.projectId, role: projectAccess.role })
    .from(projectAccess)
    .innerJoin(projects, eq(projects.id, projectAccess.projectId))
    .where(
      and(
        eq(projectAccess.userId, input.userId),
        eq(projects.orgId, input.orgId),
      ),
    );
  return rows;
}

/** Project ids the viewer holds at least `minRole` on. */
export async function listAccessibleProjectIds(
  input: { userId: string; workspaceRole: string; orgId: string },
  minRole: ProjectRole = "read",
): Promise<string[]> {
  const grants = await listAccessibleProjects(input);
  return grants
    .filter((grant) => roleSatisfies(grant.role, minRole))
    .map((grant) => grant.projectId);
}

/**
 * Grant, change, or (role = null) revoke one user's access to one repo. The project is resolved
 * inside the org and the user must currently be a member of it: a grant to a stranger, or to a
 * repo in another workspace, is refused rather than silently written.
 */
export async function setProjectAccess(input: {
  orgId: string;
  projectId: string;
  userId: string;
  role: ProjectRole | null;
  grantedBy: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, input.projectId), eq(projects.orgId, input.orgId)),
    )
    .limit(1);
  if (!project) {
    return { ok: false, error: "That repository is not part of this workspace." };
  }
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, input.orgId),
        eq(member.userId, input.userId),
      ),
    )
    .limit(1);
  if (!membership) {
    return { ok: false, error: "That person is not a member of this workspace." };
  }
  if (input.role === null) {
    await db
      .delete(projectAccess)
      .where(
        and(
          eq(projectAccess.projectId, input.projectId),
          eq(projectAccess.userId, input.userId),
        ),
      );
    return { ok: true };
  }
  await db
    .insert(projectAccess)
    .values({
      projectId: input.projectId,
      userId: input.userId,
      role: input.role,
      grantedBy: input.grantedBy,
    })
    .onConflictDoUpdate({
      target: [projectAccess.projectId, projectAccess.userId],
      set: { role: input.role, grantedBy: input.grantedBy, updatedAt: new Date() },
    });
  return { ok: true };
}

/** The creator of a repo can work in it: `write`, no questions asked. Idempotent. */
export async function grantCreatorAccess(
  project: { id: string },
  userId: string,
): Promise<void> {
  await db
    .insert(projectAccess)
    .values({ projectId: project.id, userId, role: "write", grantedBy: userId })
    .onConflictDoUpdate({
      target: [projectAccess.projectId, projectAccess.userId],
      set: { role: "write", updatedAt: new Date() },
    });
}

/** Every grant in the org, for the members page grid. */
export async function listOrgProjectAccess(
  orgId: string,
): Promise<Array<ProjectGrant & { userId: string }>> {
  return db
    .select({
      projectId: projectAccess.projectId,
      userId: projectAccess.userId,
      role: projectAccess.role,
    })
    .from(projectAccess)
    .innerJoin(projects, eq(projects.id, projectAccess.projectId))
    .where(eq(projects.orgId, orgId));
}

/**
 * Drop every repo grant a user holds in an org. Grants hang off the user and the project, not
 * the membership row, so removing a workspace member must call this explicitly — otherwise a
 * re-invite would silently restore access the admin thought they had revoked.
 */
export async function revokeAllProjectAccess(
  orgId: string,
  userId: string,
): Promise<void> {
  await db.delete(projectAccess).where(
    and(
      eq(projectAccess.userId, userId),
      inArray(
        projectAccess.projectId,
        db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, orgId)),
      ),
    ),
  );
}

/** Whether a workspace member holds `write` on at least one repo (the "Repositories" link). */
export async function hasAnyWriteAccess(input: {
  userId: string;
  workspaceRole: string;
  orgId: string;
}): Promise<boolean> {
  if (isWorkspaceOwner(input.workspaceRole)) return true;
  const ids = await listAccessibleProjectIds(input, "write");
  return ids.length > 0;
}

// ── Invitation grants ─────────────────────────────────────────────────────────────────────

/**
 * Record what a freshly minted invitation grants. Projects are re-resolved inside the org so a
 * form-supplied id from another workspace is dropped rather than stored.
 */
export async function setInvitationGrants(input: {
  orgId: string;
  invitationId: string;
  grants: ProjectGrant[];
}): Promise<void> {
  if (input.grants.length === 0) return;
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.orgId, input.orgId),
        inArray(
          projects.id,
          input.grants.map((grant) => grant.projectId),
        ),
      ),
    );
  const allowed = new Set(owned.map((row) => row.id));
  const rows = input.grants
    .filter((grant) => allowed.has(grant.projectId))
    .map((grant) => ({
      invitationId: input.invitationId,
      projectId: grant.projectId,
      role: grant.role,
    }));
  if (rows.length === 0) return;
  await db.insert(invitationProjectGrants).values(rows).onConflictDoNothing();
}

/** The live grants (repo still exists) behind each of the given invitations. */
export async function listInvitationGrants(
  invitationIds: string[],
): Promise<Map<string, Array<ProjectGrant & { projectName: string }>>> {
  const result = new Map<string, Array<ProjectGrant & { projectName: string }>>();
  if (invitationIds.length === 0) return result;
  const rows = await db
    .select({
      invitationId: invitationProjectGrants.invitationId,
      projectId: invitationProjectGrants.projectId,
      role: invitationProjectGrants.role,
      projectName: projects.name,
    })
    .from(invitationProjectGrants)
    .innerJoin(projects, eq(projects.id, invitationProjectGrants.projectId))
    .where(inArray(invitationProjectGrants.invitationId, invitationIds));
  for (const row of rows) {
    const list = result.get(row.invitationId) ?? [];
    list.push({
      projectId: row.projectId,
      role: row.role,
      projectName: row.projectName,
    });
    result.set(row.invitationId, list);
  }
  return result;
}

/**
 * Turn an accepted invitation's grants into real access. Runs from Better Auth's
 * `afterAcceptInvitation` hook, so it covers the accept route AND a direct
 * `/api/auth/organization/accept-invitation` call alike. Scoped to the invitation's org: a grant
 * row can only name a project of the workspace that minted it (setInvitationGrants), and the
 * join re-checks it here.
 */
export async function applyInvitationGrants(input: {
  invitationId: string;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const rows = await db
    .select({
      projectId: invitationProjectGrants.projectId,
      role: invitationProjectGrants.role,
      inviterId: invitation.inviterId,
    })
    .from(invitationProjectGrants)
    .innerJoin(projects, eq(projects.id, invitationProjectGrants.projectId))
    .innerJoin(invitation, eq(invitation.id, invitationProjectGrants.invitationId))
    .where(
      and(
        eq(invitationProjectGrants.invitationId, input.invitationId),
        eq(projects.orgId, input.organizationId),
      ),
    );
  if (rows.length === 0) return;
  await db
    .insert(projectAccess)
    .values(
      rows.map((row) => ({
        projectId: row.projectId,
        userId: input.userId,
        role: row.role,
        grantedBy: row.inviterId,
      })),
    )
    .onConflictDoUpdate({
      target: [projectAccess.projectId, projectAccess.userId],
      set: { role: sql`excluded.role`, updatedAt: new Date() },
    });
}

/** The org member whose account email matches (case-insensitive), or null. */
export async function findOrgMemberIdByEmail(
  orgId: string,
  email: string,
): Promise<string | null> {
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, orgId),
        sql`lower(${user.email}) = ${email.toLowerCase()}`,
      ),
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}
