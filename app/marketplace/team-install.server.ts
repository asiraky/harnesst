/**
 * Team install planner, pure. A team template is a roster of agent templates; installing it is
 * one new-member install per roster entry, chained so each install sees the previous ones (the
 * lock, the staged files, the names taken), then one `team` lock row recording role → member.
 *
 * The result is a single change-set: every member's files, package.json and one final lock. A
 * conflict on any member blocks the whole team — half a team is worse than none.
 */
import type { ReasoningEffort } from "~/models/reasoning";
import type { ResolvedTemplate } from "./compose.server";
import { selectedCapabilityGroupIds } from "~/capabilities/enablement";
import {
  findInstallAtTarget,
  planInstall,
  type InstallPlan,
  type InstallTarget,
} from "./install.server";
import type { TemplateManifest } from "./manifest";
import {
  LOCK_PATH,
  findInstall,
  parseLock,
  selectedGroupIds,
  serializeLock,
  upsertInstall,
  type CatalogProviderEvidence,
  type HarnesstLock,
  type InstallEntry,
} from "./lock";

export interface TeamMemberInput {
  role: string;
  /** The member's agent name — the roster default or the installer's rename. */
  name: string;
  /** The roster entry's agent template, resolved (includes flattened). */
  template: ResolvedTemplate;
}

export interface TeamInstallInput {
  /** The team template itself (no files; its manifest carries the roster). */
  team: ResolvedTemplate;
  members: TeamMemberInput[];
  registry: string;
  repoPaths: string[];
  drafts: Array<{ path: string; content: string | null }>;
  lock: HarnesstLock;
  /** Members already in the repo. */
  rosterNames: string[];
  model: string | null;
  effort: ReasoningEffort | null;
}

export interface TeamInstallPlan {
  /** Every member's writes plus ONE final lock write. */
  writes: Array<{ path: string; content: string }>;
  /** Blocking, prefixed with the member name. Non-empty ⇒ stage nothing. */
  conflicts: string[];
  warnings: string[];
  members: Array<{
    role: string;
    name: string;
    templateId: string;
    secrets: InstallPlan["secrets"];
    provisioning: string[];
  }>;
}

export function planTeamInstall(input: TeamInstallInput): TeamInstallPlan {
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const writes = new Map<string, string>();
  const drafts = [...input.drafts];
  const names = [...input.rosterNames];
  let lock = input.lock;

  for (const member of input.members) {
    const plan = planInstall({
      template: member.template,
      registry: input.registry,
      repoPaths: input.repoPaths,
      drafts,
      packageJson: null,
      lock,
      rosterNames: names,
      model: input.model,
      effort: input.effort,
      target: { kind: "new-member", name: member.name },
    });
    conflicts.push(...plan.conflicts.map((c) => `${member.name}: ${c}`));
    warnings.push(...plan.warnings.map((w) => `${member.name}: ${w}`));
    for (const write of plan.writes) {
      if (write.path === LOCK_PATH) {
        lock = parseLock(JSON.parse(write.content));
        continue;
      }
      writes.set(write.path, write.content);
      // The next member's planner must see this as occupied, exactly like a staged draft.
      const at = drafts.findIndex((d) => d.path === write.path);
      if (at >= 0) drafts[at] = { path: write.path, content: write.content };
      else drafts.push({ path: write.path, content: write.content });
    }
    names.push(member.name);
  }

  const manifest = input.team.manifest;
  lock = upsertInstall(lock, {
    id: manifest.id,
    type: manifest.type,
    name: manifest.name,
    version: manifest.version,
    hash: input.team.hash,
    registry: input.registry,
    member: null,
    files: [],
    roster: input.members.map((m) => ({ role: m.role, member: m.name })),
  });

  return {
    writes: [
      ...[...writes].map(([path, content]) => ({ path, content })),
      { path: LOCK_PATH, content: serializeLock(lock) },
    ],
    conflicts,
    warnings,
    members: input.members.map((m) => ({
      role: m.role,
      name: m.name,
      templateId: m.template.manifest.id,
      secrets: (m.template.manifest.secrets ?? []).map((s) => ({
        name: s.name,
        description: s.description,
        sandbox: s.sandbox,
        provisioned: s.provisioned,
        generated: s.generated,
      })),
      provisioning: m.template.manifest.provisioning ?? [],
    })),
  };
}

