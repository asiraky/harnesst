/**
 * Read eve repos through a GitHub App installation.
 *
 * Produces the `AgentSource` the pure parser consumes. We read the default-branch tree once
 * (recursive) and pull the handful of text files the read-only view needs (instructions.md,
 * agent.ts). Nothing here mutates the repo — Connect/visualize is read-only in M0; writes
 * (branch -> PR) come in M1.
 *
 * We also surface the repo-root `harnesst-lock.json` (marketplace install provenance, PRD §7.8) in
 * the tree + eager reads when present: the Deployment tab and the install wizard both need the
 * lock, and folding it into this one cached read spares them a separate ~600ms round trip. It
 * sits OUTSIDE every agent root, so the prefix-based parser (`detectAgentRoots`,
 * `buildAgentConfig`) never sees it — it's carried in `paths`/`files` for lock-aware callers only.
 */
import {
  AGENT_ROOT,
  ASSISTANT_CONFIG_ROOT,
  PLATFORM_ROOT,
  TEAM_ROOT,
  detectAgentRoots,
  subagentModuleFiles,
  type AgentSource,
} from "~/eve/parse";
import { getInstallationOctokit } from "./client.server";

/** Repo-root marketplace install ledger (PRD §7.8) — carried alongside the agent tree. */
const HARNESST_LOCK = "harnesst-lock.json";

export interface InstallationRepo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** Current head commit SHA of a branch (default branch if omitted) — used to cut a Release. */
export async function getBranchHead(
  installationId: string | number,
  { owner, repo, ref }: { owner: string; repo: string; ref?: string },
): Promise<{ sha: string; branch: string }> {
  const octokit = await getInstallationOctokit(installationId);
  const branch =
    ref ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  const res = await octokit.rest.repos.getBranch({ owner, repo, branch });
  return { sha: res.data.commit.sha, branch };
}

