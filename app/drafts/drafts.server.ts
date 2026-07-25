/**
 * Staged change-sets (PRD §7.3): saving an editor STAGES a draft (Postgres, refresh-proof);
 * PUBLISHING turns the selected drafts into one working branch + one PR via proposeChange.
 * The product analogue of git's staging area — per-file rows so a change can be unchecked at
 * publish time, which a working-branch-of-commits couldn't do without history rewriting.
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
import { getAgentSource } from "~/github/cached.server";
import { readAgentFile } from "~/github/repo.server";
import {
  findOpenChangeForFile,
  proposeChange,
  type ProposedChange,
} from "~/github/write.server";
import { newId } from "~/lib/id";
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
 * Stage DELETIONS: one null-content draft per path. Deletes stack in the same change-set as
 * edits — nothing touches git until the user publishes or ships from the Deployment tab.
 * Any staged edit on the same path is superseded (the upsert overwrites it).
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

/** All staged drafts for a project, oldest first. */
export function listDrafts(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<DraftChange[]> {
  return store.drafts.listByProject(projectId);
}

/** The staged draft for one file, if any (editors overlay this over the repo content). */
export function getDraft(
  projectId: string,
  path: string,
  store: DataStore = getRuntime().data,
): Promise<DraftChange | null> {
  return store.drafts.get(projectId, path);
}

/** Discard staged drafts without publishing. */
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

/**
 * The member roots a selection spans — the gate builds each one. `undefined` means the
 * selection touches a truly shared file (e.g. the root package.json), where only a repo-root
 * check can see the effect.
 */
function inferBuildRoots(
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
    // Marketplace provenance is repo-level but should not force a whole-repo build when
    // selected with member install/update drafts.
    if (draft.path === "eden-lock.json") continue;
    return undefined;
  }
  return [...roots];
}

/**
 * What an editor should show for a file, and where that value comes from. The editor always
 * displays the user's LATEST intended value, walking back through the change lifecycle:
 *   staged draft → open change request → default branch.
 * Without the middle step, publishing made an edit invisible in the editors (the draft is
 * deleted, main still has the old value) until the change request merged — "I set the model
 * yesterday, why does the editor show the old one?".
 */
export interface FileView {
  /** Content to show; null when the file exists nowhere yet. */
  content: string | null;
  source: "draft" | "change-request" | "repo";
  /** The file exists on the default branch (vs. being newly created by a draft/change). */
  existsInRepo: boolean;
  /** Set when source is "change-request": the open change holding the pending value. */
  change: { number: number; title: string } | null;
  /** A deletion is staged for this path (editors show the repo content plus a banner;
   * saving stages new content, which un-deletes). */
  stagedDeletion: boolean;
}

/** GitHub reads injected so unit tests run without a repo. */
export interface FileViewDeps {
  readFile: typeof readAgentFile;
  findOpenChange: typeof findOpenChangeForFile;
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
  deps: FileViewDeps = { readFile: readAgentFile, findOpenChange: findOpenChangeForFile },
): Promise<FileView> {
  const repo = { owner: project.repoOwner, repo: project.repoName };
  const [repoContent, draft, pending] = await Promise.all([
    deps.readFile(project.repoInstallationId, repo, path),
    store.drafts.get(project.id, path),
    deps.findOpenChange(project.repoInstallationId, repo, path),
  ]);
  const existsInRepo = repoContent !== null;

  // A staged draft is the newest edit — it wins even over an open change request. A
  // deletion draft (null content) still shows the repo content so there's something to
  // look at; the flag drives a "staged for deletion" banner.
  if (draft) {
    return draft.content === null
      ? { content: repoContent, source: "draft", existsInRepo, change: null, stagedDeletion: true }
      : { content: draft.content, source: "draft", existsInRepo, change: null, stagedDeletion: false };
  }

  if (pending) {
    const pendingContent = await deps.readFile(
      project.repoInstallationId,
      { ...repo, ref: pending.branch },
      path,
    );
    return {
      content: pendingContent ?? repoContent,
      source: "change-request",
      existsInRepo,
      change: { number: pending.number, title: pending.title },
      stagedDeletion: false,
    };
  }

  return { content: repoContent, source: "repo", existsInRepo, change: null, stagedDeletion: false };
}

