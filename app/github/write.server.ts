/**
 * Git write layer (Author pillar, M1) — the one primitive every editor and the Pi assistant
 * use to ship a change.
 *
 * D3 is git-native: harnesst never mutates the default branch directly. A change becomes a working
 * branch off the default branch, one or more file commits, and a pull request. Merging the PR
 * is the ship signal (later wired to deploy). The eve repo stays the single source of truth —
 * we persist nothing about the change locally; its state lives in GitHub.
 */
import { invalidateRepoChanges, invalidateRepoSource } from "./cached.server";
import { getInstallationOctokit } from "./client.server";

export interface FileChange {
  /** Repo-relative path, forward-slashed (e.g. "agent/instructions.md"). */
  path: string;
  /** New UTF-8 file contents; null deletes the file (e.g. removing a team member). */
  content: string | null;
}

export interface ProposeChangeInput {
  /** Base branch to branch from and target the PR at; defaults to the repo default branch. */
  base?: string;
  /** Working branch name to create/reuse (e.g. "eden/edit-instructions-abc"). */
  branch: string;
  files: FileChange[];
  title: string;
  body?: string;
  /** Commit message; defaults to `title`. */
  commitMessage?: string;
}

export interface ProposedChange {
  branch: string;
  base: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  /** True when we reused an already-open PR for this branch rather than creating one. */
  reusedPullRequest: boolean;
}

interface RepoRef {
  owner: string;
  repo: string;
}

type InstallationOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

/** HTTP status of an Octokit request error, if present. */
function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

/** Create the working branch off `baseSha`, tolerating "already exists". */
async function ensureBranch(
  octokit: InstallationOctokit,
  { owner, repo }: RepoRef,
  branch: string,
  baseSha: string,
): Promise<void> {
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
  } catch (error) {
    // 422 == ref already exists; reuse it so repeated saves stack on one branch/PR.
    if (statusOf(error) !== 422) throw error;
  }
}

/**
 * Commit `files` to `branch` as ONE commit via the Git Data API: blobs upload concurrently
 * (independent), then a single tree + commit + ref update. One change-set == one commit, and
 * no per-file sequential round-trips. A null-content entry deletes that path (tree sha null).
 */
export async function commitFiles(
  octokit: InstallationOctokit,
  { owner, repo }: RepoRef,
  branch: string,
  files: FileChange[],
  message: string,
): Promise<string> {
  const writes = files.filter((f): f is FileChange & { content: string } => f.content !== null);
  const deletes = files.filter((f) => f.content === null);
  const [blobs, head] = await Promise.all([
    Promise.all(
      writes.map((f) =>
        octokit.rest.git.createBlob({
          owner,
          repo,
          content: Buffer.from(f.content, "utf8").toString("base64"),
          encoding: "base64",
        }),
      ),
    ),
    octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }),
  ]);
  const headSha = head.data.object.sha;
  const headCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });
  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: headCommit.data.tree.sha,
    tree: [
      ...writes.map((f, i) => ({
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobs[i].data.sha,
      })),
      // sha: null in a tree entry removes the path from the base tree.
      ...deletes.map((f) => ({
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null,
      })),
    ],
  });
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.data.sha,
    parents: [headSha],
  });
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
  });
  return commit.data.sha;
}

/**
 * Create a working branch, commit `files` (one commit), and open (or reuse) a PR back to the
 * base branch. Idempotent per branch name: calling again with the same branch stacks commits
 * and reuses the open PR.
 */
