/**
 * HEAD deploys and version moves — the two deploy paths that don't go through the publish
 * pipeline (that lives in app/publish/pipeline.server.ts).
 *
 * The TEAM is the deployment unit: a deploy always moves the WHOLE roster into one environment,
 * never a subset. Cross-agent coupling makes partial deploys unsafe — the ask-a-teammate tool
 * references sibling names/coordinates, renames ripple across members, and shared files rebuild
 * everyone — so "which agent" is never a question a user answers; only "which environment" is.
 *
 * shipRepoHead is the nothing-saved counterpart to Publish: an already-ready repo must deploy in
 * one click without first saving an edit. It reads the connected default branch's HEAD, cuts
 * Releases at that commit (the same idempotent per-member path the pipeline and the GitHub
 * webhook use), and deploys the WHOLE team. The deploy-time image build surfaces any failure on
 * the deployment rows, exactly like any deploy.
 *
 * deployTeamVersion is the version-history counterpart: move the whole team to an existing
 * version (by git sha) in an environment — the rollback/redeploy path, direction-neutral.
 *
 * Everything is deps-injectable so unit tests run with zero I/O.
 */
import type { Agent, DataStore, Release } from "~/data/ports";
import { getBranchHead } from "~/github/repo.server";
import { getRuntime } from "~/seams/index.server";
import { ensureReleasesForCommit, queueDeploy } from "./controller.server";

export interface ShipProject {
  id: string;
  repoInstallationId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
}

export interface ShipResult {
  /** Version label of the deployed release (first member's — labels can differ per member). */
  version: string;
  /** The deployed commit — the version identity shared by every member's release (D9). */
  gitSha: string;
  envName: string;
  /** One entry per member whose environment got a queued deploy. */
  deployed: { agentName: string; environmentId: string; deploymentId: string }[];
  /**
   * Defensive drift surface: members with NO environment named `envName`. Environments are now
   * team-level — every member has a row of every name — so this is EXPECTED EMPTY. It survives
   * only to make a broken invariant (a member missing an env row) visible instead of silent.
   */
  skipped: { agentName: string }[];
}

export type BranchHeadFn = typeof getBranchHead;

export interface ShipDeps {
  store?: DataStore;
  /** Reads the connected branch's HEAD sha for the nothing-saved deploy (shipRepoHead). */
  branchHead?: BranchHeadFn;
}

/**
 * Deploy the connected repo's HEAD to `envName` with nothing saved: read the default branch's
 * HEAD → cut Releases at that commit (one per member) → queue deploys for the WHOLE team. The
 * only failure surface is the async image build on the deployment rows (same as any deploy).
 *
 * `ensureReleasesForCommit` is idempotent per (agent, gitSha), so publishing HEAD twice at the
 * same commit reuses the existing releases and just redeploys them — the intended behavior.
 */
export async function shipRepoHead(
  input: {
    project: ShipProject;
    envName: string;
    createdBy?: string | null;
  },
  deps: ShipDeps = {},
): Promise<ShipResult> {
  const store = deps.store ?? getRuntime().data;
  const branchHead = deps.branchHead ?? getBranchHead;
  const { project, envName } = input;

  const { sha, branch } = await branchHead(project.repoInstallationId, {
    owner: project.repoOwner,
    repo: project.repoName,
    ref: project.defaultBranch,
  });

  const releases = await ensureReleasesForCommit(
    {
      projectId: project.id,
      gitSha: sha,
      changelog: `Deployed ${branch} @ ${sha.slice(0, 7)} from HEAD`,
      createdBy: input.createdBy,
    },
    store,
  );

  // Targets = the WHOLE member roster, always (the team is the deployment unit).
  const roster = (await store.agents.listByProject(project.id)).filter(
    (a) => a.kind === "member",
  );
  return deployToMembers({
    store,
    targets: roster,
    releases: releases.map((r) => r.release),
    gitSha: sha,
    envName,
    createdBy: input.createdBy,
  });
}

/**
 * Move the WHOLE team to an existing version (identified by its git sha) in one environment —
 * the version-history deploy/rollback/redeploy path. For each member that has a release at
 * `gitSha` and an env row named `envName`, queue a deploy of that release. Direction-neutral:
 * deploying an older version IS the rollback. Throws if nothing was deployed (bad sha/env).
 */
export async function deployTeamVersion(
  input: {
    project?: { id: string };
    projectId?: string;
    gitSha: string;
    envName: string;
    rollback?: boolean;
    rebuild?: boolean;
    createdBy?: string | null;
  },
  deps: ShipDeps = {},
): Promise<Pick<ShipResult, "deployed" | "skipped">> {
  const store = deps.store ?? getRuntime().data;
  const projectId = input.projectId ?? input.project?.id;
  if (!projectId) throw new Error("A project is required to deploy a version.");
  const { gitSha, envName } = input;

  const roster = (await store.agents.listByProject(projectId)).filter(
    (a) => a.kind === "member",
  );
  const deployed: ShipResult["deployed"] = [];
  const skipped: ShipResult["skipped"] = [];
  for (const agent of roster) {
    const release = await store.releases.findByCommit(agent.id, gitSha);
    if (!release) {
      skipped.push({ agentName: agent.name });
      continue;
    }
    const envs = await store.environments.listByAgent(agent.id);
    const env = envs.find((e) => e.name === envName);
    if (!env) {
      skipped.push({ agentName: agent.name });
      continue;
    }
    const dep = await queueDeploy(
      {
        environmentId: env.id,
        releaseId: release.id,
        rollback: input.rollback,
        rebuild: input.rebuild,
        createdBy: input.createdBy,
      },
      store,
    );
    deployed.push({ agentName: agent.name, environmentId: env.id, deploymentId: dep.id });
  }
  if (deployed.length === 0) {
    throw new Error(
      `Nothing to deploy: no member has version ${gitSha.slice(0, 7)} in "${envName}".`,
    );
  }
  return { deployed, skipped };
}

/** Queue one deploy per target member into its environment named `envName` (if it has one). */
async function deployToMembers(input: {
  store: DataStore;
  targets: Agent[];
  releases: Release[];
  gitSha: string;
  envName: string;
  createdBy?: string | null;
}): Promise<ShipResult> {
  const { store, envName } = input;
  const deployed: ShipResult["deployed"] = [];
  const skipped: ShipResult["skipped"] = [];
  for (const agent of input.targets) {
    const release = input.releases.find((r) => r.agentId === agent.id);
    if (!release) continue;
    const envs = await store.environments.listByAgent(agent.id);
    const env = envs.find((e) => e.name === envName);
    if (!env) {
      skipped.push({ agentName: agent.name });
      continue;
    }
    const dep = await queueDeploy(
      { environmentId: env.id, releaseId: release.id, createdBy: input.createdBy },
      store,
    );
    deployed.push({ agentName: agent.name, environmentId: env.id, deploymentId: dep.id });
  }
  if (deployed.length === 0) {
    throw new Error(`No "${envName}" environment found to deploy into.`);
  }
  return {
    version: input.releases[0]?.version ?? "",
    gitSha: input.gitSha,
    envName,
    deployed,
    skipped,
  };
}
