/**
 * Environment lifecycle — TEAM-scoped (the team is the deployment unit).
 *
 * Physical vs. logical split: the `environments` table stays PER-AGENT (one row per member per
 * env name, `environments_agent_name_uq` on (agentId, name)). Those row ids are load-bearing —
 * deployments.environmentId, secret scoping, playground_sessions.environmentId/worldKey,
 * delegations, the `/e/<envId>` ingress URLs, and splitter routing all FK to them, so we never
 * collapse them into one row. But LOGICALLY an environment is a team-level thing: a project owns
 * ONE set of environment NAMES, and every roster member (kind === 'member') has a row of every
 * name. A member existing in one env but not another is definitionally drift, not a feature.
 *
 * So env CRUD is fan-out over the roster: create/rename/delete a NAME touches every member's row
 * of that name at once. This eliminates version skew inside an environment (rename member A and
 * deploy only A, and B's ask-a-teammate tool still points at the old name → broken). The team
 * env set S is the distinct env names across the project's member agents.
 *
 * The built-in assistant agent (kind === 'assistant') is EXEMPT — it is never part of S, never a
 * fan-out target, and keeps its own `ensureDefault` seeding in the assistant instance path.
 *
 * Delete is the loaded one: the row cascade removes the env's deployments (and schedules) plus
 * env-scoped secrets, but rows can't stop docker containers or drop the environment's Workflow
 * world DB — so per member row we close each deployment's control-plane gate, tear infra down via
 * the DeployTarget (`destroy` when it has it, `stop` otherwise), then `destroyWorld` once for the
 * environment. Runtime teardown is best-effort; the DB gate stays correctness-critical.
 */
import type { Agent, DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget } from "~/seams/types";

export interface EnvironmentDeps {
  store: DataStore;
  deployTarget: DeployTarget;
}

/** Ensuring the invariant only needs persistence — no infra teardown. */
export interface EnsureDeps {
  store: DataStore;
}

function envDeps(): EnvironmentDeps {
  const r = getRuntime();
  return { store: r.data, deployTarget: r.deployTarget };
}

function ensureDeps(): EnsureDeps {
  return { store: getRuntime().data };
}

/** True for the Postgres unique-violation the (agent, name) index raises. */
function isDuplicateName(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

function validName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("Environment name is required.");
  if (name.length > 64) throw new Error("Environment name is too long (max 64 characters).");
  return name;
}

/** The project's ROSTER members (kind === 'member') — the fan-out targets. Assistant excluded. */
async function memberAgents(projectId: string, store: DataStore): Promise<Agent[]> {
  const all = await store.agents.listByProject(projectId);
  return all.filter((a) => a.kind === "member");
}

/** A project's member env rows (excludes the assistant's), in creation order. */
async function memberEnvRows(projectId: string, store: DataStore) {
  const members = await memberAgents(projectId, store);
  const memberIds = new Set(members.map((m) => m.id));
  const rows = await store.environments.listByProject(projectId);
  return { members, memberIds, rows: rows.filter((e) => memberIds.has(e.agentId)) };
}

/**
 * The team env set S: the distinct env names across the project's member agents, ordered by
 * first creation (oldest first — the FIRST name is the de-facto primary: default publish target,
 * hero card). Built from the per-agent rows but deduplicated to the team-level view.
 */
export async function listTeamEnvNames(
  projectId: string,
  deps: EnsureDeps = ensureDeps(),
): Promise<string[]> {
  const { rows } = await memberEnvRows(projectId, deps.store);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const e of rows) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    names.push(e.name);
  }
  return names;
}

/**
 * Create an environment NAME for the team: one row per member agent. Swallows the (agent, name)
 * unique violation per member so it doubles as idempotent drift repair (a member that already
 * has the name is left as-is). One audit record for the whole team op.
 */
export async function createTeamEnvironment(
  input: { projectId: string; name: string; orgId: string; createdBy?: string | null },
  deps: EnvironmentDeps = envDeps(),
): Promise<void> {
  const name = validName(input.name);
  const members = await memberAgents(input.projectId, deps.store);
  for (const member of members) {
    try {
      await deps.store.environments.create({
        projectId: input.projectId,
        agentId: member.id,
        name,
      });
    } catch (err) {
      if (!isDuplicateName(err)) throw err;
      // Member already has this env — idempotent drift repair, not an error.
    }
  }
  await deps.store.audit.record({
    orgId: input.orgId,
    actorUserId: input.createdBy ?? null,
    action: "environment.create",
    target: name,
    meta: { name, members: members.length },
  });
}

/**
 * Rename an environment NAME across the whole team: rename every member's row named `from` to
 * `to`. Throws readably on a duplicate (a member already has `to`) or when no member has `from`.
 */
export async function renameTeamEnvironment(
  input: {
    projectId: string;
    from: string;
    to: string;
    orgId: string;
    createdBy?: string | null;
  },
  deps: EnvironmentDeps = envDeps(),
): Promise<void> {
  const to = validName(input.to);
  const { rows } = await memberEnvRows(input.projectId, deps.store);
  const targets = rows.filter((e) => e.name === input.from);
  if (targets.length === 0) {
    throw new Error(`No environment named "${input.from}" to rename.`);
  }
  for (const env of targets) {
    if (env.name === to) continue;
    try {
      await deps.store.environments.rename(env.id, to);
    } catch (err) {
      if (isDuplicateName(err)) {
        throw new Error(`An environment named "${to}" already exists.`);
      }
      throw err;
    }
  }
  // The rename follows the persisted live-environment answer (§2.8) — otherwise a rename
  // would strand `liveEnvironmentName` on a dead name and Publish would ask again.
  const project = await deps.store.projects.findById(input.projectId);
  if (project?.liveEnvironmentName === input.from) {
    await deps.store.projects.setLiveEnvironmentName(input.projectId, to);
  }
  await deps.store.audit.record({
    orgId: input.orgId,
    actorUserId: input.createdBy ?? null,
    action: "environment.rename",
    target: to,
    meta: { from: input.from, to, members: targets.length },
  });
}

