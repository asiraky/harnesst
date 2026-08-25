/**
 * Front of House route guard. `read` on the repo is enough to enter (project-access.server);
 * `backOfHouse` is true when the viewer holds `write` — the full, unredacted view plus the
 * switcher into /repos. Out-of-scope projects 404 — indistinguishable from nonexistent, so a
 * member can't probe which repos exist in the workspace.
 */
import type { SessionAuth } from "~/auth/session.server";
import type { ActiveWorkspace } from "~/auth/workspace.server";
import type { Project } from "~/db/queries.server";
import { requireProjectAccess } from "~/project/guard.server";

export interface FohAccess {
  project: Project;
  active: ActiveWorkspace;
  /** `write` on this repo: full visibility, every FOH session, and the BOH switcher. */
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
  const access = await requireProjectAccess(auth, projectId, "read", opts);
  return {
    project: access.project,
    active: access.active,
    backOfHouse: access.role === "write",
  };
}