/** Repos this installation can access, for the connect picker. */
export async function listInstallationRepos(
  installationId: string | number,
): Promise<InstallationRepo[]> {
  const octokit = await getInstallationOctokit(installationId);
  const repos = await octokit.paginate(
    "GET /installation/repositories",
    { per_page: 100 },
  );
  return repos
    .map((r) => ({
      owner: r.owner.login,
      repo: r.name,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

interface RepoRef {
  owner: string;
  repo: string;
  /** Branch/ref to read; defaults to the repo's default branch. */
  ref?: string;
}

/**
 * Fetch the repo listing (under `agent/` for single-agent repos, `agents/` for teams, plus the
 * `harnesst/` platform root sibling to either) plus known file contents — instructions.md and
 * agent.ts for every detected agent root AND every declared subagent beneath it, at any depth.
 * Returns the ref actually read and whether the git tree was truncated (very large repos), so
 * callers can surface it.
 */
export async function fetchAgentSource(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
): Promise<AgentSource & { ref: string; truncated: boolean }> {
  const octokit = await getInstallationOctokit(installationId);

  const branch =
    ref ??
    (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

  const tree = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: "true",
  });

  const agentPrefix = `${AGENT_ROOT}/`;
  const teamPrefix = `${TEAM_ROOT}/`;
  // The built-in assistant's user-config surface. It is not a roster member
  // (detectAgentRoots ignores it), but the config editors and the assistant's own tools need to
  // see and read these files, so include them in the source tree.
  const assistantPrefix = `${ASSISTANT_CONFIG_ROOT}/`;
  // Repo-root platform code (issue #254). A team member's `agents/<m>/harnesst/**` already rides in
  // under `teamPrefix`, but a SINGLE-agent repo's `harnesst/**` sits beside `agent/` and would
  // otherwise never be read — and the publish hash gate can only verify what it can see, so an
  // out-of-band edit to a platform file would go unnoticed the moment it stopped being a draft.
  // The trailing slash is load-bearing twice over: `harnesst-lock.json` is admitted by name above
  // (not by this prefix), and a root file merely NAMED like the directory is not platform code.
  // Nothing else changes — a platform root is not an agent root (`detectAgentRoots` keys off
  // `agent/`), carries no eagerly-read files, and every path consumer filters by its own prefix.
  const platformPrefix = `${PLATFORM_ROOT}/`;
  const paths = tree.data.tree.flatMap((e) =>
    e.type === "blob" &&
    typeof e.path === "string" &&
    (e.path === AGENT_ROOT ||
      e.path === HARNESST_LOCK ||
      e.path.startsWith(agentPrefix) ||
      e.path.startsWith(teamPrefix) ||
      e.path.startsWith(platformPrefix) ||
      e.path.startsWith(assistantPrefix))
      ? [e.path]
      : [],
  );

  const eager = [
    ...detectAgentRoots(paths).flatMap(({ root }) => [
      `${root}/instructions.md`,
      `${root}/agent.ts`,
      // Every subagent's module + instructions at ANY depth (issue #344): a nested
      // configuration context renders its own description and system prompt out of `files`,
      // and a depth-1-only read left everything below it blank with no error to explain it.
      ...subagentModuleFiles(paths, root),
    ]),
    HARNESST_LOCK,
  ];
  const files: Record<string, string> = {};
  await Promise.all(
    eager.flatMap((path) =>
      paths.includes(path)
        ? [
            readTextFile(octokit, { owner, repo, ref: branch }, path).then((content) => {
              if (content !== null) files[path] = content;
            }),
          ]
        : [],
    ),
  );

  return { paths, files, ref: branch, truncated: Boolean(tree.data.truncated) };
}

type InstallationOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

/** Last-commit metadata for one path (the resource list's "last updated / by" columns). */
export interface LastCommitInfo {
  authorLogin: string | null;
  authorName: string | null;
  date: string | null;
  sha: string;
}

/**
 * Last commit touching each path, for resource list metadata. One commits-API call per
 * path (GitHub has no batch form), run with a small concurrency cap; failures degrade to
 * a missing entry — the list must render fine without metadata (staged-new files have
 * none by definition).
 */
export async function fetchLastCommitForPaths(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
  paths: string[],
): Promise<Record<string, LastCommitInfo>> {
  const octokit = await getInstallationOctokit(installationId);
  const out: Record<string, LastCommitInfo> = {};
  const queue = [...paths];
  const CONCURRENCY = 8;

  async function worker() {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      try {
        const res = await octokit.rest.repos.listCommits({
          owner,
          repo,
          path,
          per_page: 1,
          ...(ref ? { sha: ref } : {}),
        });
        const c = res.data[0];
        if (c) {
          out[path] = {
            authorLogin: c.author?.login ?? null,
            authorName: c.commit.author?.name ?? null,
            date: c.commit.author?.date ?? null,
            sha: c.sha,
          };
        }
      } catch {
        // metadata is best-effort
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

/**
 * Read one text file from the repo (default branch unless `ref` given). Public entry for
 * editors that need a single file's current contents; returns null if missing/binary.
 */
export async function readAgentFile(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
  path: string,
): Promise<string | null> {
  const octokit = await getInstallationOctokit(installationId);
  const branch =
    ref ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  return readTextFile(octokit, { owner, repo, ref: branch }, path);
}

/** The repo-relative paths changed by a commit (e.g. a merge commit), or [] on any error. */
export async function listCommitFiles(
  installationId: string | number,
  { owner, repo }: { owner: string; repo: string },
  sha: string,
): Promise<string[]> {
  try {
    const octokit = await getInstallationOctokit(installationId);
    const res = await octokit.rest.repos.getCommit({ owner, repo, ref: sha });
    return (res.data.files ?? []).map((f) => f.filename).filter(Boolean) as string[];
  } catch {
    return [];
  }
}

/** Read a single text file's contents, or null if missing/binary. */
async function readTextFile(
  octokit: InstallationOctokit,
  { owner, repo, ref }: Required<RepoRef>,
  path: string,
): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return null;
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}
