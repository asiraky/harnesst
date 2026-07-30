/**
 * The install PLANNER — pure functions that turn "install this template here" into a concrete
 * change-set (writes, deletions, conflicts, warnings), with zero I/O (PRD §7.8 "Install = a
 * change-set").
 *
 * The split is deliberate: the wizard route gathers the inputs (repo tree, staged drafts, the
 * target's package.json, the current lock — GitHub/DB reads) and hands this module PLAIN DATA;
 * this module decides. That keeps every branch — path mapping, the dependency merge conflict
 * policy, update-vs-conflict, the lock upsert — unit-testable against literals, and keeps the
 * route a thin "gather → plan → stage" shell that re-plans server-side before it writes.
 *
 * Two paths mirror the two install shapes:
 *  - everything except an agent (tool/skill/subagent/channel/connection/bundle) installs INTO
 *    an existing member (files land under that member's agent root; deps merge into that
 *    member's package.json);
 *  - an agent installs AS A NEW team member (a fresh `agents/<name>/` project — files plus a
 *    generated package.json).
 * Both always rewrite `harnesst-lock.json` so provenance is one more reviewable file in the PR.
 */
import semver from "semver";

import { defaultCapabilityGroupIds } from "~/capabilities/definition.server";
import { getCapability } from "~/capabilities/registry.server";
import {
  ensureModelProviderDependencies,
  setModel,
  ZOD_PACKAGE,
  ZOD_VERSION,
} from "~/eve/agentModule";
import { isPlatformPath, platformRootForAgentRoot } from "~/eve/parse";
import type { ReasoningEffort } from "~/models/reasoning";
import type { CatalogTemplate } from "~/seams/types";
import {
  isPlatformFile,
  isTemplateSlug,
  PLATFORM_FILE_PREFIX,
  type TemplateManifest,
} from "./manifest";
import { platformFileHash, templateContentHash } from "./hash.server";
import type { ResolvedAuth, ResolvedInclude } from "./compose.server";
import {
  findInstall,
  removeInstall,
  serializeLock,
  upsertInstall,
  type HarnesstLock,
  type InstallEntry,
} from "./lock";

/** Files that are MERGED, never owned — they can't be conflicts and never land in a lock entry. */
const MERGED_FILES = new Set(["harnesst-lock.json"]);

type SandboxSetup = NonNullable<TemplateManifest["sandbox"]>;

function rootForMember(member: string | null): string {
  return member ? `agents/${member}/agent` : "agent";
}

/**
 * The final repo path for one install-relative manifest file. Everything lands under the agent
 * root exactly as it always has, EXCEPT an entry shipped under `harnesst/`: that materializes at
 * the PLATFORM root beside the agent root (issue #254), because eve claims every directory it
 * knows under `agent/` and hard-errors on any it doesn't, so platform-owned code has nowhere to
 * live inside the agent tree.
 *
 * Exported because the Settings drift check has to look for installed files where the installer
 * actually put them: root derivation is already duplicated across this module and that route, and
 * a second, divergent platform rule would make every install with platform files read as
 * permanently drifted. One mapping, one place.
 */
export function installedFilePath(agentRoot: string, file: string): string {
  if (!isPlatformFile(file)) return `${agentRoot}/${file}`;
  return `${platformRootForAgentRoot(agentRoot)}/${file.slice(
    PLATFORM_FILE_PREFIX.length,
  )}`;
}

function sandboxModulePath(root: string): string {
  return `${root}/sandbox/sandbox.ts`;
}

function sandboxAddonPath(root: string, id: string): string {
  return `${root}/sandbox/addons/${id}.ts`;
}

function js(value: unknown): string {
  return JSON.stringify(value);
}

function hasSandboxWork(
  setup: SandboxSetup | undefined,
): setup is SandboxSetup {
  return Boolean(
    setup &&
    ((setup.bootstrap?.length ?? 0) > 0 ||
      Object.keys(setup.env ?? {}).length > 0 ||
      setup.revalidationKey),
  );
}

/** One lock-shaped auth snapshot entry — mirrors `installEntrySchema.auth` items. */
type AuthSnapshotEntry = NonNullable<InstallEntry["auth"]>[number];

/**
 * The OAuth connection descriptors to snapshot into the lock for this install (issue #30). Prefer
 * the resolved template's `auths` (parent + every included connector, deduped by provider), dropping
 * the `templateId` provenance the lock doesn't need. A plain (non-resolved) template has no `auths`,
 * so fall back to its single `manifest.auth` descriptor as a one-element array.
 *
 * Scope groups (issue #165): a descriptor with `scopeGroups` also records the installer's
 * `selectedGroups` — the caller's explicit choice for that provider when one was posted, else the
 * template's `default`-flagged groups. Group-less descriptors snapshot byte-for-byte as before.
 *
 * Capability groups (issue #166): a descriptor with `capabilityGroups` records them (offered) plus
 * `selectedCapabilityGroups` (chosen) — the posted choice when one exists, else the registry
 * definition's `default`-flagged groups among the offered ids. ALWAYS written, so the enablement
 * derivation never needs a default fallback (absent reads as nothing enabled — fail closed).
 */
