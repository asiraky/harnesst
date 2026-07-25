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
import { EDEN_EVE_DOCKERFILE } from "~/deploy/eve-image.server";
import {
  ensureOpenRouterDependency,
  LEGACY_OPENROUTER_PROVIDER_PACKAGE,
  OPENROUTER_PROVIDER_PACKAGE,
} from "~/eve/agentModule";
import { EMPTY_TEAM_MARKER } from "~/eve/parse";
import { readAgentFile } from "~/github/repo.server";
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

function stagedTeamMemberRoot(path: string): string | null {
  const agentMatch = path.match(/^agents\/([^/]+)\/agent(?:\/|$)/);
  if (agentMatch) return `agents/${agentMatch[1]}/agent`;
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
  // and repo ever see it).
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
 * The member roots a change-set spans — the publish build runs once per root. `undefined` means
 * the set touches a truly shared file (e.g. the root package.json), where only a repo-root
 * build can see the effect.
 */
export function inferBuildRoots(
  agents: { id: string; root: string }[],
  drafts: DraftChange[],
): string[] | undefined {
  const roots = new Set<string>();
  for (const draft of drafts) {
    const agentRoot =
      (draft.agentId
        ? agents.find((a) => a.id === draft.agentId)?.root
        : undefined) ?? stagedTeamMemberRoot(draft.path);
    if (agentRoot) {
      roots.add(agentRoot);
      continue;
    }
    // Repo-level Eden metadata should not force a whole-repo build: marketplace provenance
    // (eden-lock.json) and the team-layout marker README (saved by a remove-member so an
    // emptied team stays detectable) have no build of their own.
    if (draft.path === "eden-lock.json" || draft.path === EMPTY_TEAM_MARKER) continue;
    return undefined;
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

export async function normalizeOpenRouterPackageDrafts(input: {
  project: {
    repoInstallationId: string;
    repoOwner: string;
    repoName: string;
  };
  files: PublishFile[];
}): Promise<PublishFile[]> {
  const byPath = new Map(input.files.map((file) => [file.path, file]));

  // If a stale package draft is selected, fix it in-place before the build gate sees it.
  for (const file of byPath.values()) {
    if (
      file.path.endsWith("package.json") &&
      (file.content?.includes(OPENROUTER_PROVIDER_PACKAGE) ||
        file.content?.includes(LEGACY_OPENROUTER_PROVIDER_PACKAGE))
    ) {
      file.content = ensureOpenRouterDependency(file.content);
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
    if (normalized !== base || !selected) {
      byPath.set(pkgPath, { path: pkgPath, content: normalized });
    }
  }

  // An Eden dependency rewrite makes the repo's committed package-lock.json stale, and both
  // the build gate and the deployed image run `npm ci`, which hard-fails on any lock mismatch.
  // Stage the lock's deletion alongside the changed package.json so the build falls back to
  // `npm install` (Eden never authors lockfiles, so it can't regenerate one).
  for (const file of [...byPath.values()]) {
    if (!file.path.endsWith("package.json") || typeof file.content !== "string") continue;
    if (!file.content.includes(OPENROUTER_PROVIDER_PACKAGE)) continue;
    const lockPath = file.path.replace(/package\.json$/, "package-lock.json");
    if (byPath.has(lockPath)) continue;
    const repoPkg = await readAgentFile(input.project.repoInstallationId, repo, file.path);
    if (repoPkg === file.content) continue; // dependencies unchanged — the lock is still valid
    const lock = await readAgentFile(input.project.repoInstallationId, repo, lockPath);
    if (lock === null) continue;
    byPath.set(lockPath, { path: lockPath, content: null });

    // Repos scaffolded by older Edens carry a committed copy of Eden's reference Dockerfile
    // that COPYs package-lock.json explicitly and runs a bare `npm ci` — deleting the lock
    // would break it at COPY. That file is Eden-authored (its header says so), so heal it to
    // the current reference image, which tolerates a missing lock. A user-authored Dockerfile
    // (no Eden header) is never touched — the repo stays theirs (D3).
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
      /^#.*eden.*(reference|generated)/im.test(dockerfile.split("\n", 1)[0])
    ) {
      byPath.set(dockerfilePath, { path: dockerfilePath, content: EDEN_EVE_DOCKERFILE });
    }
  }

  return [...byPath.values()];
}

