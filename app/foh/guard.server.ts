/**
 * Front of House route guard. NOT `requireProject`: that is the back-of-house chokepoint and
 * turns plain members away (D10). FOH access = org membership + (for members) membership of
 * the repo's Better Auth team; admins/owners see every org repo (§5 invites & roles).
 *
 * Out-of-scope projects 404 for members — indistinguishable from nonexistent, so a member
 * can't probe which repos exist in the workspace.
 */
import { data, redirect } from "react-router";

import type { SessionAuth } from "~/auth/session.server";
import { listMemberProjectIds } from "~/auth/teams.server";
import {
  ensureWorkspace,
  isBackOfHouse,
  resolveActiveWorkspace,
  type ActiveWorkspace,
} from "~/auth/workspace.server";
import { getProject, type Project } from "~/db/queries.server";
import { canonicalProjectUrl } from "~/project/guard.server";

export interface FohAccess {
  project: Project;
  active: ActiveWorkspace;
  /** Admin/owner: full repo visibility, every FOH session, and the BOH switcher. */
  backOfHouse: boolean;
}

/**
 * Pass `opts.request` from page-document GET loaders only (mirrors `requireProject`): an
 * org-less session then provisions/adopts a workspace instead of 403-ing. API/resource
 * routes omit it and stay hard failures.
 */
export async function requireFohProject(
  auth: SessionAuth,
  projectId: string | undefined,
  opts?: { request?: Request },
): Promise<FohAccess> {
  let active = await resolveActiveWorkspace(auth);
  if (!active) {
    if (!opts?.request) throw data("No organization", { status: 403 });
    await ensureWorkspace(opts.request, auth);
    active = await resolveActiveWorkspace(auth);
    if (!active) throw data("No organization", { status: 403 });
  }
  const project = projectId
    ? await getProject(active.org.id, projectId)
    : undefined;
  if (!project) throw data("Project not found", { status: 404 });
  const backOfHouse = isBackOfHouse(active.member.role);
  if (!backOfHouse) {
    const memberProjects = await listMemberProjectIds(
      auth.user.id,
      active.org.id,
    );
    if (!memberProjects.includes(project.id)) {
      throw data("Project not found", { status: 404 });
    }
  }
  if (opts?.request && projectId) {
    const canonical = canonicalProjectUrl(opts.request, projectId, project.slug);
    if (canonical) throw redirect(canonical, { status: 301 });
  }
  return { project, active, backOfHouse };
}