function authSnapshot(
  template: PlanContext["template"],
  authSelections?: Record<string, string[]>,
  capabilitySelections?: Record<string, string[]>,
): AuthSnapshotEntry[] {
  const descriptors: Array<{
    provider: string;
    kind: "oauth2";
    scopes?: string[];
    scopeGroups?: NonNullable<AuthSnapshotEntry["scopeGroups"]>;
    capabilityGroups?: string[];
  }> =
    template.auths && template.auths.length > 0
      ? template.auths.map((a) => ({
          provider: a.provider,
          kind: a.kind,
          ...(a.scopes.length > 0 ? { scopes: a.scopes } : {}),
          ...(a.scopeGroups ? { scopeGroups: a.scopeGroups } : {}),
          ...(a.capabilityGroups
            ? { capabilityGroups: a.capabilityGroups }
            : {}),
        }))
      : template.manifest.auth
        ? [
            {
              provider: template.manifest.auth.provider,
              kind: template.manifest.auth.kind,
              ...(template.manifest.auth.scopes
                ? { scopes: template.manifest.auth.scopes }
                : {}),
              ...(template.manifest.auth.scopeGroups
                ? { scopeGroups: template.manifest.auth.scopeGroups }
                : {}),
              ...(template.manifest.capability
                ? { capabilityGroups: template.manifest.capability.groups }
                : {}),
            },
          ]
        : [];
  return descriptors.map((d) => {
    let entry: AuthSnapshotEntry = d;
    if (d.scopeGroups) {
      const chosen = authSelections?.[d.provider];
      const selectedGroups = chosen
        ? // Keep declaration order and drop unknown ids — the list is form-posted.
          d.scopeGroups.map((g) => g.id).filter((id) => chosen.includes(id))
        : d.scopeGroups.filter((g) => g.default).map((g) => g.id);
      entry = { ...entry, selectedGroups };
    }
    if (d.capabilityGroups) {
      const chosen = capabilitySelections?.[d.provider];
      const definition = getCapability(d.provider);
      const selectedCapabilityGroups = chosen
        ? d.capabilityGroups.filter((id) => chosen.includes(id))
        : definition
          ? defaultCapabilityGroupIds(definition, d.capabilityGroups)
          : [];
      entry = { ...entry, selectedCapabilityGroups };
    }
    return entry;
  });
}

