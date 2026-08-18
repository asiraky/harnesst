/**
 * Saved drafts (PRD §7.3): saving an editor writes a draft row (Postgres, refresh-proof) and
 * does nothing else. Publishing — the pipeline in app/publish/pipeline.server.ts — takes EVERY
 * saved draft through check → build → commit → version → deploy in one action (issue #225).
 * Per-file rows so the publish panel can show and discard individual files.
 *
 * Drafts are in-flight edits only; the repo remains the source of truth for published config.
 */
import type { DataStore, DraftChange } from "~/data/ports";
import { agentForPath } from "~/db/queries.server";
import { HARNESST_EVE_DOCKERFILE } from "~/deploy/eve-image.server";
import {
  ensureOpenRouterDependency,
  LEGACY_OPENROUTER_PROVIDER_PACKAGE,
  OPENROUTER_PROVIDER_PACKAGE,
  repairHarnesstGatewayWiring,
} from "~/eve/agentModule";
import {
  legacyOrgModelModulePath,
  orgModelModulePath,
  rewriteOrgModelImports,
} from "~/eve/org-model-module";
import { EMPTY_TEAM_MARKER } from "~/eve/parse";
import { fetchAgentSource, readAgentFile } from "~/github/repo.server";
import { isAssistantConfigPath } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { BuildCheckRequest, BuildCheckResult } from "~/seams/types";

export interface StageInput {
  projectId: string;
  path: string;
  /** Full file contents; null stages a DELETION of the path. */
  content: string | null;
  /** Blob sha of the file when the edit was made (conflict hints later). */
  baseSha?: string | null;
  createdBy?: string | null;
}

/**
 * Stage (or restage) a draft for a file. Latest save per path wins. The owning roster
 * member is derived from the path's agent root (Milestone 5.5: drafts key by agent);
 * project-shared files outside every member (root package.json) stage unattributed.
 */
export async function stageDraft(
  input: StageInput,
  store: DataStore = getRuntime().data,
): Promise<DraftChange> {
  const agents = await store.agents.listByProject(input.projectId);
  const agent = agentForPath(agents, input.path);
  return store.drafts.upsert({ ...input, agentId: agent?.id ?? null });
}

/**
 * Save DELETIONS: one null-content draft per path. Deletes ride in the same change-set as
 * edits — nothing touches git until the user publishes. Any saved edit on the same path is
 * superseded (the upsert overwrites it).
 */
export async function stageDeletions(
  input: { projectId: string; paths: string[]; createdBy?: string | null },
  store: DataStore = getRuntime().data,
): Promise<void> {
  for (const path of input.paths) {
    await stageDraft(
      { projectId: input.projectId, path, content: null, createdBy: input.createdBy },
      store,
    );
  }
}

