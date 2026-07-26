/**
 * Create a new eve repo and scaffold it (Connect pillar — the "create new" path, PRD §7.1).
 *
 * This is harnesst's headless equivalent of `eve init`: create the repo via the GitHub App, then
 * commit an eve skeleton directly to the default branch. Two layouts (PRD §7.9):
 *  - **single** — one agent at the repo root (`agent/`), today's default.
 *  - **team**   — an initially empty monorepo marked by `agents/README.md`.
 *
 * (The PRD flags "eve init headless" as a spike — we scaffold a faithful minimal skeleton
 * rather than shelling the interactive TUI; swap to a real `eve init` invocation once the
 * deploy controller has a build environment.)
 *
 * GitHub Apps create repos under an **organization** installation (`repos.createInOrg`).
 * Personal-account creation isn't available via an installation token, so that path returns a
 * clear error pointing the user at "connect an existing repo".
 */
import {
  AI_PACKAGE,
  AI_VERSION,
  ANTHROPIC_PROVIDER_PACKAGE,
  ANTHROPIC_PROVIDER_VERSION,
  OPENAI_PROVIDER_PACKAGE,
  OPENAI_PROVIDER_VERSION,
  OPENROUTER_PROVIDER_PACKAGE,
  OPENROUTER_PROVIDER_VERSION,
  ZOD_PACKAGE,
  ZOD_VERSION,
} from "~/eve/agentModule";
import {
  orgModelModulePath,
  orgModelModuleSource,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";
import { DEFAULT_SANDBOX_MODULE, sandboxPath } from "~/eve/templates";
import { commitFiles, type FileChange } from "./write.server";
import { getInstallationOctokit } from "./client.server";
import { EMPTY_TEAM_MARKER } from "~/eve/parse";

export type RepoLayout = "single" | "team";

export interface CreateRepoInput {
  owner: string;
  name: string;
  private?: boolean;
  description?: string;
  /** Repo layout: one agent at the root, or a team monorepo. Defaults to "single". */
  layout?: RepoLayout;
  /**
   * The single agent's display name. Ignored for team repositories.
   */
  agentName?: string;
}

export interface CreatedRepo {
  owner: string;
  repo: string;
  defaultBranch: string;
  htmlUrl: string;
}

const GITIGNORE =
  ".eve/\n.output/\n.workflow-data/\nnode_modules/\n.env\n.env.*\n";

/** Dependencies required by the provider router in the generated `harnesst-model.ts`. */
function modelProviderDependencies(): Record<string, string> {
  return {
    [ANTHROPIC_PROVIDER_PACKAGE]: ANTHROPIC_PROVIDER_VERSION,
    [OPENAI_PROVIDER_PACKAGE]: OPENAI_PROVIDER_VERSION,
    [OPENROUTER_PROVIDER_PACKAGE]: OPENROUTER_PROVIDER_VERSION,
    [AI_PACKAGE]: AI_VERSION,
    [ZOD_PACKAGE]: ZOD_VERSION,
    eve: "latest",
  };
}

/**
 * The files every eve agent directory starts with, under `root` (e.g. "agent"). No model is
 * baked anywhere: `agent.ts` resolves through the generated `harnesst-model.ts`, so the agent runs
 * the workspace's configured model from day one (an explicit per-agent override wins when set,
 * and a workspace with nothing configured gets a readable "set a model in Org settings" error).
 */
function agentDirFiles(root: string, displayName: string): FileChange[] {
  return [
    {
      path: `${root}/instructions.md`,
      content: `# ${displayName}\n\nYou are a helpful agent. Describe the agent's role, tone, and\nboundaries here — this Markdown is the always-on system prompt.\n`,
    },
    {
      path: `${root}/agent.ts`,
      content: scaffoldOrgModelAgentModule(displayName),
    },
    { path: orgModelModulePath(root), content: orgModelModuleSource() },
    // The harnesst default sandbox: identical to eve's framework default until a secret is
    // exposed (the HARNESST_SANDBOX_ENV convention — see ~/eve/templates), but present from day
    // one so "make X available in my sandbox" is an edit, not a new concept.
    { path: sandboxPath(root), content: DEFAULT_SANDBOX_MODULE },
  ];
}

function packageJson(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, null, 2) + "\n";
}

/** A fresh single-agent eve skeleton: `agent/` at the repo root. */
function singleAgentFiles(name: string, agentName: string): FileChange[] {
  return [
    ...agentDirFiles("agent", agentName),
    {
      path: "package.json",
      content: packageJson({
        name,
        private: true,
        type: "module",
        scripts: { dev: "eve dev", build: "eve build" },
        dependencies: modelProviderDependencies(),
      }),
    },
    {
      path: "README.md",
      content: `# ${name}\n\nAn [eve](https://github.com/vercel/eve) agent scaffolded by harnesst. The agent\nlives under \`agent/\`. Edit it here or in harnesst.\n`,
    },
    { path: ".gitignore", content: GITIGNORE },
  ];
}

/**
 * The files for ONE team member: a complete eve project under `agents/<member>/`. Used by
 * the team scaffold and by the add-member flow (which lands them as a change-set).
 */