function renderSandboxAddon(setup: SandboxSetup): string {
  const lines = [
    "/** Generated by harnesst Marketplace. Edit the template or uninstall it instead of hand-editing. */",
    'import type { SandboxSession } from "eve/sandbox";',
    "",
    `export const env = ${js(setup.env ?? {})};`,
    `export const revalidationKey = ${js(setup.revalidationKey ?? "")};`,
    "",
    "export async function bootstrap({ sandbox }: { sandbox: SandboxSession }) {",
  ];
  for (const command of setup.bootstrap ?? []) {
    lines.push(`  await sandbox.run({ command: ${js(command)} });`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/**
 * Sandbox add-on files sitting under `<root>/sandbox/addons/` that NO install owns (issue #254).
 *
 * The managed sandbox module's imports are derived PURELY from the lock (`sandboxEntries`), so a
 * hand-authored add-on is invisible to regeneration: rewriting `sandbox/sandbox.ts` drops its
 * import without a word and the add-on silently stops running — which is precisely how a live
 * agent lost its browser bootstrap. The planner can't adopt such a file (it has no provenance, no
 * version, nothing to update from), so the honest move is to name it in `warnings` at the moment
 * the module is regenerated. `deletions` are excluded: a file this very plan removes (an absorbed
 * install's add-on) is not an orphan.
 */
function orphanedSandboxAddons(
  root: string,
  managedIds: string[],
  ctx: Pick<PlanContext, "repoPaths" | "drafts">,
  deletions: ReadonlySet<string>,
): string[] {
  const prefix = `${root}/sandbox/addons/`;
  const isAddon = (path: string) =>
    path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
  const present = new Set(ctx.repoPaths.filter(isAddon));
  for (const draft of ctx.drafts) {
    if (!isAddon(draft.path)) continue;
    if (draft.content === null) present.delete(draft.path);
    else present.add(draft.path);
  }
  const managed = new Set(managedIds.map((id) => sandboxAddonPath(root, id)));
  return [...present]
    .filter((path) => !managed.has(path) && !deletions.has(path))
    .sort();
}

function sandboxEntries(lock: HarnesstLock, member: string | null) {
  return lock.installs
    .filter((entry) => entry.member === member && hasSandboxWork(entry.sandbox))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function renderManagedSandboxModule(
  root: string,
  lock: HarnesstLock,
  member: string | null,
): string {
  const entries = sandboxEntries(lock, member);
  const imports = entries
    .map(
      (entry, index) =>
        `import * as addon${index} from "./addons/${entry.id}";`,
    )
    .join("\n");
  const addons = entries.map((_, index) => `addon${index}`).join(", ");
  return `${imports ? `${imports}\n` : ""}import { defaultBackend, defineSandbox } from "eve/sandbox";

const addons = [${addons}];

// harnesst convention: HARNESST_SANDBOX_ENV is a comma-separated allowlist of secret names
// forwarded from the instance into the sandbox shell. Marketplace add-ons can also
// contribute non-secret env defaults; exposed secrets win on name collisions.
const names = (process.env.HARNESST_SANDBOX_ENV ?? "").split(",").filter(Boolean);
const exposedEnv = Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""]));
const addonEnv = Object.assign({}, ...addons.map((addon) => addon.env ?? {}));
const env = { ...addonEnv, ...exposedEnv };

export default defineSandbox({
  backend: () => defaultBackend({ docker: { env }, vercel: { env } }),
  revalidationKey: () =>
    addons
      .map((addon) => addon.revalidationKey)
      .filter(Boolean)
      .join("|"),
  async bootstrap({ use }) {
    const sandbox = await use();
    for (const addon of addons) {
      await addon.bootstrap?.({ sandbox });
    }
  },
});
`;
}

/** Where an install lands. */
export type InstallTarget =
  /** Into an existing agent: tool/skill/subagent. `memberName` null = single-agent root. */
  | { kind: "member"; memberName: string | null; root: string }
  /** As a new team member: agent template → a fresh `agents/<name>/` project. */
  | { kind: "new-member"; name: string };

export interface PlanContext {
  /**
   * The template to install. A `ResolvedTemplate` (compose.server.ts) is assignable: its extra
   * `hash` (the parent's own content hash, matching its index row) is preferred over recomputing,
   * and its `includes` provenance is recorded in the lock. A plain `CatalogTemplate` (no includes)
   * still works — the hash is computed and no includes are recorded.
   */
  template: CatalogTemplate & {
    hash?: string;
    includes?: ResolvedInclude[];
    /**
     * OAuth connection descriptors the resolved template must broker (issue #30) — the parent's
     * own `auth` plus every include's, deduped by provider. Snapshotted into the lock so a
     * Reconnect can rebuild the required scopes. Absent for plain (non-resolved) templates.
     */
    auths?: ResolvedAuth[];
  };
  /** Locator string recorded in the lock — "fixture" or "github:owner/repo@ref". */
  registry: string;
  /** Every repo-relative path currently on the default branch (conflict detection). */
  repoPaths: string[];
  /** Staged drafts overlaid on the repo (a non-deletion draft occupies a path like a real file). */
  drafts: Array<{ path: string; content: string | null }>;
  /** CURRENT contents of the target's package.json (caller overlays drafts); null if absent. */
  packageJson: string | null;
  /** Current lock (caller overlays a staged harnesst-lock.json draft); empty default. */
  lock: HarnesstLock;
  target: InstallTarget;
  /** Existing roster member names — a new-member install must not collide with one. */
  rosterNames?: string[];
  /** Qualified model to write into an agent template instead of its catalog placeholder. */
  model?: string | null;
  /** Explicit workspace/member effort paired with the model. */
  effort?: ReasoningEffort | null;
  /**
   * The installer's scope-group choice per provider (issue #165): provider id → selected group
   * ids, as posted by the wizard's Permissions step. A provider absent here falls back to the
   * template's `default`-flagged groups; ignored for group-less descriptors.
   */
  authSelections?: Record<string, string[]>;
  /**
   * The installer's capability-group choice per provider (issue #166): provider id → selected
   * operation-group ids from the wizard's Operations step. A provider absent here falls back to
   * the registry definition's `default`-flagged groups among the offered ids.
   */
  capabilitySelections?: Record<string, string[]>;
  /**
   * Register a template around code that already occupies one or more of its target paths.
   * Occupied, unowned files are preserved byte-for-byte and deliberately omitted from the lock's
   * owned `files` list, so a later uninstall cannot delete hand-authored code. Missing files and
   * dependency merges are still staged normally. Only member installs support this escape hatch;
   * new-member validation and non-file conflicts remain blocking.
   */
  keepExistingFiles?: boolean;
}

export interface InstallPlan {
  /** Files to create/overwrite — the template's files, the merged package.json, the lock. */
  writes: Array<{ path: string; content: string }>;
  /** Update mode: files the OLD version had that the new one drops (staged as deletions). */
  deletions: string[];
  /** BLOCKING: a target path already exists and isn't ours (or an invalid new-member name). */
  conflicts: string[];
  /** True when every blocker is an occupied template path that can be preserved during register. */
  canKeepExistingFiles: boolean;
  /**
   * Files this plan deliberately leaves byte-for-byte: occupied paths a keep-existing plan
   * registered around (issue #177). Never lock-owned, so an uninstall can't delete them — but
   * a template-shipped path only stays preserved until the next update, which reclaims it.
   */
  preservedFiles: string[];
  /** Non-blocking: e.g. a dependency range disagreement the reviewer should eyeball. */
  warnings: string[];
  /** True when this (id, member) was already installed — an overwrite, not a first install. */
  isUpdate: boolean;
  /** Secrets the manifest asks for, for the wizard to collect (values never touch the plan). */
  secrets: Array<{
    name: string;
    description?: string;
    sandbox?: boolean;
    provisioned?: boolean;
    generated?: boolean;
  }>;
}

/** The lock's registry locator, from the same env the CatalogSource seam reads (index.server). */
export function catalogLocator(): string {
  const repo = process.env.HARNESST_CATALOG_REPO;
  if (!repo) return "fixture";
  const ref = process.env.HARNESST_CATALOG_REF ?? "main";
  return `github:${repo}@${ref}`;
}

/** The npm project dir for a member is the PARENT of its agent root, so package.json sits there. */
export function packageJsonPathForRoot(root: string): string {
  const slash = root.lastIndexOf("/");
  const parent = slash === -1 ? "" : root.slice(0, slash);
  return parent ? `${parent}/package.json` : "package.json";
}

/** Do two npm ranges share any version? Unparseable ranges are treated as disjoint (→ warn). */
function rangesIntersect(a: string, b: string): boolean {
  // "latest" isn't a semver range but always resolves to the newest release — it satisfies any
  // wanted range, so scaffolded `eve: "latest"` never reads as a conflict with a template pin.
  if (a.trim() === "latest" || b.trim() === "latest") return true;
  try {
    return semver.intersects(a, b);
  } catch {
    return false;
  }
}

/**
 * Merge template dependencies into a package's deps by the PRD's policy: absent → add; present
 * and the ranges intersect → keep the agent's silently (no diff churn); present and disjoint
 * (or unparseable) → keep the agent's and warn. Keys come back alphabetized.
 */
function mergeDependencies(
  current: Record<string, string>,
  wanted: Record<string, string>,
): { deps: Record<string, string>; warnings: string[] } {
  const deps: Record<string, string> = { ...current };
  const warnings: string[] = [];
  for (const [name, wantRange] of Object.entries(wanted)) {
    const existing = deps[name];
    if (existing === undefined) {
      deps[name] = wantRange;
      continue;
    }
    if (rangesIntersect(existing, wantRange)) continue;
    warnings.push(
      `\`${name}\`: agent pins \`${existing}\`, template wants \`${wantRange}\` — kept the agent's; review before publishing.`,
    );
  }
  const sorted = Object.fromEntries(
    Object.keys(deps)
      .sort()
      .map((k) => [k, deps[k]]),
  );
  return { deps: sorted, warnings };
}

/** Serialize a package.json object the repo's way: 2-space indent, trailing newline. */
function serializePackageJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** The generated package.json for a brand-new team member (mirrors memberScaffold's shape). */
function newMemberPackageJson(
  name: string,
  templateDeps: Record<string, string>,
): { content: string; warnings: string[] } {
  const { deps, warnings } = mergeDependencies(
    { eve: "latest", [ZOD_PACKAGE]: ZOD_VERSION },
    templateDeps,
  );
  return {
    content: serializePackageJson({
      name,
      private: true,
      type: "module",
      scripts: { dev: "eve dev", build: "eve build" },
      dependencies: deps,
    }),
    warnings,
  };
}

/** One dependency's fate in the merge, for the wizard's add/keep/conflict badges. */
export interface DependencyDecision {
  name: string;
  /** The range the template wants. */
  range: string;
  status: "add" | "keep" | "conflict";
}

/**
 * Describe how each template dependency would merge against the target's current deps — the
 * display projection behind the wizard's badges. Mirrors `mergeDependencies`' policy exactly.
 */
export function describeDependencies(
  current: Record<string, string> | null,
  wanted: Record<string, string> | undefined,
): DependencyDecision[] {
  const cur = current ?? {};
  return Object.entries(wanted ?? {}).map(([name, range]) => {
    const existing = cur[name];
    if (existing === undefined) return { name, range, status: "add" as const };
    return {
      name,
      range,
      status: rangesIntersect(existing, range)
        ? ("keep" as const)
        : ("conflict" as const),
    };
  });
}

export function planInstall(ctx: PlanContext): InstallPlan {
  const { template, target } = ctx;
  const manifest = template.manifest;
  const rosterNames = ctx.rosterNames ?? [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];

  // ── 1. Map the template files to their final repo paths, and who owns the install ──
  let member: string | null;
  let fileWrites: Array<{ path: string; content: string }>;

  // The agent root this install writes into — an existing member's, or the fresh one a new member
  // gets. Ordinary files land inside it; `harnesst/` files land at its sibling platform root
  // (installedFilePath). Derived ONCE so both branches and the sandbox paths below all agree on
  // where this install lives.
  const agentRoot =
    target.kind === "new-member" ? `agents/${target.name}/agent` : target.root;

  if (target.kind === "new-member") {
    member = target.name;
    if (!isTemplateSlug(target.name)) {
      conflicts.push(
        `"${target.name}" isn't a valid agent name — use lowercase letters, digits, and single hyphens.`,
      );
    } else if (rosterNames.includes(target.name)) {
      conflicts.push(
        `An agent named "${target.name}" already exists — pick another name, or install into it instead.`,
      );
    }
    fileWrites = manifest.files.map((f) => ({
      path: installedFilePath(agentRoot, f),
      content:
        manifest.type === "agent" && f === "agent.ts" && ctx.model
          ? setModel(template.files[f], ctx.model, { effort: ctx.effort })
          : template.files[f],
    }));
    if (hasSandboxWork(manifest.sandbox)) {
      fileWrites.push({
        path: sandboxAddonPath(agentRoot, manifest.id),
        content: renderSandboxAddon(manifest.sandbox),
      });
    }
    const pkg = newMemberPackageJson(target.name, manifest.dependencies ?? {});
    const packageContent =
      manifest.type === "agent" && ctx.model
        ? ensureModelProviderDependencies(pkg.content)
        : pkg.content;
    writes.push(...fileWrites, {
      path: `agents/${target.name}/package.json`,
      content: packageContent,
    });
    warnings.push(...pkg.warnings);
  } else {
    member = target.memberName;
    fileWrites = manifest.files.map((f) => ({
      path: installedFilePath(agentRoot, f),
      content:
        manifest.type === "agent" && f === "agent.ts" && ctx.model
          ? setModel(template.files[f], ctx.model, { effort: ctx.effort })
          : template.files[f],
    }));
    if (hasSandboxWork(manifest.sandbox)) {
      fileWrites.push({
        path: sandboxAddonPath(agentRoot, manifest.id),
        content: renderSandboxAddon(manifest.sandbox),
      });
    }
    writes.push(...fileWrites);
    // Dependency merge into the member's package.json (only when the template asks for any).
    const needsModelProviderDependencies =
      manifest.type === "agent" && Boolean(ctx.model);
    if (
      (manifest.dependencies &&
        Object.keys(manifest.dependencies).length > 0) ||
      needsModelProviderDependencies
    ) {
      const pkgPath = packageJsonPathForRoot(target.root);
      // A package.json we can't parse can't be merged — that's a blocking conflict for the
      // human to fix, not a crash for the wizard to 500 on.
      let base: Record<string, unknown> | null = {};
      if (ctx.packageJson) {
        try {
          base = JSON.parse(ctx.packageJson) as Record<string, unknown>;
        } catch {
          base = null;
          conflicts.push(
            `${pkgPath} is not valid JSON — fix it before installing.`,
          );
        }
      }
      if (base) {
        const currentDeps = (base.dependencies as Record<string, string>) ?? {};
        const { deps, warnings: depWarnings } = mergeDependencies(
          currentDeps,
          manifest.dependencies ?? {},
        );
        warnings.push(...depWarnings);
        const serialized = serializePackageJson({
          ...base,
          dependencies: deps,
        });
        const merged = needsModelProviderDependencies
          ? ensureModelProviderDependencies(serialized)
          : serialized;
        // Only stage package.json when it actually changed — no churn when every dep intersects.
        if (merged !== ctx.packageJson) {
          writes.push({ path: pkgPath, content: merged });
        }
      }
    }
  }

  // ── 2. Conflicts & update detection ──
  // An existing lock entry for this (id, member) makes overwriting our own files legal — an
  // UPDATE — and turns files the old version had but the new one lacks into deletions.
  const existing =
    target.kind === "member"
      ? findInstall(ctx.lock, manifest.id, member)
      : undefined;
  const isUpdate = !!existing;
  const owned = new Set(existing?.files ?? []);
  const newPaths = new Set(fileWrites.map((w) => w.path));

  // Composition absorb (issue #42): a composite landing on a member that already has one of its
  // includes installed standalone is routine, not a conflict — the composite takes over that
  // install. Its files become ours to overwrite, files it owned that we no longer ship become
  // deletions, and its lock entry is dropped (the composite's `includes` provenance replaces it).
  const includeIds = new Set((template.includes ?? []).map((i) => i.id));
  const absorbed =
    target.kind === "member"
      ? ctx.lock.installs.filter(
          (e) =>
            e.member === member && e.id !== manifest.id && includeIds.has(e.id),
        )
      : [];
  for (const e of absorbed) {
    for (const f of e.files) owned.add(f);
    warnings.push(
      `Absorbs the existing "${e.name}" v${e.version} install — its files are now managed by ${manifest.name}.`,
    );
  }
  const recognizedOwners = new Set<InstallEntry>(absorbed);
  if (existing) recognizedOwners.add(existing);
  const ownedByOtherInstall = new Set<string>();
  for (const entry of ctx.lock.installs) {
    if (recognizedOwners.has(entry)) continue;
    for (const path of entry.files) ownedByOtherInstall.add(path);
  }

  const draftAt = new Map(ctx.drafts.map((d) => [d.path, d.content]));
  /**
   * Is something sitting at `path` right now? Drafts are the newer truth, so a draft DECIDES —
   * HEAD is only consulted when the path has no draft at all. That ordering is the whole point:
   * a staged deletion (null content) frees the path, which is what makes delete-then-install work
   * for replacing a hand-authored file with a marketplace-owned one. OR-ing HEAD in would make a
   * staged deletion unable to free anything, and the conflict it raised would be resolved with
   * "keep existing files" — registering a path the drafts were removing.
   */
  const occupiedAt = (path: string): boolean =>
    draftAt.has(path) ? draftAt.get(path) !== null : ctx.repoPaths.includes(path);
  const nonFileConflictCount = conflicts.length;
  const occupiedTemplatePaths: string[] = [];
  const preservableTemplatePaths: string[] = [];
  const preservedFiles: string[] = [];
  // Paths this install PREVIOUSLY preserved (issue #177): a later repair/update re-plans WITHOUT
  // `keepExistingFiles`, so without this record the very files the register step promised to
  // leave alone would read as foreign and block forever. The record now keeps exactly ONE
  // promise: paths this plan does NOT ship stay preserved — the entry merely registered around
  // them. A path the incoming template SHIPS is the template's to overwrite on an update, even
  // one a previous install preserved. Anything wider re-preserves a stale file forever: two
  // production agents took an update that recorded their channel wrapper here, and every later
  // update kept resurrecting the dead file instead of replacing it.
  const previouslyPreserved = new Set(existing?.preservedFiles ?? []);
  // A new member's generated package.json is a CREATE (not a merge like an existing member's),
  // so an orphan file already at that path — a half-deleted member — must block, not be clobbered.
  const createPaths = fileWrites.map((w) => w.path);
  if (target.kind === "new-member") {
    createPaths.push(`agents/${target.name}/package.json`);
  }
  for (const path of createPaths) {
    const occupied = occupiedAt(path);
    if (owned.has(path)) continue; // ours already — overwrite is fine (update)
    if (!occupied) continue;
    // Updates overwrite. A template-shipped path this very entry preserved before is reclaimed —
    // written this time, lock-owned from now on. An earlier design preserved it forever
    // (install-once, issue #254), and reversing that is deliberate: the channel template is now
    // generic, driven by panel settings rather than hand edits, so there is nothing in the file
    // worth keeping over the template's newer version. First installs never take this branch, and
    // a path owned by a DIFFERENT install is never ours to reclaim — both still conflict below.
    if (isUpdate && previouslyPreserved.has(path) && !ownedByOtherInstall.has(path)) {
      continue;
    }
    occupiedTemplatePaths.push(path);
    const canPreservePath =
      target.kind === "member" && !ownedByOtherInstall.has(path);
    if (canPreservePath) preservableTemplatePaths.push(path);
    if (ctx.keepExistingFiles && canPreservePath) {
      preservedFiles.push(path);
    } else {
      conflicts.push(path);
    }
  }

  // Preserve means preserve: remove the catalog write and do not claim ownership in the lock.
  // The lock still snapshots auth/secrets/capabilities, which is the registration harnesst needs to
  // surface the code-authored connection on Deployment and provision it at deploy time.
  const preservedFileSet = new Set(preservedFiles);
  if (preservedFiles.length > 0) {
    for (let i = writes.length - 1; i >= 0; i -= 1) {
      if (preservedFileSet.has(writes[i].path)) writes.splice(i, 1);
    }
    warnings.push(
      `${preservedFiles.length} existing file${preservedFiles.length === 1 ? " was" : "s were"} kept unchanged and left unmanaged by this install.`,
    );
  }
  // Preserved paths the incoming template does NOT ship stay on the record. The entry is rebuilt
  // from scratch every plan, so dropping them here would quietly break the register-around
  // promise: the next repair or update would read those files as foreign and block on them.
  const carriedPreserved = [...previouslyPreserved].filter(
    (p) => !newPaths.has(p),
  );
  const allPreserved = [...new Set([...preservedFiles, ...carriedPreserved])];

  const deletions = [
    ...new Set(
      [...(existing?.files ?? []), ...absorbed.flatMap((e) => e.files)].filter(
        (f) => !newPaths.has(f),
      ),
    ),
  ];

  // ── 3. The lock write — always. files exclude package.json / harnesst-lock.json (they're merges). ──
  // Per-file content hashes for the PLATFORM files this install actually wrote (issue #254), keyed
  // by final repo path and sorted so the lock diff is driven by content, not iteration order. Only
  // files we wrote appear: a preserved path's bytes aren't ours to vouch for.
  const platformFiles = Object.fromEntries(
    fileWrites
      .filter((w) => isPlatformPath(w.path) && !preservedFileSet.has(w.path))
      .map((w) => [w.path, platformFileHash(w.content)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  // Operator-set channel settings survive an update (issue #254). The entry is rebuilt from the
  // manifest every time, so anything the OPERATOR set rather than the template declared has to be
  // carried across explicitly — otherwise bumping a bundle's version silently reverts the channel
  // to inert, which looks exactly like the agent going quiet for no reason. An absorbed standalone
  // install's settings come along too: the composite takes over that install, configuration and all.
  const carriedSettings =
    existing?.settings ?? absorbed.find((e) => e.settings)?.settings;
  const entry: InstallEntry = {
    id: manifest.id,
    type: manifest.type,
    name: manifest.name,
    version: manifest.version,
    // A resolved template carries its own (parent) content hash, matching its index row; a plain
    // template is hashed here. Includes never affect the parent's hash (they flatten, not hash).
    hash: template.hash ?? templateContentHash(template),
    registry: ctx.registry,
    member,
    files: [...newPaths]
      .filter((p) => !MERGED_FILES.has(p) && !preservedFileSet.has(p))
      .sort(),
    // Snapshot the assistant skill content (issue #274) so the install pins the skill it shipped
    // with — bundle assembly reads it from here, falling back to the catalog for older locks.
    ...(template.assistantSkill ? { assistantSkill: template.assistantSkill } : {}),
    // Record the deliberately-preserved paths (issue #177) so the Settings drift check treats
    // them as present and a later repair/update keeps honouring the registration instead of
    // blocking on the very files this install promised to leave alone. Template-shipped paths
    // never linger here: an update reclaims them (see the createPaths loop above).
    ...(allPreserved.length > 0
      ? { preservedFiles: [...allPreserved].sort() }
      : {}),
    ...(Object.keys(platformFiles).length > 0 ? { platformFiles } : {}),
    ...(carriedSettings ? { settings: carriedSettings } : {}),
    ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
    // Record composition provenance so Settings/uninstall can see what a parent bundled.
    ...(template.includes && template.includes.length > 0
      ? { includes: template.includes }
      : {}),
    // Snapshot required secrets so Settings can render "required by template" forever (§4.5).
    ...(manifest.secrets && manifest.secrets.length > 0
      ? {
          secrets: manifest.secrets.map((s) => ({
            name: s.name,
            ...(s.description ? { description: s.description } : {}),
            ...(s.sandbox ? { sandbox: s.sandbox } : {}),
            ...(s.provisioned ? { provisioned: s.provisioned } : {}),
            ...(s.generated ? { generated: s.generated } : {}),
          })),
        }
      : {}),
    ...(hasSandboxWork(manifest.sandbox) ? { sandbox: manifest.sandbox } : {}),
    // Snapshot required OAuth scopes per provider so a Reconnect can request the right set forever
    // (issue #30) — a grant row's stored scopes are only a record of what was granted, never the
    // request template. Prefer the resolved template's `auths` (parent + every included connector,
    // deduped by provider); fall back to a plain template's single `manifest.auth` descriptor.
    // Scope groups (issue #165) / capability groups (issue #166): the snapshot also records the
    // installer's selections.
    ...(authSnapshot(template, ctx.authSelections, ctx.capabilitySelections)
      .length > 0
      ? {
          auth: authSnapshot(
            template,
            ctx.authSelections,
            ctx.capabilitySelections,
          ),
        }
      : {}),
  };
  let baseLock = ctx.lock;
  for (const e of absorbed) baseLock = removeInstall(baseLock, e.id, e.member);
  const nextLock = upsertInstall(baseLock, entry);
  writes.push({
    path: "harnesst-lock.json",
    content: serializeLock(nextLock),
  });
  const nextSandboxEntries = sandboxEntries(nextLock, member);
  const previousSandboxEntries = sandboxEntries(ctx.lock, member);
  // The managed sandbox module is generated, never lock-owned, so a normal install overwrites it
  // freely. But register mode's no-overwrite promise must also cover a HAND-AUTHORED
  // `sandbox/sandbox.ts`: when harnesst wasn't already managing one (no prior sandbox install) and a
  // file occupies that path, it is the customer's — keep it byte-for-byte and skip the managed
  // write, at the cost of not wiring this install's sandbox bootstrap.
  const sbModulePath = sandboxModulePath(rootForMember(member));
  const preserveSandboxModule =
    ctx.keepExistingFiles &&
    occupiedAt(sbModulePath) &&
    previousSandboxEntries.length === 0 &&
    !ownedByOtherInstall.has(sbModulePath);
  if (preserveSandboxModule) {
    if (nextSandboxEntries.length > 0) {
      warnings.push(
        `Kept your existing \`${sbModulePath}\` unchanged — the sandbox bootstrap for this install was not wired in.`,
      );
    }
  } else if (nextSandboxEntries.length > 0 || previousSandboxEntries.length > 0) {
    writes.push({
      path: sbModulePath,
      content: renderManagedSandboxModule(
        rootForMember(member),
        nextLock,
        member,
      ),
    });
    // Regenerating the module is the moment an unowned add-on disappears (issue #254) — say so.
    for (const orphan of orphanedSandboxAddons(
      rootForMember(member),
      nextSandboxEntries.map((e) => e.id),
      ctx,
      new Set(deletions),
    )) {
      warnings.push(
        `\`${orphan}\` isn't owned by any install, so the regenerated \`${sbModulePath}\` no longer imports it and it will stop running. Install it from the marketplace instead of hand-authoring it.`,
      );
    }
  }

  return {
    writes,
    deletions,
    conflicts,
    canKeepExistingFiles:
      target.kind === "member" &&
      occupiedTemplatePaths.length > 0 &&
      preservableTemplatePaths.length === occupiedTemplatePaths.length &&
      nonFileConflictCount === 0,
    preservedFiles,
    warnings,
    isUpdate,
    secrets: (manifest.secrets ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      sandbox: s.sandbox,
      provisioned: s.provisioned,
      generated: s.generated,
    })),
  };
}

/**
 * Plan an uninstall (PRD §7.8): delete the entry's owned files, drop it from the lock, and hand
 * back the npm packages it recorded so the reviewer can prune them (we deliberately leave deps —
 * they may be shared with hand-written code). Deletions are intersected with what's actually on
 * the branch so we never stage a delete for a file the customer already removed by hand.
 */
export function planUninstall(ctx: {
  lock: HarnesstLock;
  id: string;
  memberName: string | null;
  repoPaths: string[];
}): {
  deletions: string[];
  writes: Array<{ path: string; content: string }>;
  lockWrite: { path: string; content: string };
  depsLeft: string[];
  notFound: boolean;
} {
  const entry = findInstall(ctx.lock, ctx.id, ctx.memberName);
  if (!entry) {
    return {
      deletions: [],
      writes: [],
      lockWrite: { path: "harnesst-lock.json", content: serializeLock(ctx.lock) },
      depsLeft: [],
      notFound: true,
    };
  }
  const deletions = entry.files.filter((f) => ctx.repoPaths.includes(f));
  const nextLock = removeInstall(ctx.lock, ctx.id, ctx.memberName);
  const writes = [
    {
      path: "harnesst-lock.json",
      content: serializeLock(nextLock),
    },
  ];
  if (
    hasSandboxWork(entry.sandbox) ||
    sandboxEntries(nextLock, ctx.memberName).length > 0
  ) {
    writes.push({
      path: sandboxModulePath(rootForMember(ctx.memberName)),
      content: renderManagedSandboxModule(
        rootForMember(ctx.memberName),
        nextLock,
        ctx.memberName,
      ),
    });
  }
  return {
    deletions,
    writes,
    lockWrite: writes[0],
    depsLeft: Object.keys(entry.dependencies ?? {}),
    notFound: false,
  };
}