export async function proposeChange(
  installationId: string | number,
  { owner, repo }: RepoRef,
  input: ProposeChangeInput,
): Promise<ProposedChange> {
  const octokit = await getInstallationOctokit(installationId);
  const ref: RepoRef = { owner, repo };

  const base =
    input.base ??
    (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

  const baseRef = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  await ensureBranch(octokit, ref, input.branch, baseRef.data.object.sha);
  await commitFiles(octokit, ref, input.branch, input.files, input.commitMessage ?? input.title);

  const result = await openOrReusePullRequest(octokit, ref, {
    base,
    branch: input.branch,
    title: input.title,
    body: input.body,
  });
  invalidateRepoChanges(installationId, ref);
  return result;
}

/** A file touched by a change, with line deltas for a PM-readable diff summary. */
export interface ChangedFile {
  path: string;
  /** GitHub file status: added | modified | removed | renamed. */
  status: string;
  additions: number;
  deletions: number;
  /** Unified-diff hunks GitHub computed for the file (absent for binary/too-large files). */
  patch?: string;
}

/** An open change-set (PR) awaiting review, with enough to review + merge it in-app. */
export interface OpenChange {
  number: number;
  title: string;
  /** PR body — the plain-language changelog harnesst wrote. */
  body: string;
  url: string;
  branch: string;
  base: string;
  createdAt: string;
  /** null while GitHub is still computing mergeability. */
  mergeable: boolean | null;
  /** e.g. "clean", "dirty" (conflicts), "blocked", "unknown". */
  mergeableState: string;
  /** True while the PR is still a draft/WIP (assistant conversation PRs open as drafts). */
  draft: boolean;
  files: ChangedFile[];
}

/**
 * List open pull requests harnesst opened for this repo (head branches under `eden/`), newest
 * first, each enriched with mergeability and its changed-file summary. This is the Changes
 * review inbox — the in-app surface that replaces bouncing to github.com to see/merge a PR.
 */
export async function listOpenChanges(
  installationId: string | number,
  { owner, repo }: RepoRef,
  limit = 20,
): Promise<OpenChange[]> {
  const octokit = await getInstallationOctokit(installationId);
  const list = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: 50,
  });
  // Only harnesst-authored change-sets (our editors/assistant all branch under `eden/`).
  const authoredPrs = list.data
    .filter((pr) => pr.head.ref.startsWith("eden/"))
    .slice(0, limit);

  return Promise.all(
    authoredPrs.map(async (pr) => {
      // pulls.get returns the computed `mergeable`/`mergeable_state` the list omits.
      const [detail, files] = await Promise.all([
        octokit.rest.pulls.get({ owner, repo, pull_number: pr.number }),
        octokit.rest.pulls.listFiles({ owner, repo, pull_number: pr.number, per_page: 100 }),
      ]);
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        url: pr.html_url,
        branch: pr.head.ref,
        base: pr.base.ref,
        createdAt: pr.created_at,
        mergeable: detail.data.mergeable,
        mergeableState: detail.data.mergeable_state,
        draft: detail.data.draft ?? false,
        files: files.data.map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
      } satisfies OpenChange;
    }),
  );
}

/**
 * Every changed file path of one PR (paginated past 100 files). The conversation-branch
 * merge gate recomputes build roots from these SERVER-side — a client-posted root could
 * under-specify a multi-member change (issue #137).
 */
export async function listPullRequestFilePaths(
  installationId: string | number,
  { owner, repo }: RepoRef,
  pullNumber: number,
): Promise<string[]> {
  const octokit = await getInstallationOctokit(installationId);
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files.map((f) => f.filename);
}

/** The newest open harnesst change request touching a given file. */
export interface PendingFileChange {
  number: number;
  title: string;
  branch: string;
  url: string;
}

/**
 * Find the newest open harnesst change request that touches `path`. Editors use this to surface a
 * published-but-unmerged value — without it, a file "loses" its latest edit the moment the
 * staged draft is published, until the change request merges.
 */
export async function findOpenChangeForFile(
  installationId: string | number,
  { owner, repo }: RepoRef,
  path: string,
): Promise<PendingFileChange | null> {
  const octokit = await getInstallationOctokit(installationId);
  const list = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: 50,
  });
  for (const pr of list.data.filter((p) => p.head.ref.startsWith("eden/"))) {
    const files = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });
    if (files.data.some((f) => f.filename === path)) {
      return { number: pr.number, title: pr.title, branch: pr.head.ref, url: pr.html_url };
    }
  }
  return null;
}

/**
 * Delete a change request: comment (so the PR trail says why it closed), close without
 * merging, and remove the working branch. Recoverable at the source — GitHub can restore the
 * branch from the closed PR — so the UI can treat this as delete without it being data loss.
 */