/**
 * True when an installed row already matches the catalog template: same version, same content
 * hash, and every include the template flattens recorded at the same hash. A bundled skill can
 * change without its parent's own hash moving, so includes are checked too. Pure.
 */
export function installIsCurrent(
  entry: InstallEntry,
  template: Pick<ResolvedTemplate, "manifest" | "hash" | "includes">,
): boolean {
  if (entry.version !== template.manifest.version) return false;
  if (entry.hash !== template.hash) return false;
  const installed = entry.includes ?? [];
  return template.includes.every((include) =>
    installed.some(
      (i) =>
        i.type === include.type &&
        i.id === include.id &&
        i.hash === include.hash,
    ),
  );
}

export interface TeamRosterMatch {
  /** The installed team row; null when this team isn't installed. */
  team: InstallEntry | null;
  /** One per installed role: the member that fills it and the agent template it runs. */
  members: Array<{ role: string; name: string; agentId: string }>;
  /** Why the team can't be updated in place; null when it can. */
  error: string | null;
}

/**
 * Pair the installed team's role → member map with the catalog team's role → agent map. An
 * in-place update only refreshes the members the team already has: a role added, dropped or
 * moved to a different agent template is a roster change, which this refuses. Pure.
 */
export function matchTeamRoster(
  lock: HarnesstLock,
  team: TemplateManifest,
): TeamRosterMatch {
  const row = findInstall(lock, team.id, null) ?? null;
  const fail = (error: string): TeamRosterMatch => ({
    team: row,
    members: [],
    error,
  });
  if (!row || row.type !== "team") return fail(`${team.name} isn't installed.`);
  const installed = row.roster ?? [];
  const catalog = team.roster ?? [];
  if (installed.length === 0)
    return fail(
      `The installed ${team.name} has no recorded roster. Update its members one at a time instead.`,
    );
  const catalogByRole = new Map(catalog.map((c) => [c.role, c]));
  const members: TeamRosterMatch["members"] = [];
  for (const entry of installed) {
    const wanted = catalogByRole.get(entry.role);
    if (!wanted)
      return fail(
        `${team.name} v${team.version} no longer has the "${entry.role}" role. Update its members one at a time instead.`,
      );
    if (!findInstall(lock, wanted.agent, entry.member))
      return fail(
        `${team.name} v${team.version} fills the "${entry.role}" role with a different agent than ${entry.member} runs. Update its members one at a time instead.`,
      );
    members.push({
      role: entry.role,
      name: entry.member,
      agentId: wanted.agent,
    });
  }
  const added = catalog.filter(
    (c) => !installed.some((i) => i.role === c.role),
  );
  if (added.length > 0)
    return fail(
      `${team.name} v${team.version} adds the ${added.map((a) => `"${a.role}"`).join(", ")} role. Adding members isn't supported by an in-place update.`,
    );
  return { team: row, members, error: null };
}

export interface TeamUpdateMemberInput {
  role: string;
  name: string;
  /** The catalog agent template for this member's role, resolved. */
  template: ResolvedTemplate;
  /** The member's agent root ("agents/<name>/agent"). */
  root: string;
  /** The member's package.json, drafts overlaid; null when absent. */
  packageJson: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
}

export interface TeamUpdateInput {
  team: ResolvedTemplate;
  members: TeamUpdateMemberInput[];
  registry: string;
  repoPaths: string[];
  drafts: Array<{ path: string; content: string | null }>;
  lock: HarnesstLock;
  catalogProviders?: CatalogProviderEvidence[];
  rosterNames: string[];
}

