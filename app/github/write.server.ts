/**
 * Git write layer (Author pillar) — how harnesst lands changes in the user's repo.
 *
 * The publish pipeline commits saved drafts straight onto the default branch as one
 * compare-and-swap fast-forward commit (commitToDefaultBranch, issue #225). The eve repo stays
 * the single source of truth — we persist nothing about the change locally. harnesst authors no
 * branches and no pull requests; the conversation-checkout mirror (checkout-sync.server.ts) is
 * the only other ref harnesst writes, and it is an internal durability mechanism.
 */
import { invalidateRepoSource } from "./cached.server";
import { getInstallationOctokit } from "./client.server";

export interface FileChange {
  /** Repo-relative path, forward-slashed (e.g. "agent/instructions.md"). */
  path: string;
  /** New UTF-8 file contents; null deletes the file (e.g. removing a team member). */
  content: string | null;
}

interface RepoRef {
  owner: string;
  repo: string;
}

/** HTTP status of an Octokit request error, if present. */
function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

/** Human message of an Octokit request error (the GitHub API's own words), if present. */
function messageOf(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error);
}

type InstallationOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

/**
 * Commit `files` to `branch` as ONE commit via the Git Data API: blobs upload concurrently
 * (independent), then a single tree + commit + ref update. Used by repo scaffolding (a brand-new
 * repo's skeleton commit — see create.server.ts); publishes go through `commitToDefaultBranch`,
 * which adds the compare-and-swap contract. A null-content entry deletes that path.
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
 * The base branch moved between the head the build was based on and the ref update — someone
 * else pushed while we were publishing. The publish pipeline catches this, rebuilds against the
 * new head, and retries exactly once before giving up with a user-facing message.
 */
export class NonFastForwardError extends Error {
  constructor(branch: string) {
    super(`The branch "${branch}" advanced while the commit was being written.`);
    this.name = "NonFastForwardError";
  }
}

/** The current head sha of `branch` — captured before a publish build so the commit can CAS on it. */
export async function getBranchHead(
  installationId: string | number,
  { owner, repo }: RepoRef,
  branch: string,
): Promise<string> {
  const octokit = await getInstallationOctokit(installationId);
  const head = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  return head.data.object.sha;
}

/**
 * Commit `files` directly to `branch` (the default branch) as ONE compare-and-swap fast-forward
 * commit: blobs upload concurrently, then a single tree (base_tree = `expectedHeadSha`'s tree,
 * with null-content entries as deletions) + commit parented on `expectedHeadSha` + `updateRef`
 * WITHOUT force.
 *
 * `expectedHeadSha` is the head the caller's build was based on — parenting on it (rather than
 * re-reading the head here) means an external push ANYWHERE in the build→commit window makes the
 * ref update non-fast-forward, so nothing that wasn't build-checked can land. GitHub rejects that
 * update with a 422, which surfaces as `NonFastForwardError` — the CAS failure the caller
 * resolves by rebuilding against the new head and retrying.
 */
export async function commitToDefaultBranch(
  installationId: string | number,
  { owner, repo }: RepoRef,
  input: { branch: string; expectedHeadSha: string; files: FileChange[]; message: string },
): Promise<{ sha: string }> {
  const octokit = await getInstallationOctokit(installationId);
  const writes = input.files.filter(
    (f): f is FileChange & { content: string } => f.content !== null,
  );
  let deletes = input.files.filter((f) => f.content === null);
  const [blobs, headCommit] = await Promise.all([
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
    octokit.rest.git.getCommit({ owner, repo, commit_sha: input.expectedHeadSha }),
  ]);
  if (deletes.length > 0) {
    // The Git Data API 422s on a tree entry that deletes a path absent from base_tree, so a
    // deletion staged for a file an external push already removed would block the whole publish
    // with a raw GitHub error. Filter to paths that actually exist at the base; a truncated
    // (giant-repo) listing degrades to sending everything, exactly as before.
    const headTree = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: headCommit.data.tree.sha,
      recursive: "1",
    });
    if (!headTree.data.truncated) {
      const present = new Set(headTree.data.tree.map((e) => e.path));
      deletes = deletes.filter((f) => present.has(f.path));
    }
  }
  // Everything already true at the base (only already-gone deletions): nothing to commit.
  if (writes.length === 0 && deletes.length === 0) {
    return { sha: input.expectedHeadSha };
  }
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
    parents: [input.expectedHeadSha],
  });
  try {
    // force defaults to false — this IS the compare-and-swap: GitHub only fast-forwards, and
    // the commit's parent is the build's base, so any head move since the build rejects here.
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${input.branch}`,
      sha: commit.data.sha,
    });
  } catch (error) {
    // Only a genuine non-fast-forward is the CAS miss the pipeline retries. Every other 422
    // (a protected branch above all — "Changes must be made through a pull request") can never
    // succeed on retry, so surface GitHub's own message instead of a misleading race error.
    if (statusOf(error) === 422 && /fast.forward/i.test(messageOf(error))) {
      throw new NonFastForwardError(input.branch);
    }
    throw error;
  }
  invalidateRepoSource(installationId, { owner, repo });
  return { sha: commit.data.sha };
}