/** Injected so unit tests exercise selection/cleanup without GitHub. */
export type ProposeFn = typeof proposeChange;

/** Publish gate: compile-check the drafts against the target branch (injectable in tests). */
export type CheckBuildFn = (req: BuildCheckRequest) => Promise<BuildCheckResult>;

/** Default gate: the runtime DeployTarget's checkBuild, or skip when it has none. */
const runtimeCheckBuild: CheckBuildFn = async (req) => {
  const target = getRuntime().deployTarget;
  return target.checkBuild ? target.checkBuild(req) : { ok: true, skipped: true };
};

/** Repo tree reader for the orphan check (injectable in tests). */
export type ListRepoPathsFn = (input: {
  installationId: string;
  owner: string;
  repo: string;
}) => Promise<string[]>;

/** Default: the cached repo source's paths; on any failure, fall back to an empty tree so the
 *  orphan check degrades to roster + selection rather than blocking a publish on a GitHub hiccup. */
const runtimeListRepoPaths: ListRepoPathsFn = async ({ installationId, owner, repo }) => {
  try {
    const source = await getAgentSource(installationId, { owner, repo });
    return source.paths;
  } catch {
    return [];
  }
};

type PublishFile = { path: string; content: string | null };

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

async function normalizeOpenRouterPackageDrafts(input: {
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

  // A harnesst dependency rewrite makes the repo's committed package-lock.json stale, and both
  // the build gate and the deployed image run `npm ci`, which hard-fails on any lock mismatch.
  // Stage the lock's deletion alongside the changed package.json so the build falls back to
  // `npm install` (harnesst never authors lockfiles, so it can't regenerate one).
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

    // Repos scaffolded by older harnesst releases carry a committed copy of harnesst's reference
    // Dockerfile that COPYs package-lock.json explicitly and runs a bare `npm ci` — deleting the
    // lock would break it at COPY. That file is ours (its header says so — either the current
    // "harnesst" marker or the legacy "eden" one), so heal it to the current reference image,
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
      /^#.*(eden|harnesst).*(reference|generated)/im.test(
        dockerfile.split("\n", 1)[0],
      )
    ) {
      byPath.set(dockerfilePath, { path: dockerfilePath, content: EDEN_EVE_DOCKERFILE });
    }
  }

  return [...byPath.values()];
}

/**
 * Publish the SELECTED staged drafts as one change-set: one branch, one commit per file, one
 * PR. Published drafts are deleted (they're now on the branch); unselected drafts stay staged
 * for a later publish. Paths not actually staged are ignored.
 */
