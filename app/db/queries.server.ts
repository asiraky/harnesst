/**
 * Tenant-scoped data access. Every read takes an `orgId` (the Better Auth organization from the session) and
 * filters by it, so a loader physically cannot read another tenant's rows (D2). These are thin
 * wrappers over the DataStore seam (app/data/ports.ts) — the org-scoping and slug-uniqueness
 * logic lives here in one place; the SQL lives in the Drizzle store; both are unit-testable
 * against an in-memory fake.
 */
import type { Agent, DataStore, Environment, Project } from "~/data/ports";
import {
  destroyEnvironmentInfra,
  ensureTeamEnvironments,
} from "~/deploy/environments.server";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget } from "~/seams/types";
import { PROJECT_SLUG_PATTERN, slugifyProjectName } from "~/lib/project-slug";

export type { Agent, Project, Environment } from "~/data/ports";

/** The default roster for a repo whose layout is unknown/single: a team of one. */
export const SINGLE_AGENT_ROSTER = [{ name: "agent", root: "agent" }] as const;

/**
 * Resolve a slug that's unique within the org: start from `base`, then suffix `-2`, `-3`, …
 * until `exists` reports it free. Pure but for the injected predicate, so it's unit-testable.
 */
export async function resolveUniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = base || "agent";
  let slug = root;
  for (let n = 2; await exists(slug); n++) {
    const suffix = `-${n}`;
    slug = `${root.slice(0, 60 - suffix.length)}${suffix}`;
  }
  return slug;
}

/**
 * Create a project (a connected eve repo) for a tenant, creating its agent roster (single =
 * team of one, PRD §7.9). Environments are team-level: `ensureTeamEnvironments` seeds the team
 * env set (here, just "default") across every member, so every member has a row of every name.
 * `slug` is unique per org; on collision we suffix so connecting similarly-named repos doesn't fail.
 */
export async function createProject(
  input: {
    orgId: string;
    name: string;
    slug?: string;
    repoOwner?: string | null;
    repoName?: string | null;
    repoInstallationId?: string | null;
    defaultBranch?: string;
    layout?: "single" | "team";
    /** Detected roster (detectAgentRoots); defaults to a single root agent. */
    roster?: { name: string; root: string }[];
  },
  store: DataStore = getRuntime().data,
): Promise<Project> {
  const slug = await resolveUniqueSlug(
    slugifyProjectName(input.slug ?? input.name),
    async (candidate) =>
      (await store.projects.slugExists(input.orgId, candidate)) ||
      (await store.projects.findById(candidate)) !== null,
  );
  const { slug: _ignore, roster: rosterInput, ...rest } = input;
  const project = await store.projects.create({ ...rest, slug });
  const roster = rosterInput ?? [...SINGLE_AGENT_ROSTER];
  await store.agents.syncRoster(project.id, roster, {
    allowEmpty: rosterInput !== undefined,
  });
  // Team-level env seeding: one converge fans the team env set (just "default" on a fresh
  // project) across every member, instead of per-agent ensureDefault loops.
  await ensureTeamEnvironments(project.id, { store });
  return project;
}

/**
 * A project's ROSTER — the user-facing members (`kind === 'member'`), by name. The built-in
 * assistant (`kind === 'assistant'`) is never a roster member, so it is filtered out here; this
 * is the single choke point that keeps it off team cards, the member switcher, delegation
 * targeting, and `resolveAgentContext`'s active-member selection. Surfaces that legitimately
 * need the assistant row (drafts / `agentForPath`, the assistant instance service) read
 * `store.agents.listByProject` / `findAssistantAgent` directly.
 */