/**
 * Tear down ONE environment row's runtime infra: close each deployment's run-start gate, destroy
 * its container (`destroy` when supported, `stop` otherwise), then destroy the Workflow world DB.
 * Container/world calls are best-effort, but the `stopped` marker must land before infra is
 * touched so the following sweep cannot miss a late insert. Shared by env delete and roster prune:
 * both delete rows whose ids are the ONLY handle on this infra, so teardown always goes first.
 */
export async function destroyEnvironmentInfra(
  environmentId: string,
  deps: EnvironmentDeps = envDeps(),
): Promise<void> {
  const { store, deployTarget } = deps;
  const deployments = await store.deployments.listByEnvironment(environmentId);
  for (const dep of deployments) {
    // This gate is the one correctness-critical DB write in teardown. It happens before infra:
    // if it cannot land, abort with the row intact so a retry can close the gate and sweep safely.
    // Once stopped is visible, a concurrent start either already committed (and is swept below)
    // or observes the stopped deployment and inserts nothing.
    await store.deployments.update(dep.id, {
      status: "stopped",
      trafficWeight: 0,
    });
    try {
      if (deployTarget.destroy) await deployTarget.destroy(dep.id);
      else await deployTarget.stop(dep.id);
    } catch {
      // container already gone / target unreachable — the row delete is authoritative
    }
    try {
      await store.runs.failRunningByDeployment(
        dep.id,
        "Run interrupted because its deployment was stopped or removed.",
      );
    } catch (error) {
      // The environment row is still deleted even if observability reconciliation is unavailable.
      console.warn(
        `[environment] failed to reconcile running runs for removed deployment ${dep.id}`,
        error,
      );
    }
  }
  try {
    await deployTarget.destroyWorld?.(environmentId);
  } catch {
    // best-effort — a leftover world DB never blocks the delete
  }
}

/**
 * Delete an environment NAME across the whole team. Refuses when it's the team's only env name
 * (a team needs ≥1). Converges the roster first (so drift can't leave a member env-less), then
 * per member row: tear down every deployment's infra, drop the env's Workflow world, delete the
 * row — the cascade takes deployment history + env-scoped secrets with it. Best-effort infra,
 * exactly as before. A `deleteById` that returns false (drift) is a safe no-op, not an error.
 */
export async function deleteTeamEnvironment(
  input: { projectId: string; name: string; orgId: string; createdBy?: string | null },
  deps: EnvironmentDeps = envDeps(),
): Promise<void> {
  const { store, deployTarget } = deps;
  const names = await listTeamEnvNames(input.projectId, { store });
  if (names.length <= 1) {
    throw new Error(
      "This is the team's only environment — a team needs at least one. Create another before deleting this one.",
    );
  }
  // Converge so no member is missing this name (or any) before we delete — otherwise drift could
  // leave a member's `deleteById` refusing (its "last env") and the name half-deleted.
  await ensureTeamEnvironments(input.projectId, { store });

  const { rows } = await memberEnvRows(input.projectId, store);
  const targets = rows.filter((e) => e.name === input.name);
  let deleted = 0;
  for (const env of targets) {
    // Infra first: after the row delete the deployment ids are gone and nothing could find the
    // containers/databases again.
    await destroyEnvironmentInfra(env.id, { store, deployTarget });
    // After the converge no member is env-less, so deleteById can't hit its last-env refusal;
    // a false here means drift we don't care about — treat it as a no-op, don't throw.
    if (await store.environments.deleteById(env.id)) deleted++;
  }
  await store.audit.record({
    orgId: input.orgId,
    actorUserId: input.createdBy ?? null,
    action: "environment.delete",
    target: input.name,
    meta: { name: input.name, members: deleted },
  });
}

/**
 * Converge the team-env invariant: every member has a row of every name in S. Computes S (falls
 * back to ['default'] when the project has no member envs at all — preserving the ≥1 invariant),
 * then creates any missing (member, name) rows, swallowing the unique violation on a race. This
 * is the ONE function callers use to keep the invariant — a new member picked up on roster sync
 * inherits the team's full env set through here.
 */
export async function ensureTeamEnvironments(
  projectId: string,
  deps: EnsureDeps = ensureDeps(),
): Promise<void> {
  const { store } = deps;
  const { members, rows } = await memberEnvRows(projectId, store);
  if (members.length === 0) return;
  const distinct = new Set(rows.map((e) => e.name));
  const names = distinct.size > 0 ? [...distinct] : ["default"];
  const have = new Set(rows.map((e) => `${e.agentId}:${e.name}`));
  for (const member of members) {
    for (const name of names) {
      if (have.has(`${member.id}:${name}`)) continue;
      try {
        await store.environments.create({ projectId, agentId: member.id, name });
      } catch (err) {
        if (!isDuplicateName(err)) throw err;
      }
    }
  }
}