export async function publishDrafts(
  input: {
    project: {
      id: string;
      repoInstallationId: string;
      repoOwner: string;
      repoName: string;
      defaultBranch: string;
    };
    /** Paths the human left checked in the staging list. */
    paths: string[];
    title?: string;
    createdBy?: string | null;
    /**
     * Progress callback (issue #142): invoked before each member root's build check with a human
     * stage label, so a queued publish can stream "Checking the build for … (i/n)…" into the
     * workspace task indicator. Absent for the synchronous callers that don't render progress.
     */
    onStage?: (stage: string) => void | Promise<void>;
  },
  store: DataStore = getRuntime().data,
  propose: ProposeFn = proposeChange,
  checkBuild: CheckBuildFn = runtimeCheckBuild,
  listRepoPaths: ListRepoPathsFn = runtimeListRepoPaths,
): Promise<ProposedChange> {
  const staged = await store.drafts.listByProject(input.project.id);
  const selected = staged.filter((d) => input.paths.includes(d.path));
  if (selected.length === 0) {
    throw new Error("No staged changes selected to publish.");
  }

  const agents = await store.agents.listByProject(input.project.id);

  // Orphan gate (issue #67): a draft stranded under a member root that the roster, repo tree, and
  // selection no longer back would reach the build gate as a package.json with no agent code — eve
  // fails opaquely ("Could not resolve an eve agent root"). Detect it first and attribute the
  // blocking member so the user can discard instead of being permanently bricked.
  const repoPaths = await listRepoPaths({
    installationId: input.project.repoInstallationId,
    owner: input.project.repoOwner,
    repo: input.project.repoName,
  });
  const orphaned = findOrphanedDrafts(agents, repoPaths, selected);
  if (orphaned.length > 0) {
    const names = [...new Set(orphaned.map((d) => orphanedMemberName(d.path)).filter(Boolean))];
    const plural = orphaned.length === 1 ? "" : "s";
    throw new Error(
      `Can't publish — ${orphaned.length} staged change${plural} ${
        orphaned.length === 1 ? "belongs" : "belong"
      } to ${
        names.length === 1 ? `"${names[0]}"` : `agents (${names.map((n) => `"${n}"`).join(", ")})`
      }, which is no longer part of this team. Discard ${
        orphaned.length === 1 ? "it" : "them"
      } below, then publish again:\n\n${orphaned.map((d) => `- \`${d.path}\``).join("\n")}`,
    );
  }

  // Publish gate: the change-set must compile against the branch it targets. A failed check
  // creates NOTHING (no branch, no PR) and keeps the drafts staged so they can be fixed and
  // republished — broken code never becomes a change request. The gate builds each member
  // directory the selection touches (a multi-member publish — e.g. installing a channel on
  // several agents — checks every affected member; in a team repo the root is not an eve
  // project, so collapsing to one whole-repo build would always fail). For staged new members,
  // there is no agent row yet, so the root is inferred from `agents/<name>/...`. Selections
  // touching truly shared files check the repo root.
  const roots = inferBuildRoots(agents, selected);
  const files = await normalizeOpenRouterPackageDrafts({
    project: input.project,
    files: selected.map((d) => ({ path: d.path, content: d.content })),
  });

  // The built-in assistant's config (.eden/assistant/** markdown + JSON) is not part of any eve
  // build, so a changeset of ONLY those files has nothing to compile — skip the gate. Any member
  // file in the selection still triggers the normal build check.
  const assistantConfigOnly = selected.every((d) => isAssistantConfigPath(d.path));
  if (!assistantConfigOnly) {
    // A lock-only selection has no member root; fall through to the repo-root check rather
    // than silently skipping the gate. Sequential on purpose: checkEveBuild reuses one
    // docker tag per project, so concurrent checks would race on it.
    const buildRoots = !roots || roots.length === 0 ? [undefined] : roots;
    for (const [i, agentRoot] of buildRoots.entries()) {
      await input.onStage?.(
        `Checking the build for ${agentRoot ?? "the repository"}${
          buildRoots.length > 1 ? ` (${i + 1}/${buildRoots.length})` : ""
        }…`,
      );
      const check = await checkBuild({
        projectId: input.project.id,
        repo: { owner: input.project.repoOwner, repo: input.project.repoName },
        ref: input.project.defaultBranch,
        installationId: input.project.repoInstallationId,
        overlay: files,
        agentRoot,
      });
      if (!check.ok) {
        const scope = buildRoots.length > 1 && agentRoot ? ` for \`${agentRoot}\`` : "";
        throw new Error(
          `Build check failed${scope} — no change request was created. Fix this and publish again:\n\n${check.output}`,
        );
      }
    }
  }

  const deletions = selected.filter((d) => d.content === null).length;
  const title =
    input.title?.trim() ||
    (files.length === 1
      ? `${deletions === 1 ? "Remove" : "Update"} ${selected[0].path}`
      : `Update ${files.length} agent files`);
  const body = [
    "Published from harnesst's staged changes:",
    ...files.map((d) => `- ${d.content === null ? "delete " : ""}\`${d.path}\``),
  ].join("\n");

  const change = await propose(
    input.project.repoInstallationId,
    { owner: input.project.repoOwner, repo: input.project.repoName },
    {
      base: input.project.defaultBranch,
      branch: `eden/publish-${newId()}`,
      files,
      title,
      body,
      commitMessage: title,
    },
  );

  // Only after the PR exists: the published drafts now live on the branch.
  await store.drafts.deleteByPaths(
    input.project.id,
    selected.map((d) => d.path),
  );
  return change;
}
