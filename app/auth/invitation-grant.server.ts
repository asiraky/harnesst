/**
 * What a workspace invitation actually grants (issue #220 §4).
 *
 * The invite form refuses to MINT a `member` invitation without repos, but that alone cannot
 * hold the acceptance criterion — "no workspace invite can leave a user as a `member` with no
 * team" — because a stored grant can decay after it is sent:
 *
 *   - invitations created before this route existed carry `role = member` with `team_id = null`;
 *   - Better Auth strips a deleted team from every pending invitation (`crud-team.mjs`
 *     deleteTeam), so deleting the last selected repo empties a grant that was valid when sent.
 *
 * Either way the invitee accepts into limbo: not an admin, so no back of house; on no team, so
 * no front of house either. The invariant therefore has to be checked where it is consumed —
 * at acceptance, and before an admin extends a stale invitation by resending it.
 */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { invitation } from "~/db/auth-schema";
import { listProjects } from "~/db/queries.server";

export type InvitationGrant = {
  role?: string | null;
  /** Absent whenever the teams plugin is off, null once its last team is deleted. */
  teamId?: string | null;
  organizationId: string;
};

/** Better Auth stores multi-team invitations comma-separated. */
export function splitInvitationTeamIds(
  invitationTeamId: string | null | undefined,
): string[] {
  return (invitationTeamId ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Only a front-of-house-only grant depends on teams. Better Auth stores roles comma-separated
 * too, so a grant counts as member-only when `member` is all it carries — anything else (admin,
 * owner) reaches the workspace on its own.
 */
function isMemberOnly(role: string | null | undefined): boolean {
  const roles = (role || "member")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return roles.length > 0 && roles.every((name) => name === "member");
}

/**
 * Whether accepting this grant would leave the invitee with no access at all: a `member` whose
 * invitation names no team that still maps to a repository in the inviting workspace.
 */
export async function grantsNoAccess(grant: InvitationGrant): Promise<boolean> {
  if (!isMemberOnly(grant.role)) return false;
  const teamIds = new Set(splitInvitationTeamIds(grant.teamId));
  if (teamIds.size === 0) return true;
  // A team id is only worth something while a live repo points at it: the FK is set-null on
  // team delete, so a repo whose team is gone no longer matches.
  const projectList = await listProjects(grant.organizationId);
  return !projectList.some(
    (project) => project.teamId && teamIds.has(project.teamId),
  );
}

/**
 * The same check at the acceptance boundary, where the invitation is known only by id. An id
 * that matches nothing is not this module's problem — Better Auth raises the real error.
 */
export async function invitationGrantsNoAccess(
  invitationId: string,
): Promise<boolean> {
  if (!invitationId) return false;
  const [row] = await db
    .select({
      role: invitation.role,
      teamId: invitation.teamId,
      organizationId: invitation.organizationId,
    })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1);
  return row ? grantsNoAccess(row) : false;
}

/** Shown to an invitee whose grant decayed; they cannot fix it themselves. */
export const NO_ACCESS_INVITATION_MESSAGE =
  "This invitation no longer gives access to any repository. Ask a workspace admin to send you a new one.";