export interface TeamUpdatePlan {
  /** Every refreshed member's writes plus ONE final lock write. */
  writes: Array<{ path: string; content: string }>;
  /** Files the new versions drop. Never also in `writes`. */
  deletions: string[];
  /** Blocking, prefixed with the member name. Non-empty ⇒ stage nothing. */
  conflicts: string[];
  warnings: string[];
  /** Members whose agent template was refreshed; already-current members are left alone. */
  updated: string[];
}

/**
 * Update an installed team to the catalog version in one change-set: each stale member's agent
 * template is updated in place (the same plan a per-row Update stages, auth choices carried
 * over), chained so each sees the previous ones, then the team row moves to the new version
 * with its role → member map kept. A conflict on any member blocks the whole team.
 */
export function planTeamUpdate(input: TeamUpdateInput): TeamUpdatePlan {
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const updated: string[] = [];
  const writes = new Map<string, string>();
  const deletions = new Set<string>();
  const drafts = [...input.drafts];
  let lock = input.lock;

  const overlay = (path: string, content: string | null) => {
    const at = drafts.findIndex((d) => d.path === path);
    if (at >= 0) drafts[at] = { path, content };
    else drafts.push({ path, content });
  };

  for (const member of input.members) {
    const target: InstallTarget = {
      kind: "member",
      memberName: member.name,
      resolverAgentName: member.name,
      root: member.root,
      deploymentRoot: member.root,
      subagentPath: "",
    };
    const existing = findInstallAtTarget(
      lock,
      member.template.manifest.id,
      target,
    );
    if (!existing) {
      conflicts.push(
        `${member.name}: ${member.template.manifest.name} isn't installed on this member.`,
      );
      continue;
    }
    if (installIsCurrent(existing, member.template)) continue;
    const authSelections: Record<string, string[]> = {};
    const capabilitySelections: Record<string, string[]> = {};
    for (const auth of existing.auth ?? []) {
      if (auth.scopeGroups)
        authSelections[auth.provider] = selectedGroupIds(auth);
      if (auth.capabilityGroups)
        capabilitySelections[auth.provider] = selectedCapabilityGroupIds(auth);
    }
    const plan = planInstall({
      template: member.template,
      registry: input.registry,
      repoPaths: input.repoPaths,
      drafts,
      packageJson: member.packageJson,
      lock,
      catalogProviders: input.catalogProviders,
      rosterNames: input.rosterNames,
      model: member.model,
      effort: member.effort,
      authSelections,
      capabilitySelections,
      target,
    });
    conflicts.push(...plan.conflicts.map((c) => `${member.name}: ${c}`));
    warnings.push(...plan.warnings.map((w) => `${member.name}: ${w}`));
    for (const write of plan.writes) {
      if (write.path === LOCK_PATH) {
        lock = parseLock(JSON.parse(write.content));
        continue;
      }
      writes.set(write.path, write.content);
      deletions.delete(write.path);
      overlay(write.path, write.content);
    }
    for (const path of plan.deletions) {
      writes.delete(path);
      deletions.add(path);
      overlay(path, null);
    }
    updated.push(member.name);
  }

  const manifest = input.team.manifest;
  const row = findInstall(lock, manifest.id, null);
  lock = upsertInstall(lock, {
    id: manifest.id,
    type: manifest.type,
    name: manifest.name,
    version: manifest.version,
    hash: input.team.hash,
    registry: input.registry,
    member: null,
    files: [],
    roster:
      row?.roster ??
      input.members.map((m) => ({ role: m.role, member: m.name })),
  });

  return {
    writes: [
      ...[...writes].map(([path, content]) => ({ path, content })),
      { path: LOCK_PATH, content: serializeLock(lock) },
    ],
    deletions: [...deletions],
    conflicts,
    warnings,
    updated,
  };
}