export function memberScaffold(member: string): FileChange[] {
  const memberDir = `agents/${member}`;
  return [
    ...agentDirFiles(`${memberDir}/agent`, member),
    {
      path: `${memberDir}/package.json`,
      content: packageJson({
        name: member,
        private: true,
        type: "module",
        scripts: { dev: "eve dev", build: "eve build" },
        dependencies: modelProviderDependencies(),
      }),
    },
  ];
}

/**
 * A fresh team monorepo skeleton (PRD §7.9): npm workspaces, each member a complete eve
 * project under `agents/<member>/`, detected by convention. `harnesst.json` is metadata only.
 */
export function teamFiles(name: string): FileChange[] {
  return [
    {
      path: EMPTY_TEAM_MARKER,
      content:
        "# Agents\n\nAdd each agent under `agents/<name>/` as a complete eve project.\n",
    },
    {
      path: "package.json",
      content: packageJson({
        name,
        private: true,
        type: "module",
        workspaces: ["agents/*", "packages/*"],
      }),
    },
    {
      path: "harnesst.json",
      content: packageJson({ name }),
    },
    {
      path: "README.md",
      content: `# ${name}\n\nA team of [eve](https://github.com/vercel/eve) agents scaffolded by harnesst.\nEach member is a complete eve project under \`agents/<member>/\` — add a member by\nadding a directory with its own \`agent/\` and \`package.json\`. harnesst detects the roster\nby convention; \`harnesst.json\` holds team metadata only.\n`,
    },
    { path: ".gitignore", content: GITIGNORE },
  ];
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

/**
 * Wait until the auto-init commit exists on the default branch. GitHub creates a repo's
 * initial commit asynchronously, so reading `heads/<branch>` immediately after
 * `repos.createInOrg` regularly 404s/409s — the bug that made "Create & scaffold" fail.
 */
async function waitForBranch(
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>,
  { owner, repo }: { owner: string; repo: string },
  branch: string,
): Promise<void> {
  let delay = 250;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      return;
    } catch (error) {
      const status = statusOf(error);
      // 404 = ref not there yet; 409 = "Git Repository is empty" — both mean keep waiting.
      if (status !== 404 && status !== 409) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2_000);
  }
  throw new Error(
    `GitHub hasn't finished initializing ${owner}/${repo} — the repo was created, but its ` +
      `default branch never appeared. Try connecting it as an existing repo in a moment.`,
  );
}

/** Create the org repo (auto-initialized) and commit the eve skeleton to its default branch. */
export async function createEveRepo(
  installationId: string | number,
  input: CreateRepoInput,
): Promise<CreatedRepo> {
  const octokit = await getInstallationOctokit(installationId);
  const layout = input.layout ?? "single";

  let created;
  try {
    created = await octokit.rest.repos.createInOrg({
      org: input.owner,
      name: input.name,
      private: input.private ?? true,
      auto_init: true,
      description:
        input.description ??
        (layout === "team"
          ? "A team of eve agents, built with harnesst."
          : "An eve agent, built with harnesst."),
    });
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) {
      throw new Error(
        `Couldn't create a repo under "${input.owner}". The GitHub App can only create ` +
          `repos in an organization it's installed on. To use a personal account, create the ` +
          `repo on GitHub first, then connect it.`,
      );
    }
    // 403 "Resource not accessible by integration" == the app lacks the Administration
    // repository permission (the one that gates repo creation), or the org hasn't approved
    // a recent permission change on the installation.
    if (status === 403) {
      throw new Error(
        `The GitHub App isn't allowed to create repositories in "${input.owner}". Grant it ` +
          `the "Administration: Read and write" repository permission (App settings → ` +
          `Permissions & events), then approve the permission request on the organization's ` +
          `installation (org Settings → GitHub Apps). Alternatively, create the repo on ` +
          `GitHub yourself and connect it as an existing repo.`,
      );
    }
    if (status === 422) {
      throw new Error(
        `Couldn't create "${input.owner}/${input.name}" — a repository with that name ` +
          `probably already exists. Pick another name, or connect the existing repo instead.`,
      );
    }
    throw error;
  }

  const repo = created.data;
  const branch = repo.default_branch;

  // The auto-init commit lands asynchronously — wait for the branch before committing onto it.
  await waitForBranch(
    octokit,
    { owner: input.owner, repo: input.name },
    branch,
  );

  // Commit the skeleton directly to the default branch — a brand-new repo needs no PR.
  // One commit for the whole scaffold via the Git Data API (blobs upload in parallel).
  const files =
    layout === "team"
      ? teamFiles(input.name)
      : singleAgentFiles(input.name, input.agentName || input.name);
  await commitFiles(
    octokit,
    { owner: input.owner, repo: input.name },
    branch,
    files,
    layout === "team"
      ? "chore: scaffold eve agent team"
      : "chore: scaffold eve agent",
  );

  return {
    owner: input.owner,
    repo: input.name,
    defaultBranch: branch,
    htmlUrl: repo.html_url,
  };
}
