/**
 * Build — the pathless layout behind every back-of-house page (`/dashboard`, `/repos/...`,
 * `/marketplace`, `/settings`, ...). It owns the sidebar's data: the repositories the viewer can
 * write to, with their rosters, plus who they are. `AppShell` (components/shell.tsx) reads it
 * through `useRouteLoaderData("routes/build")`, so the thirty-odd page modules that render
 * `<AppShell>` needed no change to gain the shared sidebar.
 *
 * Auth is deliberately NOT enforced here: every child page already decides that for itself
 * (`sessionLoader`, `requireProject`, ...), and a few — the workspace chooser, invitation
 * acceptance — have their own rules about org-less sessions. A signed-out or org-less visitor
 * just gets no sidebar data, and the shell renders its bare frame.
 */
import { Outlet, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from "react-router";

import { listAccessibleProjectIds } from "~/auth/project-access.server";
import { getSessionAuth } from "~/auth/session.server";
import { isWorkspaceAdmin, resolveActiveWorkspace } from "~/auth/workspace.server";
import { listAgents, listProjects } from "~/db/queries.server";
import type { SurfaceRepo } from "~/lib/surfaces";

export interface BuildSidebarRepo extends SurfaceRepo {
  id: string;
  name: string;
}

export interface BuildSidebarData {
  orgName: string;
  workspaceAdmin: boolean;
  repos: BuildSidebarRepo[];
}

export async function loader(args: LoaderFunctionArgs) {
  const session = await getSessionAuth(args);
  if (!session.user) return { user: null, sidebar: null };
  const active = await resolveActiveWorkspace(session);
  if (!active) return { user: session.user, sidebar: null };

  // The Build surface lists the repos the viewer can WRITE to — same rule as the dashboard.
  // Owners hold every repo; everyone else (admins included) only the ones they were granted.
  const viewer = {
    userId: session.user.id,
    workspaceRole: active.member.role,
    orgId: active.org.id,
  };
  const [writable, projects] = await Promise.all([
    listAccessibleProjectIds(viewer, "write"),
    listProjects(active.org.id).catch(() => []),
  ]);
  const writableSet = new Set(writable);
  const visible = projects.filter((project) => writableSet.has(project.id));
  const rosters = await Promise.all(visible.map((project) => listAgents(project.id)));

  const sidebar: BuildSidebarData = {
    orgName: active.org.name,
    workspaceAdmin: isWorkspaceAdmin(active.member.role),
    repos: visible.map((project, i) => ({
      id: project.id,
      slug: project.slug,
      name: project.name,
      layout: project.layout === "team" ? "team" : "single",
      agents: rosters[i].map((agent) => ({ id: agent.id, name: agent.name })),
    })),
  };
  return { user: session.user, sidebar };
}

/**
 * The repo list only changes through an action (connect, create member, uninstall...), so a
 * plain page-to-page navigation needn't re-run two queries. Landing on the dashboard is the
 * one GET that refreshes anyway: it is where you arrive after every out-of-band creation flow.
 */
export function shouldRevalidate({
  formMethod,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || nextUrl.pathname === "/dashboard") return defaultShouldRevalidate;
  return false;
}

export default function BuildLayout() {
  return <Outlet />;
}
