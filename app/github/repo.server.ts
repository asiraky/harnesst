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
  TEAM_ROOT,
  detectAgentRoots,
  subagentDirNames,
  type AgentSource,
} from "~/eve/parse";
import {
  LEGACY_ROOT_FILES,
  LEGACY_SOURCE_PREFIXES,
} from "~/eve/legacy-names";
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
 * Fetch the repo listing (under `agent/` for single-agent repos, `agents/` for teams) plus
 * known file contents — instructions.md and agent.ts for every detected agent root. Returns
 * the ref actually read and whether the git tree was truncated (very large repos), so
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
  // Pre-#213-rename repos (issue #235) keep the same files under their old names — the lock at
  // `eden-lock.json`, the assistant config under `.eden/assistant/`. They are included here so the
  // drift scan can SEE them; every other reader keys off the current names and ignores them.
  const paths = tree.data.tree.flatMap((e) => {
    if (e.type !== "blob" || typeof e.path !== "string") return [];
    const path = e.path;
    const wanted =
      path === AGENT_ROOT ||
      path === HARNESST_LOCK ||
      LEGACY_ROOT_FILES.includes(path) ||
      path.startsWith(agentPrefix) ||
      path.startsWith(teamPrefix) ||
      path.startsWith(assistantPrefix) ||
      LEGACY_SOURCE_PREFIXES.some((prefix) => path.startsWith(prefix));
    return wanted ? [path] : [];
  });

  const eager = [
    ...detectAgentRoots(paths).flatMap(({ root }) => [
      `${root}/instructions.md`,
      `${root}/agent.ts`,
      ...subagentDirNames(paths, root).flatMap((name) => [
        `${root}/subagents/${name}/agent.ts`,
        `${root}/subagents/${name}/instructions.md`,
      ]),
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

/**
 * Read many text files at once, concurrency-capped like `fetchLastCommitForPaths` (GitHub has no
 * batch content API). Missing/binary paths are simply absent from the result rather than throwing —
 * a scan over a repo listing races real deletions, and one unreadable blob must not sink the batch.
 */
export async function readAgentFiles(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
  paths: string[],
): Promise<Record<string, string>> {
  const octokit = await getInstallationOctokit(installationId);
  const branch =
    ref ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  const out: Record<string, string> = {};
  const queue = [...paths];
  const CONCURRENCY = 8;

  async function worker() {
    for (let path = queue.shift(); path; path = queue.shift()) {
      const content = await readTextFile(
        octokit,
        { owner, repo, ref: branch },
        path,
      );
      if (content !== null) out[path] = content;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
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
