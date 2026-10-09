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
import { planInstall, type InstallPlan } from "./install.server";
import {
  LOCK_PATH,
  parseLock,
  serializeLock,
  upsertInstall,
  type HarnesstLock,
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