/** All saved drafts for a project, oldest first. */
export function listDrafts(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<DraftChange[]> {
  return store.drafts.listByProject(projectId);
}

/** The saved draft for one file, if any (editors overlay this over the repo content). */
export function getDraft(
  projectId: string,
  path: string,
  store: DataStore = getRuntime().data,
): Promise<DraftChange | null> {
  return store.drafts.get(projectId, path);
}

/** Discard saved drafts without publishing. */
export function discardDrafts(
  projectId: string,
  paths: string[],
  store: DataStore = getRuntime().data,
): Promise<void> {
  return store.drafts.deleteByPaths(projectId, paths);
}

/**
 * The member's AGENT root implied by a staged path — the key both the orphan check and the build
 * planner group by. Everything a member owns maps here, not just its `agent/` tree: its
 * package.json, and its platform-owned `agents/<member>/harnesst/**` sibling (issue #254). Miss
 * the platform files and `findOrphanedDrafts` calls every one of them an orphan, because no
 * roster row ever has `agents/<member>/harnesst` as its root — which would reject every publish
 * carrying a marketplace migration.
 */
function stagedTeamMemberRoot(path: string): string | null {
  const agentMatch = path.match(/^agents\/([^/]+)\/agent(?:\/|$)/);
  if (agentMatch) return `agents/${agentMatch[1]}/agent`;
  const platformMatch = path.match(/^agents\/([^/]+)\/harnesst\//);
  if (platformMatch) return `agents/${platformMatch[1]}/agent`;
  const packageMatch = path.match(/^agents\/([^/]+)\/package\.json$/);
  return packageMatch ? `agents/${packageMatch[1]}/agent` : null;
}

/**
 * Drafts stranded under a member root that no longer exists (issue #67). A draft whose path
 * implies `agents/<name>/…` is orphaned when the roster and repo tree no longer back that member
 * AND the selection doesn't itself (re)create the member's agent code. Feeding one to the build
 * gate yields an opaque eve failure ("Could not resolve an eve agent root"), so we detect them
 * and let the user discard instead.
 */
export function findOrphanedDrafts(
  roster: { root: string }[],
  repoPaths: string[],
  drafts: DraftChange[],
): DraftChange[] {
  const backedRoots = new Set<string>();
  for (const a of roster) backedRoots.add(a.root);
  // Repo code already under a member's agent dir backs that member…
  for (const p of repoPaths) {
    const m = p.match(/^(agents\/[^/]+\/agent)\//);
    if (m) backedRoots.add(m[1]);
  }
  // …as does a non-null draft inside it (a new-member install creates the code before the roster
  // and repo ever see it). Deliberately still `agent/` only: platform files under
  // `agents/<name>/harnesst/` never constitute a member — publishing them for a member with no
  // agent code would build a root eve can't resolve, which is the failure this gate exists to
  // pre-empt. A real new-member install stages its scaffold in the same change-set.
  for (const d of drafts) {
    if (d.content === null) continue;
    const m = d.path.match(/^(agents\/[^/]+\/agent)\//);
    if (m) backedRoots.add(m[1]);
  }
  return drafts.filter((d) => {
    const root = stagedTeamMemberRoot(d.path);
    return root !== null && !backedRoots.has(root);
  });
}

/** The member name in an orphaned draft's path (for messaging). */
function orphanedMemberName(path: string): string | null {
  return path.match(/^agents\/([^/]+)\//)?.[1] ?? null;
}

/** The user-facing failure for orphaned drafts: name the dead member(s), list the paths. */
export function orphanedDraftsMessage(orphaned: DraftChange[]): string {
  const names = [...new Set(orphaned.map((d) => orphanedMemberName(d.path)).filter(Boolean))];
  const plural = orphaned.length === 1 ? "" : "s";
  return `Can't publish — ${orphaned.length} saved change${plural} ${
    orphaned.length === 1 ? "belongs" : "belong"
  } to ${
    names.length === 1 ? `"${names[0]}"` : `agents (${names.map((n) => `"${n}"`).join(", ")})`
  }, which is no longer part of this team. Discard ${
    orphaned.length === 1 ? "it" : "them"
  }, then publish again:\n\n${orphaned.map((d) => `- \`${d.path}\``).join("\n")}`;
}

/**
 * The member roots a change-set must build. Member-scoped changes build only their owners. A
 * truly shared file (for example the root package.json) can affect every package, so it widens the
 * build to every current member while retaining roots for newly staged members. Metadata-only
 * changes have no owning path and therefore build every current member too.
 *
 * A team repository's root is not itself an Eve project. Never represent a shared change as an
 * undefined/root build: doing so makes the build-context injector manufacture `agent/` at the
 * repository root, and Eve then discovers that platform-only directory instead of the members.
 */
export function inferBuildRoots(
  agents: { id: string; root: string }[],
  drafts: DraftChange[],
): string[] {
  const roots = new Set<string>();
  let touchesSharedFile = false;
  for (const draft of drafts) {
    // Assistant config (`.harnesst/assistant/**`) compiles into nothing — the pipeline restarts the
    // assistant instead of building. Skip it BEFORE the agentId lookup: these drafts carry the
    // internal assistant row's id, whose `.harnesst/assistant` root is not a buildable eve project,
    // and a mixed set (member edit + assistant config) must build exactly the member roots.
    if (isAssistantConfigPath(draft.path)) continue;
    const agentRoot =
      (draft.agentId
        ? agents.find((a) => a.id === draft.agentId)?.root
        : undefined) ?? stagedTeamMemberRoot(draft.path);
    if (agentRoot) {
      roots.add(agentRoot);
      continue;
    }
    // Repo-level harnesst metadata should not force a whole-repo build: marketplace provenance
    // (harnesst-lock.json) and the team-layout marker README (saved by a remove-member so an
    // emptied team stays detectable) have no build of their own.
    if (draft.path === "harnesst-lock.json" || draft.path === EMPTY_TEAM_MARKER) continue;
    touchesSharedFile = true;
  }
  // With no member-owned draft, the change is either shared or metadata-only. Both must validate
  // every runnable member. For a mixed shared/member set, keep staged new-member roots too.
  if (touchesSharedFile || roots.size === 0) {
    for (const agent of agents) roots.add(agent.root);
  }
  return [...roots];
}

/**
 * What an editor should show for a file, and where that value comes from. The editor always
 * displays the user's LATEST intended value: a saved draft wins over the default branch —
 * without that, an unpublished save would be invisible in the editors ("I set the model
 * yesterday, why does the editor show the old one?").
 */
export interface FileView {
  /** Content to show; null when the file exists nowhere yet. */
  content: string | null;
  source: "draft" | "repo";
  /** The file exists on the default branch (vs. being newly created by a draft). */
  existsInRepo: boolean;
  /** A deletion is saved for this path (editors show the repo content plus a banner;
   * saving new content un-deletes). */
  stagedDeletion: boolean;
}

/** GitHub reads injected so unit tests run without a repo. */
export interface FileViewDeps {
  readFile: typeof readAgentFile;
}

export async function resolveFileView(
  project: {
    id: string;
    repoInstallationId: string;
    repoOwner: string;
    repoName: string;
  },
  path: string,
  store: DataStore = getRuntime().data,
  deps: FileViewDeps = { readFile: readAgentFile },
): Promise<FileView> {
  const repo = { owner: project.repoOwner, repo: project.repoName };
  const [repoContent, draft] = await Promise.all([
    deps.readFile(project.repoInstallationId, repo, path),
    store.drafts.get(project.id, path),
  ]);
  const existsInRepo = repoContent !== null;

  // A saved draft is the newest edit — it wins over the repo. A deletion draft (null content)
  // still shows the repo content so there's something to look at; the flag drives the
  // "will be deleted" banner.
  if (draft) {
    return draft.content === null
      ? { content: repoContent, source: "draft", existsInRepo, stagedDeletion: true }
      : { content: draft.content, source: "draft", existsInRepo, stagedDeletion: false };
  }

  return { content: repoContent, source: "repo", existsInRepo, stagedDeletion: false };
}

/** Publish build check: compile-check the drafts against the target branch (injectable in tests). */
export type CheckBuildFn = (req: BuildCheckRequest) => Promise<BuildCheckResult>;

/** Repo tree reader for the orphan check (injectable in tests). */
export type ListRepoPathsFn = (input: {
  installationId: string;
  owner: string;
  repo: string;
}) => Promise<string[]>;

export type PublishFile = { path: string; content: string | null };

function packageJsonPathForAgentRoot(root: string): string {
  if (root === "agent") return "package.json";
  return `${root.replace(/\/agent$/, "")}/package.json`;
}

function agentRootForAgentModule(path: string): string | null {
  if (path === "agent/agent.ts") return "agent";
  const match = path.match(/^(agents\/[^/]+\/agent)\/agent\.ts$/);
  if (match) return match[1];
  // A subagent module (`<root>/subagents/<name>/agent.ts`) compiles in its member's build and
  // shares the member's package.json — a wired subagent selected alone still needs the member's
  // provider-dependency overlay below.
  const subagent = path.match(
    /^(agent|agents\/[^/]+\/agent)\/subagents\/.+\/agent\.ts$/,
  );
  return subagent ? subagent[1] : null;
}

function usesOpenRouter(source: string | null | undefined): boolean {
  return Boolean(
    source &&
      (source.includes(OPENROUTER_PROVIDER_PACKAGE) ||
        /\bopenrouter(?:\.chatModel)?\s*\(/.test(source)),
  );
}

interface NormalizeInput {
  project: {
    repoInstallationId: string;
    repoOwner: string;
    repoName: string;
  };
  files: PublishFile[];
}

/**
 * The AGENT root a staged path belongs to, for the relocation pass below. Deliberately broader
 * than `stagedTeamMemberRoot` (which answers "whose draft is this?" and ignores single-agent
 * repos) and than `agentRootForAgentModule` (which only recognizes agent modules): here ANY file
 * a member owns — including its platform-owned `harnesst/` sibling — is enough, because a
 * change-set that touches a member at all is the moment to finish that member's relocation.
 */
function agentRootForStagedPath(path: string): string | null {
  const member = path.match(/^agents\/([^/]+)\//);
  if (member) return `agents/${member[1]}/agent`;
  return /^(?:agent|harnesst)\//.test(path) ? "agent" : null;
}

/**
 * Relocate a pre-#254 `<agentRoot>/harnesst-model.ts` into the platform root
 * (`<platformRoot>/model.ts`), rewriting the import specifier in every file that imports it.
 *
 * This is a publish-time normalization and not a marketplace update because the module is
 * scaffold-emitted: no install owns it, so no update can move it, and it can't be left where it
 * is either — the model module is platform code, and the whole point of #254 is that platform
 * code lives outside the tree eve discovers and outside the tree hands may edit.
 *
 * Cost discipline: the pass probes with ONE content read per touched member and returns
 * immediately when nothing legacy is there — the steady state for every already-relocated repo.
 * The tree read only happens for a member that still has the old file, i.e. once, ever.
 */
export async function relocateLegacyModelModuleDrafts(
  input: NormalizeInput,
): Promise<PublishFile[]> {
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const repo = { owner: input.project.repoOwner, repo: input.project.repoName };
  const read = (path: string) =>
    readAgentFile(input.project.repoInstallationId, repo, path);

  const roots = new Set<string>();
  for (const path of byPath.keys()) {
    const root = agentRootForStagedPath(path);
    if (root) roots.add(root);
  }
  if (roots.size === 0) return [...byPath.values()];

  const legacy = new Map<string, string>();
  await Promise.all(
    [...roots].map(async (root) => {
      const staged = byPath.get(legacyOrgModelModulePath(root));
      // A staged deletion means someone is already moving it — leave the change-set alone.
      const content = staged ? staged.content : await read(legacyOrgModelModulePath(root));
      if (content !== null) legacy.set(root, content);
    }),
  );
  if (legacy.size === 0) return [...byPath.values()];

  // Raw, not the cached wrapper: this read is composed into a commit, and a stale tree would
  // silently leave a subagent's import pointing at a file this same change-set deletes.
  const source = await fetchAgentSource(input.project.repoInstallationId, repo);

  for (const [root, content] of legacy) {
    const from = legacyOrgModelModulePath(root);
    const to = orgModelModulePath(root);
    // A move, not a regeneration: the operator asked to publish their change-set, not to take a
    // new generation of the module. (A repo that already has the file keeps the one it has.)
    if (!byPath.has(to) && (await read(to)) === null) {
      byPath.set(to, { path: to, content });
    }
    byPath.set(from, { path: from, content: null });

    // Every file under the member's agent root that still names the old specifier. The scaffold
    // only ever writes the import into `agent.ts` and `subagents/<name>/agent.ts`, but a
    // hand-written tool may import it too and a stale specifier fails the build gate — so scan
    // the root rather than the two shapes we happen to generate.
    const candidates = new Set(
      [...source.paths, ...byPath.keys()].filter(
        (path) => path !== from && path.startsWith(`${root}/`) && /\.tsx?$/.test(path),
      ),
    );
    await Promise.all(
      [...candidates].map(async (path) => {
        const staged = byPath.get(path)?.content;
        if (staged === null) return; // staged for deletion — nothing to rewrite
        // `source.files` already carries every agent/subagent module eagerly; only a
        // hand-written importer costs an extra read.
        const before = staged ?? source.files[path] ?? (await read(path));
        if (before === null) return;
        const depth = path.slice(root.length + 1).split("/").length - 1;
        const after = rewriteOrgModelImports(before, depth);
        if (after !== before) byPath.set(path, { path, content: after });
      }),
    );
  }

  return [...byPath.values()];
}

/**
 * Bring already-relocated agent and subagent imports up to NodeNext's emitted-file convention.
 * #336 changed new scaffolds to `.js`, but repos published before that fix still contain an
 * extensionless `../harnesst/model` import. Restage those generated modules whenever the member
 * next publishes so the production repair is deploy → publish, with no hand-edited generated
 * source required.
 */
export async function normalizeOrgModelImportDrafts(
  input: NormalizeInput,
): Promise<PublishFile[]> {
  const byPath = new Map(
    (await relocateLegacyModelModuleDrafts(input)).map((file) => [file.path, file]),
  );
  const roots = new Set<string>();
  for (const path of byPath.keys()) {
    const root = agentRootForStagedPath(path);
    if (root) roots.add(root);
  }
  if (roots.size === 0) return [...byPath.values()];

  const repo = { owner: input.project.repoOwner, repo: input.project.repoName };
  const source = await fetchAgentSource(input.project.repoInstallationId, repo);
  const candidates = new Set(
    [...source.paths, ...byPath.keys()].filter((path) => {
      const root = agentRootForAgentModule(path);
      return root !== null && roots.has(root);
    }),
  );

  await Promise.all(
    [...candidates].map(async (path) => {
      const staged = byPath.get(path)?.content;
      if (staged === null) return;
      const before =
        staged ??
        source.files[path] ??
        (await readAgentFile(input.project.repoInstallationId, repo, path));
      if (before === null) return;
      const root = agentRootForAgentModule(path);
      if (!root) return;
      const depth = path.slice(root.length + 1).split("/").length - 1;
      // Model saves before #354 could place harnesstGateway inside a multiline OpenRouter object.
      // Heal that generated syntax during the normal publish coherence pass so an already-saved
      // draft becomes publishable immediately after the control-plane fix is deployed.
      const after = repairHarnesstGatewayWiring(rewriteOrgModelImports(before, depth));
      if (after !== before) byPath.set(path, { path, content: after });
    }),
  );

  return [...byPath.values()];
}

export async function normalizeOpenRouterPackageDrafts(
  input: NormalizeInput,
): Promise<PublishFile[]> {
  // Generated model imports normalize first so anything pulled into the change-set gets the
  // same dependency coherence as any other selected file.
  const byPath = new Map(
    (await normalizeOrgModelImportDrafts(input)).map((file) => [file.path, file]),
  );

  // package.json paths whose content ensureOpenRouterDependency ACTUALLY changed — only these
  // made the repo's committed lockfile stale. A user-authored package.json that already carries
  // the provider dep (or differs from the repo copy for unrelated reasons) keeps its lock: the
  // deletion below is permanent (harnesst never regenerates lockfiles) and downgrades every
  // future build's cached `npm ci` to a cold `npm install` (issue #375).
  const rewrittenPkgPaths = new Set<string>();

  // If a stale package draft is selected, fix it in-place before the build gate sees it.
  for (const file of byPath.values()) {
    if (
      file.path.endsWith("package.json") &&
      (file.content?.includes(OPENROUTER_PROVIDER_PACKAGE) ||
        file.content?.includes(LEGACY_OPENROUTER_PROVIDER_PACKAGE))
    ) {
      const normalized = ensureOpenRouterDependency(file.content);
      if (normalized !== file.content) rewrittenPkgPaths.add(file.path);
      file.content = normalized;
    }
  }

  // If an OpenRouter-backed agent.ts is selected without its package file, add the required
  // package overlay too. Otherwise the publish check builds a tree with code that imports the
  // provider but no compatible provider dependency.
  const roots = new Set<string>();
  for (const file of byPath.values()) {
    const root = agentRootForAgentModule(file.path);
    if (root && usesOpenRouter(file.content)) roots.add(root);
  }

  const repo = { owner: input.project.repoOwner, repo: input.project.repoName };
  for (const root of roots) {
    const pkgPath = packageJsonPathForAgentRoot(root);
    const selected = byPath.get(pkgPath);
    if (selected?.content === null) continue;
    const base =
      selected?.content ??
      (await readAgentFile(input.project.repoInstallationId, repo, pkgPath));
    if (base === null) continue;
    const normalized = ensureOpenRouterDependency(base);
    if (normalized !== base) rewrittenPkgPaths.add(pkgPath);
    if (normalized !== base || !selected) {
      byPath.set(pkgPath, { path: pkgPath, content: normalized });
    }
  }

  // A harnesst dependency rewrite makes the repo's committed package-lock.json stale, and both
  // the build gate and the deployed image run `npm ci`, which hard-fails on any lock mismatch.
  // Stage the lock's deletion alongside the changed package.json so the build falls back to
  // `npm install` (harnesst never authors lockfiles, so it can't regenerate one). Gated on
  // rewrittenPkgPaths: ONLY a package.json harnesst itself rewrote justifies losing the lock —
  // a user edit ships with whatever lock state the user committed.
  for (const file of [...byPath.values()]) {
    if (!file.path.endsWith("package.json") || typeof file.content !== "string") continue;
    if (!rewrittenPkgPaths.has(file.path)) continue;
    const lockPath = file.path.replace(/package\.json$/, "package-lock.json");
    if (byPath.has(lockPath)) continue;
    const repoPkg = await readAgentFile(input.project.repoInstallationId, repo, file.path);
    if (repoPkg === file.content) continue; // dependencies unchanged — the lock is still valid
    const lock = await readAgentFile(input.project.repoInstallationId, repo, lockPath);
    if (lock === null) continue;
    byPath.set(lockPath, { path: lockPath, content: null });

    // Repos scaffolded by older harnesst releases carry a committed copy of harnesst's reference
    // Dockerfile that COPYs package-lock.json explicitly and runs a bare `npm ci` — deleting the
    // lock would break it at COPY. That file is ours (its header says so — either the current
    // "harnesst" marker or the legacy "harnesst" one), so heal it to the current reference image,
    // which tolerates a missing lock. A user-authored Dockerfile (no such header) is never
    // touched — the repo stays theirs (D3).
    const dockerfilePath = file.path.replace(/package\.json$/, "Dockerfile");
    if (byPath.has(dockerfilePath)) continue;
    const dockerfile = await readAgentFile(
      input.project.repoInstallationId,
      repo,
      dockerfilePath,
    );
    if (
      dockerfile !== null &&
      dockerfile.includes("package-lock.json") &&
      /^#.*(harnesst|harnesst).*(reference|generated)/im.test(
        dockerfile.split("\n", 1)[0],
      )
    ) {
      byPath.set(dockerfilePath, { path: dockerfilePath, content: HARNESST_EVE_DOCKERFILE });
    }
  }

  return [...byPath.values()];
}
