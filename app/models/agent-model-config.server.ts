/**
 * The workspace's agent-model configuration — the single source of truth a running agent's
 * generated `harnesst/model.ts` resolves against (`GET /api/gateway/v1/model-config`).
 *
 * A configuration TARGET is `(agentName, subagentPath)`: `subagentPath === ""` is the top-level
 * agent, `researcher/fact-checker` is a declared subagent nested under it (issue #344).
 * Resolution is a deliberately boring chain: the target's own override wins, else the nearest
 * ancestor's override (a subagent inherits its parent unless it says otherwise), else the
 * workspace default (`workspace_settings.assistant_model`), else nothing — and "nothing" is
 * surfaced to the agent as a readable "configure a model in Org settings" error, never a silent
 * fallback. Already-deployed agents ask with the parent name only, so they land on `""` and keep
 * resolving exactly as they did before subagent targets existed.
 *
 * `projectId` is part of the KEY, not a hint: two repos in one workspace routinely hold same-named
 * members and subagents, so a row belongs to exactly one repo. Rows written before that column
 * existed carry `''` — the legacy, unattributed row, which answers for any repo that has none of
 * its own and is what a name-only (pre-#344) deployment resolves through. Every write from a repo
 * surface keys that repo, so one repo's save can never overwrite another's row and one repo's
 * "use the default" can never delete another's pin.
 *
 * `pickAgentModel` and `pickTargetModel` are pure so the ordering contract unit-tests with zero
 * I/O.
 */
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "~/db/client.server";
import { agentModelOverrides } from "~/db/schema";
import type { ReasoningEffort } from "~/models/reasoning";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";

export interface AgentModelSelection {
  /** Connection-qualified model ref, e.g. `anthropic/<connectionId>/<model>`. */
  model: string;
  effort: ReasoningEffort | null;
}

/**
 * The repo of a legacy, unattributed row. `''` rather than NULL because the column is part of the
 * primary key — and because "no repo" is a real, resolvable target, not a missing value.
 */
export const UNSCOPED_PROJECT = "";

/** One configuration target: an agent, or a declared subagent nested beneath it. */
export interface ModelTargetKey {
  /** The eve agent name (`harnesstAgentModel('<name>')` argument) of the MEMBER agent. */
  agentName: string;
  /** `/`-joined declared-subagent segments below the member root; `""` is the agent itself. */
  subagentPath: string;
  /** The repo the target lives in; omit/null only for legacy, name-only resolution. */
  projectId?: string | null;
}

/** A stored row's full primary key — every column, including the repo it belongs to. */
export interface ModelOverrideRowKey {
  agentName: string;
  subagentPath: string;
  /** The exact stored value: a project id, or `UNSCOPED_PROJECT` for the legacy row. */
  projectId: string;
}

export interface AgentModelOverride extends AgentModelSelection {
  agentName: string;
  subagentPath: string;
  /** `''` for a legacy row that belongs to no repo in particular. */
  projectId: string;
}

export interface ResolvedAgentModel extends AgentModelSelection {
  /** Which layer answered: the agent's explicit override or the workspace default. */
  source: "override" | "workspace-default";
}

export interface ResolvedTargetModel extends AgentModelSelection {
  /** Which layer answered: this target, an ancestor target, or the workspace default. */
  source: "override" | "parent-override" | "workspace-default";
  /**
   * For `parent-override`: the ancestor's `subagentPath` whose row answered (`""` = the member
   * agent itself), so the UI can say WHICH level the selection is inherited from.
   */
  inheritedFrom?: string;
}

/** Override wins; the workspace default answers otherwise; null means nothing is configured. */
export function pickAgentModel(
  override: AgentModelSelection | null,
  workspaceDefault: { model: string | null; effort: ReasoningEffort | null },
): ResolvedAgentModel | null {
  if (override) return { ...override, source: "override" };
  if (workspaceDefault.model) {
    return {
      model: workspaceDefault.model,
      effort: workspaceDefault.effort,
      source: "workspace-default",
    };
  }
  return null;
}

/**
 * Every target a `subagentPath` inherits from, nearest first: itself, each ancestor prefix, then
 * the member agent (`""`). `"a/b"` → `["a/b", "a", ""]`.
 */
export function inheritanceChain(subagentPath: string): string[] {
  const chain: string[] = [];
  // Normalize first: a stray leading/doubled slash must not invent an ancestor.
  let current = subagentPath.split("/").filter(Boolean).join("/");
  for (;;) {
    chain.push(current);
    if (current === "") break;
    const cut = current.lastIndexOf("/");
    current = cut === -1 ? "" : current.slice(0, cut);
  }
  return chain;
}

/**
 * The chain from the module doc, applied to the override rows of ONE agent name: the target's
 * own row, else the nearest ancestor's, else the workspace default, else nothing. Pure.
 */