export async function listAgents(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Agent[]> {
  const all = await store.agents.listByProject(projectId);
  return all.filter((a) => a.kind === "member");
}

/** Every agent row including internal ones (assistant) — for drafts attribution and the like. */
export function listAllAgents(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Agent[]> {
  return store.agents.listByProject(projectId);
}

/** The project's built-in assistant agent row, or null. */
export function findAssistantAgent(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Agent | null> {
  return store.agents.findAssistant(projectId);
}

/**
 * Layout detection names the root-layout member "agent", but the human may have given it a
 * real name at create time — the directory convention can't carry it. Preserve the existing
 * name for the root member so a sync never clobbers it. Team members are named by their
 * directory, so they pass through untouched.
 */
export function withPreservedNames(
  existing: Agent[],
  detected: { name: string; root: string }[],
): { name: string; root: string }[] {
  const rootMember = existing.find((a) => a.root === "agent");
  return detected.map((d) =>
    d.root === "agent" && rootMember
      ? { name: rootMember.name, root: d.root }
      : d,
  );
}

/**
 * Decide how a pending member rename maps onto a freshly-detected roster. A rename is "in
 * flight" when a member row carries `pendingName` (its saved directory move hasn't published
 * yet). We map the row IN PLACE — preserving its id and all FKs — only when the landed tree is
 * unambiguous:
 *
 *  - `apply`: the pending target directory is now detected AND the old directory is gone → the
 *    rename published. Rename the row to the target name/root and clear `pendingName`.
 *  - `clear`: BOTH the old and the new directory are detected as separate members → the pending
 *    name is stale (e.g. the saved rename was discarded and a genuinely new member later took
 *    that name). Drop the pending mark so it can never hijack that unrelated member.
 *  - otherwise (old present, new absent): the rename hasn't published — leave the mark alone.
 *
 * Pure over its inputs (the store does the writes), so the mapping rule is unit-testable.
 */
export function planPendingRenames(
  existing: Agent[],
  detected: { name: string; root: string }[],
): {
  apply: { id: string; oldName: string; newName: string; root: string }[];
  clear: string[];
} {
  const detectedByName = new Map(detected.map((d) => [d.name, d]));
  const apply: {
    id: string;
    oldName: string;
    newName: string;
    root: string;
  }[] = [];
  const clear: string[] = [];
  for (const row of existing) {
    if (row.kind !== "member" || !row.pendingName) continue;
    const target = detectedByName.get(row.pendingName);
    if (!target) continue; // new directory not present yet — rename unpublished, or row being pruned.
    if (detectedByName.has(row.name)) {
      clear.push(row.id); // old dir still present too → stale pending mark.
    } else {
      apply.push({
        id: row.id,
        oldName: row.name,
        newName: row.pendingName,
        root: target.root,
      });
    }
  }
  return { apply, clear };
}

/** Restage a renamed member's staged drafts under the new `agents/<new>/…` path prefix. */
async function rewriteMemberDraftPaths(
  projectId: string,
  oldName: string,
  newName: string,
  agentId: string,
  store: DataStore,
): Promise<void> {
  const prefix = `agents/${oldName}/`;
  const affected = (await store.drafts.listByProject(projectId)).filter((d) =>
    d.path.startsWith(prefix),
  );
  if (affected.length === 0) return;
  for (const d of affected) {
    await store.drafts.upsert({
      projectId,
      agentId,
      path: `agents/${newName}/${d.path.slice(prefix.length)}`,
      content: d.content,
      baseSha: d.baseSha,
      createdBy: d.createdBy,
    });
  }
  await store.drafts.deleteByPaths(
    projectId,
    affected.map((d) => d.path),
  );
}

/**
 * Reconcile the roster with the repo's detected layout (connect revisit, webhook). Environments
 * are team-level, so a converge (`ensureTeamEnvironments`) fans the team env set across the
 * roster: a NEW member automatically inherits EVERY team env name — that's the mechanism that
 * keeps a member from existing in one environment but not another. Members that already have all
 * the team names are left untouched (create swallows the drift dup), so the self-heal that runs
 * on every project landing load never disturbs user CRUD. Removed members get their instance infra
 * torn down first (containers + world DBs — the row cascade can't do that), then cascade away;
 * the root member's human-given name survives detection.
 *
 * This is also the SHIP POINT for pending install secrets (PLAN-SECRETS-REWORK §4.4): a
 * new-member install holds its secrets sealed until the member's agents row exists — which
 * happens exactly here, when the merged `agents/<name>/` directory is first detected. Held
 * values migrate into the member's real secret rows and the pending rows are deleted.
 */
export async function syncProjectAgents(
  projectId: string,
  roster: { name: string; root: string }[],
  store: DataStore = getRuntime().data,
  deployTarget?: DeployTarget,
  options?: { allowEmpty?: boolean },
): Promise<Agent[]> {
  const existing = await store.agents.listByProject(projectId);
  const existingNames = new Set(existing.map((a) => a.name));

  // A pending rename (saved directory move) whose publish just landed must be mapped IN
  // PLACE — otherwise syncRoster would prune the old-named row (cascading its environments,
  // releases, secrets and drafts away) and insert a bare new row. Apply the in-place renames
  // BEFORE syncRoster so its upsert matches the row by its new name and the prune leaves it be.
  const { apply: renames, clear: staleRenames } = planPendingRenames(
    existing,
    roster,
  );
  for (const id of staleRenames) await store.agents.setPendingName(id, null);
  for (const r of renames) {
    await store.agents.rename(r.id, { name: r.newName, root: r.root });
    // The row's id is unchanged, so agent-keyed rows (secrets, releases, envs) already follow.
    // The two name-keyed carries need moving: staged drafts under the old member directory, and
    // any still-held pending install secrets → the now-existing agent's real secrets.
    await rewriteMemberDraftPaths(projectId, r.oldName, r.newName, r.id, store);
    try {
      const { migratePendingSecrets } =
        await import("~/project/secrets.server");
      await migratePendingSecrets({
        projectId,
        memberName: r.oldName,
        agentId: r.id,
      });
    } catch (error) {
      console.warn(
        `[secrets] rename migration failed for ${r.oldName}→${r.newName}:`,
        error,
      );
    }
    // The renamed member is not "created" — its held secrets were handled above.
    existingNames.add(r.newName);
  }

  // Members about to be PRUNED — their directory vanished from the detected tree (a published
  // remove-member deletion, or one pushed straight to the repo). syncRoster's row
  // cascade takes their environments, deployments and secrets, but rows can't stop docker
  // containers or drop world DBs — and after the cascade those ids are the ONLY handle on that
  // infra. Tear it down FIRST, best-effort, exactly like deleteTeamEnvironment. Renamed rows
  // were mapped in place above, so a landed rename never reads as a removal here.
  const finalRoster = withPreservedNames(existing, roster);
  if (roster.length > 0 || options?.allowEmpty) {
    const keep = new Set(finalRoster.map((m) => m.name));
    const renamedIds = new Set(renames.map((r) => r.id));
    const pruned = existing.filter(
      (a) => a.kind === "member" && !renamedIds.has(a.id) && !keep.has(a.name),
    );
    if (pruned.length > 0) {
      const target = deployTarget ?? getRuntime().deployTarget;
      for (const member of pruned) {
        for (const env of await store.environments.listByAgent(member.id)) {
          await destroyEnvironmentInfra(env.id, {
            store,
            deployTarget: target,
          });
        }
      }
    }
  }

  const agents = await store.agents.syncRoster(projectId, finalRoster, options);
  // A new member inherits the team's full env set here — this converge is what guarantees no
  // member is left existing in one environment but not another.
  await ensureTeamEnvironments(projectId, { store });
  const memberAgents = agents.filter((a) => a.kind === "member");
  const created = memberAgents.filter((a) => !existingNames.has(a.name));
  if (created.length > 0) {
    const { migratePendingSecrets } = await import("~/project/secrets.server");
    for (const agent of created) {
      try {
        await migratePendingSecrets({
          projectId,
          memberName: agent.name,
          agentId: agent.id,
        });
      } catch (error) {
        // Never let a secrets hiccup break roster sync; held rows remain for the next sync.
        console.warn(
          `[secrets] pending migration failed for ${agent.name}:`,
          error,
        );
      }
    }
  }
  return memberAgents;
}

/**
 * The roster member a repo path belongs to — longest matching root wins ("agent" vs
 * "agents/pm/agent" can't actually collide, but be precise anyway). A team member owns its
 * whole package directory (`agents/<name>/…`), not just the `agent/` config inside it —
 * otherwise `agents/<name>/package.json` stages as a "shared" draft that rides along into
 * publishes from unrelated members. Null when the path is outside every member (e.g. the
 * root package.json of a single-agent repo).
 */
export function agentForPath(agents: Agent[], path: string): Agent | null {
  let best: Agent | null = null;
  for (const a of agents) {
    const packageDir = a.root.match(/^(agents\/[^/]+)\/agent$/)?.[1];
    const owns =
      path === a.root ||
      path.startsWith(`${a.root}/`) ||
      (packageDir !== undefined && path.startsWith(`${packageDir}/`));
    if (owns) {
      if (!best || a.root.length > best.root.length) best = a;
    }
  }
  return best;
}

/** Environments for a project, in creation order (all roster members). */
export function listEnvironments(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Environment[]> {
  return store.environments.listByProject(projectId);
}

/** Environments for one roster member, in creation order. */
export function listAgentEnvironments(
  agentId: string,
  store: DataStore = getRuntime().data,
): Promise<Environment[]> {
  return store.environments.listByAgent(agentId);
}

/** List a tenant's projects, newest first. */
export function listProjects(
  orgId: string,
  store: DataStore = getRuntime().data,
) {
  return store.projects.listByOrg(orgId);
}

/** Fetch one project by id first, then slug, scoped to the tenant. */
export async function getProject(
  orgId: string,
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Project | undefined> {
  return (await store.projects.getByOrg(orgId, projectId)) ?? undefined;
}

export type RenameProjectResult =
  | { ok: true; project: Project }
  | { ok: false; field: "name" | "slug"; error: string };

function isProjectSlugUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const pg = current as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (
      pg.code === "23505" &&
      (pg.constraint_name === "projects_org_slug_uq" ||
        pg.constraint === "projects_org_slug_uq")
    ) return true;
    current = pg.cause;
  }
  return false;
}

/** Validate and instantly rename harnesst's project row; no repository content is changed. */
export async function renameProject(
  projectId: string,
  input: { name: string; slug: string },
  store: DataStore = getRuntime().data,
): Promise<RenameProjectResult> {
  const project = await store.projects.findById(projectId);
  if (!project) throw new Error("Project not found");

  const name = input.name.trim();
  if (!name) return { ok: false, field: "name", error: "Name is required." };

  const suppliedSlug = input.slug.trim();
  const autoSlug = suppliedSlug === "";
  let slug = autoSlug ? slugifyProjectName(name) : suppliedSlug;
  if (slug.length < 2 || slug.length > 60 || !PROJECT_SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      field: "slug",
      error: "Use 2–60 lowercase letters, numbers, and single hyphens (no leading or trailing hyphen).",
    };
  }

  const unavailable = async (candidate: string) =>
    (candidate !== project.slug &&
      (await store.projects.slugExists(project.orgId, candidate))) ||
    (await store.projects.findById(candidate)) !== null;

  if (autoSlug) slug = await resolveUniqueSlug(slug, unavailable);
  else if (await unavailable(slug)) {
    return { ok: false, field: "slug", error: "That URL is already taken." };
  }

  try {
    return { ok: true, project: await store.projects.rename(project.id, { name, slug }) };
  } catch (error) {
    if (isProjectSlugUniqueViolation(error)) {
      return { ok: false, field: "slug", error: "That URL is already taken." };
    }
    throw error;
  }
}

/**
 * Fetch a project by its globally-unique id WITHOUT tenant scoping — the deep-link case
 * (issue #56): a `/repos/:projectId` link to a project in another workspace the user belongs to.
 * Callers MUST re-check the viewer's membership in the returned project's org before acting on
 * it; this is never a substitute for the org-scoped `getProject`.
 */
export async function findProjectAnyOrg(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<Project | null> {
  return store.projects.findById(projectId);
}

/** Releases for a project, newest first (D9 version history). */
export function listReleases(
  projectId: string,
  store: DataStore = getRuntime().data,
) {
  return store.releases.listByProject(projectId);
}
