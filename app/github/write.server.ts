/**
 * Git write layer (Author pillar) — how Eden lands changes in the user's repo.
 *
 * The publish pipeline commits saved drafts straight onto the default branch as one
 * compare-and-swap fast-forward commit (commitToDefaultBranch, issue #225). The eve repo stays
 * the single source of truth — we persist nothing about the change locally.
 *
 * proposeChange (branch + PR) survives ONLY for the structural flows that still want review on
 * GitHub — e.g. member renames — never for publishing saved drafts.
 */
import { invalidateRepoSource } from "./cached.server";
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
 * The base branch moved between our head read and the ref update — someone else pushed while we
 * were committing. The publish pipeline catches this, rebuilds against the new head, and retries
 * exactly once before giving up with a user-facing message.
 */
export class NonFastForwardError extends Error {
  constructor(branch: string) {
    super(`The branch "${branch}" advanced while the commit was being written.`);
    this.name = "NonFastForwardError";
  }
}

/**
 * Commit `files` directly to `branch` (the default branch) as ONE compare-and-swap fast-forward
 * commit: blobs upload concurrently, then a single tree (base_tree = the head commit's tree, with
 * null-content entries as deletions) + commit + `updateRef` WITHOUT force. GitHub rejects a
 * non-fast-forward update with a 422, which surfaces here as `NonFastForwardError` — the CAS
 * failure the caller resolves by rebuilding against the new head and retrying.
 */
export async function commitToDefaultBranch(
  installationId: string | number,
  { owner, repo }: RepoRef,
  input: { branch: string; files: FileChange[]; message: string },
): Promise<{ sha: string }> {
  const octokit = await getInstallationOctokit(installationId);
  const writes = input.files.filter(
    (f): f is FileChange & { content: string } => f.content !== null,
  );
  const deletes = input.files.filter((f) => f.content === null);
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
    octokit.rest.git.getRef({ owner, repo, ref: `heads/${input.branch}` }),
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
    message: input.message,
    tree: tree.data.sha,
    parents: [headSha],
  });
  try {
    // force defaults to false — this IS the compare-and-swap: GitHub only fast-forwards.
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${input.branch}`,
      sha: commit.data.sha,
    });
  } catch (error) {
    if (statusOf(error) === 422) throw new NonFastForwardError(input.branch);
    throw error;
  }
  invalidateRepoSource(installationId, { owner, repo });
  return { sha: commit.data.sha };
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
  return result;
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
interface OpenedPullRequest extends ProposedChange {
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