export function pickTargetModel(
  subagentPath: string,
  overridesByPath: ReadonlyMap<string, AgentModelSelection>,
  workspaceDefault: { model: string | null; effort: ReasoningEffort | null },
): ResolvedTargetModel | null {
  const chain = inheritanceChain(subagentPath);
  const target = chain[0];
  for (const path of chain) {
    const row = overridesByPath.get(path);
    if (!row) continue;
    return path === target
      ? { ...row, source: "override" }
      : { ...row, source: "parent-override", inheritedFrom: path };
  }
  if (workspaceDefault.model) {
    return {
      model: workspaceDefault.model,
      effort: workspaceDefault.effort,
      source: "workspace-default",
    };
  }
  return null;
}

/**
 * A row answers for a target when it belongs to the same repo, or is the legacy row belonging to
 * no repo at all. A row pinned to a DIFFERENT project deliberately does not answer — that is the
 * cross-repo collision `project_id` exists to stop. An unscoped lookup (a legacy deployment that
 * sends no project) has no filter at all: it resolves by name, as it always did.
 */
function projectScope(projectId: string | null | undefined) {
  return projectId
    ? inArray(agentModelOverrides.projectId, [projectId, UNSCOPED_PROJECT])
    : undefined;
}

/**
 * Which of several matching rows answers first.
 *
 * Scoped: this repo's own row, then the legacy one. Unscoped: the legacy (`''`) row — it sorts
 * before every real project id — then the lowest project id, so a name-only lookup is
 * deterministic instead of whatever Postgres happened to return.
 */
function preferenceOrder(projectId: string | null | undefined): SQL[] {
  const byProject = asc(agentModelOverrides.projectId) as SQL;
  return projectId
    ? [
        sql`case when ${agentModelOverrides.projectId} = ${projectId} then 0 else 1 end`,
        byProject,
      ]
    : [byProject];
}

export async function listAgentModelOverrides(
  orgId: string,
): Promise<AgentModelOverride[]> {
  const rows = await db
    .select({
      agentName: agentModelOverrides.agentName,
      subagentPath: agentModelOverrides.subagentPath,
      projectId: agentModelOverrides.projectId,
      model: agentModelOverrides.model,
      effort: agentModelOverrides.effort,
    })
    .from(agentModelOverrides)
    .where(eq(agentModelOverrides.orgId, orgId))
    .orderBy(
      agentModelOverrides.agentName,
      agentModelOverrides.subagentPath,
      agentModelOverrides.projectId,
    );
  return rows.map((r) => ({
    agentName: r.agentName,
    subagentPath: r.subagentPath,
    projectId: r.projectId,
    model: r.model,
    effort: (r.effort as ReasoningEffort | null) ?? null,
  }));
}

export async function getAgentModelOverride(
  orgId: string,
  key: ModelTargetKey,
): Promise<AgentModelSelection | null> {
  const [row] = await db
    .select({
      model: agentModelOverrides.model,
      effort: agentModelOverrides.effort,
    })
    .from(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.orgId, orgId),
        eq(agentModelOverrides.agentName, key.agentName),
        eq(agentModelOverrides.subagentPath, key.subagentPath),
        projectScope(key.projectId),
      ),
    )
    .orderBy(...preferenceOrder(key.projectId))
    .limit(1);
  return row
    ? { model: row.model, effort: (row.effort as ReasoningEffort | null) ?? null }
    : null;
}

/**
 * Pin a target's model. The row is keyed by the CALLER's repo — never `''`: a write always comes
 * from one repo's configuration surface, and writing the unattributed row would put it back in the
 * business of answering for every other repo with the same agent name. The runtime never writes.
 */
export async function setAgentModelOverride(
  orgId: string,
  key: ModelTargetKey,
  selection: AgentModelSelection,
): Promise<void> {
  const projectId = key.projectId;
  if (!projectId) {
    throw new Error(
      "A model override must be written against the repo it belongs to (missing projectId).",
    );
  }
  await db
    .insert(agentModelOverrides)
    .values({
      orgId,
      agentName: key.agentName,
      subagentPath: key.subagentPath,
      projectId,
      model: selection.model,
      effort: selection.effort,
    })
    .onConflictDoUpdate({
      target: [
        agentModelOverrides.orgId,
        agentModelOverrides.projectId,
        agentModelOverrides.agentName,
        agentModelOverrides.subagentPath,
      ],
      set: {
        model: selection.model,
        effort: selection.effort,
        updatedAt: new Date(),
      },
    });
}

/**
 * Clear the override one repo's UI shows for a target: its own row and the legacy `''` row it
 * would otherwise fall back to (that legacy row IS what the page was displaying). Another repo's
 * pinned row is never touched — it is not this repo's to delete.
 */
