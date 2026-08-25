/**
 * What a workspace invitation actually grants (issue #220 §4).
 *
 * The invite form refuses to MINT a `member` invitation without repos, but that alone cannot
 * hold the acceptance criterion — "no workspace invite can leave a user as a `member` with no
 * access" — because a stored grant can decay after it is sent: every repo it named can be
 * deleted (the grant rows cascade away with the project). The invitee would then accept into
 * limbo: no workspace powers, no repo. The invariant therefore has to be checked where it is
 * consumed — at acceptance, and before an admin extends a stale invitation by resending it.
 */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { invitation } from "~/db/auth-schema";
import { isWorkspaceAdmin } from "./roles";
import { listInvitationGrants } from "./project-access.server";

export type InvitationGrant = {
  id: string;
  role?: string | null;
};

/**
 * Whether accepting this grant would leave the invitee with no access at all: a plain `member`
 * whose invitation names no repository that still exists. Admins/owners can always create
 * repos, so their invitations never decay.
 */
export async function grantsNoAccess(grant: InvitationGrant): Promise<boolean> {
  if (isWorkspaceAdmin(grant.role || "member")) return false;
  const grants = await listInvitationGrants([grant.id]);
  return (grants.get(grant.id) ?? []).length === 0;
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
    .select({ id: invitation.id, role: invitation.role })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1);
  return row ? grantsNoAccess(row) : false;
}

/** Shown to an invitee whose grant decayed; they cannot fix it themselves. */
export const NO_ACCESS_INVITATION_MESSAGE =
  "This invitation no longer gives access to any repository. Ask a workspace admin to send you a new one.";
