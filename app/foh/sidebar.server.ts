/**
 * Front of House sidebar — the viewer-scoped team/agent tree (§3 left pane).
 *
 * Scope rule: the viewer sees exactly the repos they hold a grant on (project-access.server);
 * owners hold every repo implicitly. Each agent carries presence (●/○) and a needs-you badge
 * counted from pending question/approval inbox items visible to the viewer (D5: their own +
 * team-wide agent-opened ones).
 *
 * Deps are injectable so unit tests run over the FakeStore without Better Auth or Postgres.
 */
import {
  listAccessibleProjects,
  type ProjectGrant,
  type ProjectRole,
} from "~/auth/project-access.server";
import type { DataStore } from "~/data/ports";
import { listAgents } from "~/db/queries.server";
import { agentPresenceMap, type AgentPresence } from "~/foh/presence.server";
import { listFohSessionsByIds } from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

export interface FohViewer {
  userId: string;
  orgId: string;
  /** The Better Auth member role; owners see every repo, everyone else their grants. */
  workspaceRole: string;
}

export interface FohSidebarAgent {
  id: string;
  name: string;
  presence: AgentPresence;
  /** Pending question/approval items for this agent, visible to the viewer. */
  needsYou: number;
}

export interface FohSidebarTeam {
  projectId: string;
  /** Canonical page URL segment; projectId remains available for API/storage identity. */
  projectSlug?: string;
  name: string;
  /** The viewer's role on this repo — `write` shows the manage-in-Repositories link. */
  role: ProjectRole;
  agents: FohSidebarAgent[];
}

export interface FohSidebar {
  teams: FohSidebarTeam[];
  /** Every pending inbox item visible to the viewer (the 🔔 badge). */
  inboxCount: number;
}

export interface FohSidebarDeps {
  store?: DataStore;
  accessibleProjects?: (viewer: FohViewer) => Promise<ProjectGrant[]>;
  presence?: (agentIds: string[]) => Promise<Map<string, AgentPresence>>;
  /** #278: resolves pending items' sessions so archived ones can be dropped from the badges. */
  sessionsByIds?: (
    ids: string[],
  ) => Promise<Array<{ id: string; archivedAt?: Date | null }>>;
}

/**
 * Drop pending items whose FOH session has been archived (#278). Archiving resolves the items it
 * can see, but a park or a settling turn can file one in the same instant; filtering on the read
 * side means such an item can never become a badge that nothing behind it can clear.
 */
async function withoutArchivedSessions<T extends { sessionId: string }>(
  items: T[],
  deps: FohSidebarDeps,
): Promise<T[]> {
  if (items.length === 0) return items;
  const sessions = await (deps.sessionsByIds ?? listFohSessionsByIds)([
    ...new Set(items.map((item) => item.sessionId)),
  ]);
  const archived = new Set(
    sessions.flatMap((session) => (session.archivedAt ? [session.id] : [])),
  );
  return archived.size === 0
    ? items
    : items.filter((item) => !archived.has(item.sessionId));
}

/** The viewer's repo grants — the one scope rule every FOH list shares. */
export async function listViewerGrants(
  viewer: FohViewer,
  deps: FohSidebarDeps = {},
): Promise<ProjectGrant[]> {
  return (deps.accessibleProjects ?? listAccessibleProjects)(viewer);
}

/** The project ids the viewer may see in FOH. */
export async function listViewerProjectIds(
  viewer: FohViewer,
  deps: FohSidebarDeps = {},
): Promise<string[]> {
  return (await listViewerGrants(viewer, deps)).map((grant) => grant.projectId);
}

export async function loadFohSidebar(
  viewer: FohViewer,
  deps: FohSidebarDeps = {},
): Promise<FohSidebar> {
  const store = deps.store ?? getRuntime().data;
  const grants = await listViewerGrants(viewer, deps);
  const roleByProject = new Map(grants.map((g) => [g.projectId, g.role]));
  // Filter the org's list rather than trusting grant ids alone: a grant can only name a repo
  // of this org (the query joins on it), but the store is what says the repo still exists.
  const projects = (await store.projects.listByOrg(viewer.orgId)).filter(
    (project) => roleByProject.has(project.id),
  );

  const rosters = await Promise.all(
    projects.map((project) => listAgents(project.id, store)),
  );
  const agentIds = rosters.flat().map((agent) => agent.id);
  const [presence, allPending] = await Promise.all([
    (deps.presence ?? ((ids: string[]) => agentPresenceMap(ids, { store })))(
      agentIds,
    ),
    store.inboxItems.listPendingForProjects(
      projects.map((project) => project.id),
      viewer.userId,
    ),
  ]);

  // The badges must agree with the flyout, which drops archived sessions (#278). Counting an item
  // the flyout won't show is the worst of both: a needs-you dot with nothing behind it.
  const pending = await withoutArchivedSessions(allPending, deps);

  const needsYouByAgent = new Map<string, number>();
  for (const item of pending) {
    if (item.kind !== "question" && item.kind !== "approval") continue;
    if (!item.agentId) continue;
    needsYouByAgent.set(item.agentId, (needsYouByAgent.get(item.agentId) ?? 0) + 1);
  }

  return {
    teams: projects.map((project, i) => ({
      projectId: project.id,
      projectSlug: project.slug,
      name: project.name,
      role: roleByProject.get(project.id) ?? "read",
      agents: rosters[i].map((agent) => ({
        id: agent.id,
        name: agent.name,
        presence: presence.get(agent.id) ?? "idle",
        needsYou: needsYouByAgent.get(agent.id) ?? 0,
      })),
    })),
    inboxCount: pending.length,
  };
}