export async function removeAgentModelOverride(
  orgId: string,
  key: ModelTargetKey,
): Promise<void> {
  const projectId = key.projectId;
  if (!projectId) {
    throw new Error(
      "A model override must be cleared against the repo it belongs to (missing projectId).",
    );
  }
  await db
    .delete(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.orgId, orgId),
        eq(agentModelOverrides.agentName, key.agentName),
        eq(agentModelOverrides.subagentPath, key.subagentPath),
        inArray(agentModelOverrides.projectId, [projectId, UNSCOPED_PROJECT]),
      ),
    );
}

/**
 * Delete exactly ONE stored row, by its full primary key — for org-level surfaces that list rows
 * and remove the one the human pointed at (Org settings, connection removal).
 */
export async function removeAgentModelOverrideRow(
  orgId: string,
  key: ModelOverrideRowKey,
): Promise<void> {
  await db
    .delete(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.orgId, orgId),
        eq(agentModelOverrides.agentName, key.agentName),
        eq(agentModelOverrides.subagentPath, key.subagentPath),
        eq(agentModelOverrides.projectId, key.projectId),
      ),
    );
}

/**
 * Every override row belonging to one repo. `project_id` carries no foreign key (`''` is not a
 * project id), so a deleted repo takes its rows with it here rather than by cascade.
 */
export async function removeProjectModelOverrides(
  orgId: string,
  projectId: string,
): Promise<void> {
  if (!projectId) return;
  await db
    .delete(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.orgId, orgId),
        eq(agentModelOverrides.projectId, projectId),
      ),
    );
}

/**
 * Drop the override for a declared subagent subtree that no longer exists — the row for
 * `subagentPathPrefix` and every descendant of it. Called from the publish pipeline once a
 * deletion has actually landed on the default branch, so a pre-publish deletion stays fully
 * reversible. A prefix of `""` prunes the whole agent (a removed team member).
 *
 * Legacy rows belonging to no repo (`project_id = ''`) are pruned only below the member root: a
 * repo-less TOP-LEVEL row may be the one another repo's same-named agent is still resolving
 * through (issue #344 scope note), and losing that silently would be worse than leaving an orphan.
 */
export async function cleanupSubagentOverrides(
  orgId: string,
  projectId: string,
  agentName: string,
  subagentPathPrefix: string,
): Promise<void> {
  const matchesPrefix =
    subagentPathPrefix === ""
      ? undefined
      : or(
          eq(agentModelOverrides.subagentPath, subagentPathPrefix),
          sql`${agentModelOverrides.subagentPath} like ${`${subagentPathPrefix}/%`}`,
        );
  await db.delete(agentModelOverrides).where(
    and(
      eq(agentModelOverrides.orgId, orgId),
      eq(agentModelOverrides.agentName, agentName),
      matchesPrefix,
      or(
        eq(agentModelOverrides.projectId, projectId),
        and(
          eq(agentModelOverrides.projectId, UNSCOPED_PROJECT),
          sql`${agentModelOverrides.subagentPath} <> ''`,
        ),
      ),
    ),
  );
}

/** The model the named agent should run right now, per the layering in the module doc. */
export async function resolveAgentModel(
  orgId: string,
  agentName: string,
): Promise<ResolvedAgentModel | null> {
  const [override, workspaceDefault] = await Promise.all([
    getAgentModelOverride(orgId, { agentName, subagentPath: "" }),
    getWorkspaceAssistantSelection(orgId),
  ]);
  return pickAgentModel(override, workspaceDefault);
}

/**
 * The model one configuration target should run right now: its own override, else the nearest
 * ancestor's (which is how a declared subagent inherits its parent with no row of its own), else
 * the workspace default. The inheritance lives HERE, server-side, so an already-deployed
 * subagent that still asks with only its parent's name is answered correctly.
 */
export async function resolveTargetModel(
  orgId: string,
  key: ModelTargetKey,
): Promise<ResolvedTargetModel | null> {
  const chain = inheritanceChain(key.subagentPath);
  const [rows, workspaceDefault] = await Promise.all([
    db
      .select({
        subagentPath: agentModelOverrides.subagentPath,
        projectId: agentModelOverrides.projectId,
        model: agentModelOverrides.model,
        effort: agentModelOverrides.effort,
      })
      .from(agentModelOverrides)
      .where(
        and(
          eq(agentModelOverrides.orgId, orgId),
          eq(agentModelOverrides.agentName, key.agentName),
          inArray(agentModelOverrides.subagentPath, chain),
          projectScope(key.projectId),
        ),
      )
      .orderBy(...preferenceOrder(key.projectId)),
    getWorkspaceAssistantSelection(orgId),
  ]);
  const byPath = new Map<string, AgentModelSelection>();
  for (const row of rows) {
    // Ordered by preference, so the row that answers is the first one seen per path.
    if (byPath.has(row.subagentPath)) continue;
    byPath.set(row.subagentPath, {
      model: row.model,
      effort: (row.effort as ReasoningEffort | null) ?? null,
    });
  }
  return pickTargetModel(key.subagentPath, byPath, workspaceDefault);
}
