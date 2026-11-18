/**
 * Who may see which usage (issue #418). The same rules as the rest of the Build surface:
 *   - repository, agent, run and call pages need write on the repository (`requireProject`);
 *   - the overview lists only the repositories the viewer can write to;
 *   - connection pages are workspace-admin only, like Settings → Connections.
 * The org always comes from the session, never from the URL.
 */
import { data } from "react-router";

import { listAccessibleProjectIds } from "~/auth/project-access.server";
import type { SessionAuth } from "~/auth/session.server";
import {
  ensureWorkspace,
  isWorkspaceAdmin,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { listProjects } from "~/db/queries.server";

export interface UsageViewer {
  orgId: string;
  orgName: string;
  isAdmin: boolean;
  projects: { id: string; name: string; layout: "team" | "single" }[];
  visible: Set<string>;
}

export async function resolveUsageViewer(
  auth: SessionAuth,
  request: Request,
): Promise<UsageViewer> {
  await ensureWorkspace(request, auth);
  const active = await resolveActiveWorkspace(auth);
  if (!active) throw data("No organization", { status: 403 });
  const [writable, all] = await Promise.all([
    listAccessibleProjectIds(
      { userId: auth.user.id, workspaceRole: active.member.role, orgId: active.org.id },
      "write",
    ),
    listProjects(active.org.id),
  ]);
  const writableSet = new Set(writable);
  const projects = all
    .filter((p) => writableSet.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      layout: (p.layout === "team" ? "team" : "single") as "team" | "single",
    }));
  return {
    orgId: active.org.id,
    orgName: active.org.name,
    isAdmin: isWorkspaceAdmin(active.member.role),
    projects,
    visible: new Set(projects.map((p) => p.id)),
  };
}

/** Whether the viewer administers the active workspace (plan headroom, connection accounts). */
export async function isUsageAdmin(auth: SessionAuth): Promise<boolean> {
  const active = await resolveActiveWorkspace(auth);
  return active ? isWorkspaceAdmin(active.member.role) : false;
}