export async function closePullRequest(
  installationId: string | number,
  { owner, repo }: RepoRef,
  pullNumber: number,
  branch?: string,
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId);
  // Comment before closing so the trail exists even if a later step fails.
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: "Change request deleted from harnesst — closed without merging.",
  });
  await octokit.rest.pulls.update({ owner, repo, pull_number: pullNumber, state: "closed" });

  const head =
    branch ??
    (await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data.head.ref;
  if (head) {
    try {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${head}` });
    } catch {
      // protected or already-deleted branch — the close already succeeded
    }
  }
  invalidateRepoChanges(installationId, { owner, repo });
}

export interface MergeResult {
  /** The commit SHA on the base branch after merge — the canonical version identity (D9). */
  mergeSha: string;
  method: "squash" | "merge";
}

/**
 * Merge a change-set in-app (PRD §7.3: "merge in harnesst or on GitHub"). Squash by default so
 * each change-set becomes exactly one commit on the default branch == one Release; falls back
 * to a merge commit if the repo disallows squash. Deletes the working branch on success.
 *
 * Throws a human-readable error when GitHub refuses the merge (conflicts / not mergeable) so
 * the Changes UI can tell the PM why rather than surfacing a raw 405/409.
 */
export async function mergePullRequest(
  installationId: string | number,
  { owner, repo }: RepoRef,
  pullNumber: number,
  branch?: string,
): Promise<MergeResult> {
  const octokit = await getInstallationOctokit(installationId);

  let method: "squash" | "merge" = "squash";
  let merged;
  try {
    merged = await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: method,
    });
  } catch (error) {
    const status = statusOf(error);
    // 405 with squash disabled on the repo — retry as a merge commit.
    if (status === 405) {
      method = "merge";
      try {
        merged = await octokit.rest.pulls.merge({
          owner,
          repo,
          pull_number: pullNumber,
          merge_method: method,
        });
      } catch (retryError) {
        throw mergeError(retryError);
      }
    } else {
      throw mergeError(error);
    }
  }

  // Best-effort branch cleanup; a failure here must not fail the (already-done) merge.
  const head = branch ?? (await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data.head.ref;
  if (head) {
    try {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${head}` });
    } catch {
      // ignore — protected/already-deleted branch
    }
  }

  // A merge lands on the default branch AND closes the PR — drop both source and changes caches.
  invalidateRepoChanges(installationId, { owner, repo });
  invalidateRepoSource(installationId, { owner, repo });
  return { mergeSha: merged.data.sha, method };
}

/** Turn an Octokit merge failure into a PM-readable message. */
function mergeError(error: unknown): Error {
  const status = statusOf(error);
  if (status === 409 || status === 405) {
    return new Error(
      "This change can't be merged automatically — it conflicts with the current default branch. Re-open the change from a fresh edit, or resolve it in GitHub.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** A GitHub error whose 422 is specifically "this plan/repo can't create draft PRs". */
function isDraftUnsupported(error: unknown): boolean {
  if (statusOf(error) !== 422) return false;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error);
  return /draft/i.test(message);
}

/** Whether an open PR opened for this branch is still a draft (extends ProposedChange). */
export interface OpenedPullRequest extends ProposedChange {
  draft: boolean;
}

async function openOrReusePullRequest(
  octokit: InstallationOctokit,
  { owner, repo }: RepoRef,
  {
    base,
    branch,
    title,
    body,
    draft,
  }: { base: string; branch: string; title: string; body?: string; draft?: boolean },
): Promise<OpenedPullRequest> {
  try {
    const created = await octokit.rest.pulls.create({
      owner,
      repo,
      base,
      head: branch,
      title,
      body,
      draft: draft ?? false,
    });
    return {
      branch,
      base,
      pullRequestUrl: created.data.html_url,
      pullRequestNumber: created.data.number,
      reusedPullRequest: false,
      draft: created.data.draft ?? false,
    };
  } catch (error) {
    // Free-plan private repos reject draft PRs with a 422 — retry as a regular PR tagged [WIP].
    if (draft && isDraftUnsupported(error)) {
      return openOrReusePullRequest(octokit, { owner, repo }, {
        base,
        branch,
        title: title.startsWith("[WIP]") ? title : `[WIP] ${title}`,
        body,
        draft: false,
      });
    }
    // 422 == a PR for this head already exists; find and return it.
    if (statusOf(error) !== 422) throw error;
    const existing = await octokit.rest.pulls.list({
      owner,
      repo,
      base,
      head: `${owner}:${branch}`,
      state: "open",
    });
    const pr = existing.data[0];
    if (!pr) throw error;
    return {
      branch,
      base,
      pullRequestUrl: pr.html_url,
      pullRequestNumber: pr.number,
      reusedPullRequest: true,
      draft: pr.draft ?? false,
    };
  }
}

/**
 * Open (or reuse) a PR for a branch, optionally as a DRAFT — the assistant coding-agent sync
 * engine's entry. Thin installation-scoped wrapper over the internal
 * open/reuse logic (which already falls back from an unsupported draft to a `[WIP]` regular PR).
 */
export async function openPullRequest(
  installationId: string | number,
  { owner, repo }: RepoRef,
  input: { base: string; branch: string; title: string; body?: string; draft?: boolean },
): Promise<OpenedPullRequest> {
  const octokit = await getInstallationOctokit(installationId);
  const result = await openOrReusePullRequest(octokit, { owner, repo }, input);
  invalidateRepoChanges(installationId, { owner, repo });
  return result;
}
