/**
 * Front of House sidebar — the viewer-scoped team/agent tree (§3 left pane).
 *
 * Scope rule (§5 invites & roles): admins/owners see every org repo; a `member` sees only the
 * repos whose Better Auth team they belong to (D9). Each agent carries presence (●/○) and a
 * needs-you badge counted from pending question/approval inbox items visible to the viewer
 * (D5: their own + team-wide agent-opened ones).
 *
 * Deps are injectable so unit tests run over the FakeStore without Better Auth or Postgres.
 */
import { ensureProjectTeam, listMemberProjectIds } from "~/auth/teams.server";
import type { DataStore, Project } from "~/data/ports";
import { listAgents } from "~/db/queries.server";
import { agentPresenceMap, type AgentPresence } from "~/foh/presence.server";
import { listFohSessionsByIds } from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

export interface FohViewer {
  userId: string;
  orgId: string;
  /** Admin/owner — sees all repos (and lazily mints missing repo teams, D9). */
  backOfHouse: boolean;
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
  name: string;
  agents: FohSidebarAgent[];
}

export interface FohSidebar {
  teams: FohSidebarTeam[];
  /** Every pending inbox item visible to the viewer (the 🔔 badge). */
  inboxCount: number;
}

export interface FohSidebarDeps {
  store?: DataStore;
  memberProjectIds?: (userId: string, orgId: string) => Promise<string[]>;
  ensureTeam?: (orgId: string, project: Project) => Promise<unknown>;
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

/** The project ids the viewer may see in FOH — the one scope rule every FOH list shares. */
export async function listViewerProjectIds(
  viewer: FohViewer,
  deps: FohSidebarDeps = {},
): Promise<string[]> {
  const store = deps.store ?? getRuntime().data;
  if (viewer.backOfHouse) {
    const projects = await store.projects.listByOrg(viewer.orgId);
    return projects.map((project) => project.id);
  }
  const memberIds = deps.memberProjectIds ?? listMemberProjectIds;
  return memberIds(viewer.userId, viewer.orgId);
}

export async function loadFohSidebar(
  viewer: FohViewer,
  deps: FohSidebarDeps = {},
): Promise<FohSidebar> {
  const store = deps.store ?? getRuntime().data;
  const allProjects = await store.projects.listByOrg(viewer.orgId);
  let projects: Project[];
  if (viewer.backOfHouse) {
    projects = allProjects;
    // Lazy D9 backfill: pre-teams repos get their Better Auth team on first admin FOH load,
    // so invite-to-repo always has a team to carry. Best-effort — a Better Auth hiccup must
    // not take down the home surface.
    const ensureTeam = deps.ensureTeam ?? ensureProjectTeam;
    for (const project of projects) {
      if (project.teamId) continue;
      try {
        await ensureTeam(viewer.orgId, project);
      } catch (error) {
        console.warn(
          `[foh] could not ensure team for project ${project.id}: ${(error as Error).message}`,
        );
      }
    }
  } else {
    const memberIds = deps.memberProjectIds ?? listMemberProjectIds;
    const scope = new Set(await memberIds(viewer.userId, viewer.orgId));
    projects = allProjects.filter((project) => scope.has(project.id));
  }

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
      name: project.name,
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
