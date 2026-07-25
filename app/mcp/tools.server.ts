import type {
  Agent,
  DataStore,
  DeploymentWithRelease,
  Environment,
  Project,
  Release,
} from "~/data/ports";
import {
  discardDrafts as discardDraftsDirect,
  publishDrafts as publishDraftsDirect,
  stageDraft as stageDraftDirect,
} from "~/drafts/drafts.server";
import {
  getProject as getProjectForOrg,
  listProjects as listProjectsForOrg,
} from "~/db/queries.server";
import {
  clearFailedDeployments,
  queueDeploy,
} from "~/deploy/controller.server";
import {
  deployTeamVersion as deployTeamVersionDirect,
  shipRepoHead as shipRepoHeadDirect,
  type ShipResult,
} from "~/deploy/ship.server";
import { getBranchHead as getBranchHeadDirect } from "~/github/repo.server";
import {
  listOpenChanges as listOpenChangesDirect,
  mergePullRequest as mergePullRequestDirect,
} from "~/github/write.server";
import { normalizeAgentPath } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";

export type McpScope = "read" | "deploy" | "author";

export interface McpIdentity {
  keyId: string;
  orgId: string;
  userId: string;
  scopes: McpScope[];
}

type DeployTeamVersionResult = Pick<ShipResult, "deployed" | "skipped">;

export interface McpToolDeps {
  store: DataStore;
  stageDraft: typeof stageDraftDirect;
  publishDrafts: typeof publishDraftsDirect;
  listOpenChanges: typeof listOpenChangesDirect;
  mergePullRequest: typeof mergePullRequestDirect;
  discardDrafts: typeof discardDraftsDirect;
  getBranchHead: typeof getBranchHeadDirect;
  deployTeamVersion(input: {
    projectId: string;
    gitSha: string;
    envName: string;
    rollback: boolean;
    rebuild: boolean;
    createdBy: string;
  }): Promise<DeployTeamVersionResult>;
  shipRepoHead(input: {
    project: {
      id: string;
      repoInstallationId: string;
      repoOwner: string;
      repoName: string;
      defaultBranch: string;
    };
    envName: string;
    createdBy: string;
  }): Promise<ShipResult>;
  queueDeploy(input: {
    environmentId: string;
    releaseId: string;
    rollback: boolean;
    createdBy: string;
  }): Promise<{ id: string; status: string }>;
  clearFailedDeployments(environmentId: string): Promise<void>;
}

export interface McpToolService {
  listProjects(): Promise<Record<string, unknown>>;
  listAgents(input: { projectId: string }): Promise<Record<string, unknown>>;
  listReleases(input: {
    projectId: string;
    agentId?: string;
  }): Promise<Record<string, unknown>>;
  listEnvironments(input: {
    projectId: string;
    agentId?: string;
  }): Promise<Record<string, unknown>>;
  getDeployStatus(input: {
    deploymentId: string;
  }): Promise<Record<string, unknown>>;
  deployTeamVersion(input: {
    projectId: string;
    gitSha: string;
    environment: string;
    rebuild?: boolean;
  }): Promise<Record<string, unknown>>;
  deployHead(input: {
    projectId: string;
    environment: string;
  }): Promise<Record<string, unknown>>;
  retryDeployment(input: {
    deploymentId: string;
  }): Promise<Record<string, unknown>>;
  clearFailed(input: {
    environmentId: string;
  }): Promise<Record<string, unknown>>;
  stageChanges(input: {
    projectId: string;
    edits: Array<{
      path: string;
      content: string | null;
      baseSha?: string | null;
    }>;
  }): Promise<Record<string, unknown>>;
  publishChanges(input: {
    projectId: string;
    paths: string[];
    title?: string;
  }): Promise<Record<string, unknown>>;
  listOpenChanges(input: {
    projectId: string;
    limit?: number;
  }): Promise<Record<string, unknown>>;
  mergeChange(input: {
    projectId: string;
    pullRequestNumber: number;
  }): Promise<Record<string, unknown>>;
  discardChanges(input: {
    projectId: string;
    paths: string[];
  }): Promise<Record<string, unknown>>;
}

/** A stable, credential-safe error intended to be returned through MCP. */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly code:
      | "forbidden"
      | "not_found"
      | "invalid_input"
      | "invalid_state"
      | "already_deploying",
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

function hasInflight(deployments: DeploymentWithRelease[]): boolean {
  return deployments.some(
    (deployment) =>
      deployment.status === "pending" || deployment.status === "building",
  );
}

/** Drizzle wraps driver errors; walk the cause chain to keep the race-safe DB guard useful. */
export function isInflightDeploymentCollision(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    const pg = current as Error & { code?: string; constraint_name?: string };
    if (
      pg.code === "23505" &&
      pg.constraint_name === "deployments_env_inflight_uq"
    ) {
      return true;
    }
  }
  return false;
}

function alreadyDeploying(): never {
  throw new McpToolError(
    "A deployment is already pending or building for this environment. Poll its deployment id before trying again.",
    "already_deploying",
  );
}

function deploymentFailed(): never {
  throw new McpToolError(
    "The deployment could not be queued. Check the project, version, and environment, then try again.",
    "invalid_state",
  );
}

function requireDeploy(identity: McpIdentity): void {
  if (!identity.scopes.includes("deploy")) {
    throw new McpToolError(
      "This API key does not have the deploy scope.",
      "forbidden",
    );
  }
}

function requireAuthor(identity: McpIdentity): void {
  if (!identity.scopes.includes("author")) {
    throw new McpToolError(
      "This API key does not have the author scope.",
      "forbidden",
    );
  }
}

function normalizePathBatch(paths: string[]): string[] {
  if (paths.length === 0) {
    throw new McpToolError("At least one path is required.", "invalid_input");
  }
  const normalized = paths.map((path) => normalizeAgentPath(path));
  if (normalized.some((path) => path === null)) {
    throw new McpToolError(
      "Every path must be within harnesst's editable agent surface.",
      "invalid_input",
    );
  }
  const valid = normalized as string[];
  if (new Set(valid).size !== valid.length) {
    throw new McpToolError(
      "Duplicate paths are not allowed in one operation.",
      "invalid_input",
    );
  }
  return valid;
}

function projectRepo(project: Project) {
  if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
    throw new McpToolError(
      "This project does not have a connected GitHub repository.",
      "invalid_state",
    );
  }
  return {
    id: project.id,
    repoInstallationId: project.repoInstallationId,
    repoOwner: project.repoOwner,
    repoName: project.repoName,
    defaultBranch: project.defaultBranch,
  };
}

export function createMcpToolService(
  identity: McpIdentity,
  overrides: Partial<McpToolDeps> = {},
): McpToolService {
  const store = overrides.store ?? getRuntime().data;
  const deps: McpToolDeps = {
    store,
    stageDraft:
      overrides.stageDraft ?? ((input) => stageDraftDirect(input, store)),
    publishDrafts:
      overrides.publishDrafts ?? ((input) => publishDraftsDirect(input, store)),
    listOpenChanges: overrides.listOpenChanges ?? listOpenChangesDirect,
    mergePullRequest: overrides.mergePullRequest ?? mergePullRequestDirect,
    discardDrafts:
      overrides.discardDrafts ??
      ((projectId, paths) => discardDraftsDirect(projectId, paths, store)),
    getBranchHead: overrides.getBranchHead ?? getBranchHeadDirect,
    deployTeamVersion:
      overrides.deployTeamVersion ??
      ((input) => deployTeamVersionDirect(input, { store })),
    shipRepoHead:
      overrides.shipRepoHead ??
      ((input) => shipRepoHeadDirect(input, { store })),
    queueDeploy:
      overrides.queueDeploy ?? ((input) => queueDeploy(input, store)),
    clearFailedDeployments:
      overrides.clearFailedDeployments ??
      ((environmentId) => clearFailedDeployments(environmentId, store)),
  };

  async function authorizeProject(projectId: string): Promise<Project> {
    const project = await getProjectForOrg(identity.orgId, projectId, store);
    if (!project) {
      throw new McpToolError("Project not found.", "not_found");
    }
    return project;
  }

  async function authorizeEnvironment(environmentId: string): Promise<{
    environment: Environment;
    project: Project;
    agent: Agent;
  }> {
    const environment = await store.environments.findById(environmentId);
    if (!environment) {
      throw new McpToolError("Environment not found.", "not_found");
    }
    const project = await authorizeProject(environment.projectId);
    const agent = await store.agents.findById(environment.agentId);
    if (!agent || agent.projectId !== project.id) {
      throw new McpToolError("Environment not found.", "not_found");
    }
    return { environment, project, agent };
  }

  async function audit(
    tool: string,
    target: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await store.audit.record({
      orgId: identity.orgId,
      actorUserId: identity.userId,
      action: `mcp.${tool}`,
      target,
      meta: { keyId: identity.keyId, tool, ...meta },
    });
  }

  async function targetEnvironments(
    projectId: string,
    environmentName: string,
    gitSha?: string,
  ): Promise<Environment[]> {
    let agents = (await store.agents.listByProject(projectId)).filter(
      (agent) => agent.kind === "member",
    );
    if (gitSha) {
      const releases = await Promise.all(
        agents.map((agent) => store.releases.findByCommit(agent.id, gitSha)),
      );
      agents = agents.filter((_agent, index) => releases[index] !== null);
    }
    const nested = await Promise.all(
      agents.map((agent) => store.environments.listByAgent(agent.id)),
    );
    return nested
      .flat()
      .filter((environment) => environment.name === environmentName);
  }

  async function assertNoInflight(environments: Environment[]): Promise<void> {
    const rows = await Promise.all(
      environments.map((environment) =>
        store.deployments.listByEnvironment(environment.id),
      ),
    );
    if (rows.some(hasInflight)) alreadyDeploying();
  }

  return {
    async listProjects() {
      const projects = await listProjectsForOrg(identity.orgId, store);
      return {
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          layout: project.layout,
          repoOwner: project.repoOwner,
          repoName: project.repoName,
          defaultBranch: project.defaultBranch,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
        })),
      };
    },

    async listAgents({ projectId }) {
      await authorizeProject(projectId);
      const agents = (await store.agents.listByProject(projectId)).filter(
        (agent) => agent.kind === "member",
      );
      return {
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          root: agent.root,
          pendingName: agent.pendingName,
          createdAt: agent.createdAt.toISOString(),
          updatedAt: agent.updatedAt.toISOString(),
        })),
      };
    },

    async listReleases({ projectId, agentId }) {
      await authorizeProject(projectId);
      if (agentId) {
        const agent = await store.agents.findById(agentId);
        if (
          !agent ||
          agent.projectId !== projectId ||
          agent.kind !== "member"
        ) {
          throw new McpToolError("Agent not found.", "not_found");
        }
      }
      const releases = (await store.releases.listByProject(projectId)).filter(
        (release) => !agentId || release.agentId === agentId,
      );
      return {
        releases: releases.map(releaseSummary),
      };
    },

    async listEnvironments({ projectId, agentId }) {
      await authorizeProject(projectId);
      const agents = (await store.agents.listByProject(projectId)).filter(
        (agent) =>
          agent.kind === "member" && (!agentId || agent.id === agentId),
      );
      if (agentId && agents.length === 0) {
        throw new McpToolError("Agent not found.", "not_found");
      }
      const rows = await Promise.all(
        agents.map(async (agent) => ({
          agent,
          environments: await store.environments.listByAgent(agent.id),
        })),
      );
      return {
        environments: rows.flatMap(({ agent, environments }) =>
          environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            projectId: environment.projectId,
            agent: { id: agent.id, name: agent.name },
            createdAt: environment.createdAt.toISOString(),
          })),
        ),
      };
    },

    async getDeployStatus({ deploymentId }) {
      const requested = await store.deployments.findById(deploymentId);
      if (!requested) {
        throw new McpToolError("Deployment not found.", "not_found");
      }
      const { environment, project, agent } = await authorizeEnvironment(
        requested.environmentId,
      );
      const release = await store.releases.findById(requested.releaseId);
      if (
        !release ||
        release.projectId !== project.id ||
        release.agentId !== agent.id
      ) {
        throw new McpToolError("Deployment not found.", "not_found");
      }

      const environmentDeployments = await store.deployments.listByEnvironment(
        environment.id,
      );
      const live = environmentDeployments.find(
        (deployment) => deployment.status === "live",
      );
      const latestRelease = (
        await store.releases.listByProject(project.id)
      ).find((candidate) => candidate.agentId === agent.id);
      let headSha: string | null = null;
      let headError: string | null = null;
      if (project.repoInstallationId && project.repoOwner && project.repoName) {
        try {
          headSha = (
            await deps.getBranchHead(project.repoInstallationId, {
              owner: project.repoOwner,
              repo: project.repoName,
              ref: project.defaultBranch,
            })
          ).sha;
        } catch {
          headError = "Unable to read the connected repository's branch HEAD.";
        }
      } else {
        headError = "This project does not have a connected GitHub repository.";
      }

      const latestReleaseSha = latestRelease?.gitSha ?? null;
      const deployedSha = live?.gitSha ?? null;
      return {
        deployment: {
          id: requested.id,
          status: requested.status,
          url: requested.url,
          errorDetail: requested.errorDetail,
          release: releaseSummary(release),
          createdAt: requested.createdAt.toISOString(),
          updatedAt: requested.updatedAt.toISOString(),
        },
        environment: { id: environment.id, name: environment.name },
        agent: { id: agent.id, name: agent.name },
        deployedSha,
        latestReleaseSha,
        headSha,
        hasUnreleasedChanges:
          headSha === null || latestReleaseSha === null
            ? null
            : headSha !== latestReleaseSha,
        hasUndeployedRelease:
          latestReleaseSha === null || deployedSha === null
            ? null
            : latestReleaseSha !== deployedSha,
        headError,
      };
    },

    async deployTeamVersion({
      projectId,
      gitSha,
      environment,
      rebuild = false,
    }) {
      requireDeploy(identity);
      await authorizeProject(projectId);
      await assertNoInflight(
        await targetEnvironments(projectId, environment, gitSha),
      );
      try {
        const result = await deps.deployTeamVersion({
          projectId,
          gitSha,
          envName: environment,
          rollback: !rebuild,
          rebuild,
          createdBy: identity.userId,
        });
        await audit("deploy_team_version", projectId, {
          projectId,
          gitSha,
          environment,
          rebuild,
          deploymentIds: result.deployed.map((row) => row.deploymentId),
        });
        return { ...result };
      } catch (error) {
        if (isInflightDeploymentCollision(error)) alreadyDeploying();
        if (error instanceof McpToolError) throw error;
        deploymentFailed();
      }
    },

    async deployHead({ projectId, environment }) {
      requireDeploy(identity);
      const project = await authorizeProject(projectId);
      const repo = projectRepo(project);
      await assertNoInflight(await targetEnvironments(projectId, environment));
      try {
        const result = await deps.shipRepoHead({
          project: repo,
          envName: environment,
          createdBy: identity.userId,
        });
        await audit("deploy_head", projectId, {
          projectId,
          gitSha: result.gitSha,
          environment,
          deploymentIds: result.deployed.map((row) => row.deploymentId),
        });
        return { ...result };
      } catch (error) {
        if (isInflightDeploymentCollision(error)) alreadyDeploying();
        if (error instanceof McpToolError) throw error;
        deploymentFailed();
      }
    },

    async retryDeployment({ deploymentId }) {
      requireDeploy(identity);
      const failed = await store.deployments.findById(deploymentId);
      if (!failed) {
        throw new McpToolError("Deployment not found.", "not_found");
      }
      const { environment, project } = await authorizeEnvironment(
        failed.environmentId,
      );
      if (failed.status !== "failed") {
        throw new McpToolError(
          "Only a failed deployment can be retried.",
          "invalid_state",
        );
      }
      await assertNoInflight([environment]);
      try {
        const next = await deps.queueDeploy({
          environmentId: environment.id,
          releaseId: failed.releaseId,
          rollback: true,
          createdBy: identity.userId,
        });
        await audit("retry_deployment", next.id, {
          projectId: project.id,
          environmentId: environment.id,
          previousDeploymentId: failed.id,
          deploymentId: next.id,
        });
        return {
          deploymentId: next.id,
          status: next.status,
          environmentId: environment.id,
          releaseId: failed.releaseId,
        };
      } catch (error) {
        if (isInflightDeploymentCollision(error)) alreadyDeploying();
        if (error instanceof McpToolError) throw error;
        deploymentFailed();
      }
    },

    async clearFailed({ environmentId }) {
      requireDeploy(identity);
      const { project } = await authorizeEnvironment(environmentId);
      await deps.clearFailedDeployments(environmentId);
      await audit("clear_failed", environmentId, {
        projectId: project.id,
        environmentId,
      });
      return { ok: true, environmentId };
    },

    async stageChanges({ projectId, edits }) {
      requireAuthor(identity);
      await authorizeProject(projectId);
      const paths = normalizePathBatch(edits.map((edit) => edit.path));
      const drafts = [];
      for (const [index, edit] of edits.entries()) {
        drafts.push(
          await deps.stageDraft({
            projectId,
            path: paths[index],
            content: edit.content,
            baseSha: edit.baseSha,
            createdBy: identity.userId,
          }),
        );
      }
      await audit("stage_changes", projectId, {
        projectId,
        paths,
        operations: edits.map((edit) =>
          edit.content === null ? "delete" : "write",
        ),
      });
      return {
        projectId,
        drafts: drafts.map((draft) => ({
          path: draft.path,
          operation: draft.content === null ? "delete" : "write",
          baseSha: draft.baseSha,
        })),
      };
    },

    async publishChanges({ projectId, paths: rawPaths, title }) {
      requireAuthor(identity);
      const project = await authorizeProject(projectId);
      const repo = projectRepo(project);
      const paths = normalizePathBatch(rawPaths);
      let change;
      try {
        change = await deps.publishDrafts({
          project: repo,
          paths,
          title,
          createdBy: identity.userId,
        });
      } catch (error) {
        if (error instanceof McpToolError) throw error;
        throw new McpToolError(
          "Unable to publish the staged changes. Review the staged paths and connected repository, then try again.",
          "invalid_state",
        );
      }
      await audit("publish_changes", projectId, {
        projectId,
        paths,
        pullRequestNumber: change.pullRequestNumber,
        branch: change.branch,
        base: change.base,
      });
      return { projectId, change };
    },

    async listOpenChanges({ projectId, limit = 20 }) {
      requireAuthor(identity);
      const project = await authorizeProject(projectId);
      const repo = projectRepo(project);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new McpToolError(
          "The open-change limit must be an integer from 1 to 50.",
          "invalid_input",
        );
      }
      let changes;
      try {
        changes = await deps.listOpenChanges(
          repo.repoInstallationId,
          { owner: repo.repoOwner, repo: repo.repoName },
          limit,
        );
      } catch (error) {
        if (error instanceof McpToolError) throw error;
        throw new McpToolError(
          "Unable to list open changes for the connected repository.",
          "invalid_state",
        );
      }
      await audit("list_open_changes", projectId, { projectId, limit });
      return { changes };
    },

    async mergeChange({ projectId, pullRequestNumber }) {
      requireAuthor(identity);
      const project = await authorizeProject(projectId);
      const repo = projectRepo(project);
      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
        throw new McpToolError(
          "The pull request number must be a positive integer.",
          "invalid_input",
        );
      }
      let changes;
      try {
        changes = await deps.listOpenChanges(
          repo.repoInstallationId,
          { owner: repo.repoOwner, repo: repo.repoName },
          50,
        );
      } catch {
        throw new McpToolError(
          "Unable to resolve the requested open change.",
          "invalid_state",
        );
      }
      const change = changes.find(
        (candidate) => candidate.number === pullRequestNumber,
      );
      if (!change) {
        throw new McpToolError("Open change not found.", "not_found");
      }
      if (change.base !== project.defaultBranch) {
        throw new McpToolError(
          "The open change does not target this project's default branch.",
          "invalid_state",
        );
      }
      let merge;
      try {
        merge = await deps.mergePullRequest(
          repo.repoInstallationId,
          { owner: repo.repoOwner, repo: repo.repoName },
          pullRequestNumber,
          change.branch,
        );
      } catch (error) {
        if (error instanceof McpToolError) throw error;
        throw new McpToolError(
          "Unable to merge the requested open change.",
          "invalid_state",
        );
      }
      await audit("merge_change", projectId, {
        projectId,
        pullRequestNumber,
        branch: change.branch,
        base: change.base,
        mergeSha: merge.mergeSha,
        method: merge.method,
      });
      return {
        change: {
          number: change.number,
          title: change.title,
          url: change.url,
          branch: change.branch,
          base: change.base,
        },
        merge,
      };
    },

    async discardChanges({ projectId, paths: rawPaths }) {
      requireAuthor(identity);
      await authorizeProject(projectId);
      const paths = normalizePathBatch(rawPaths);
      await deps.discardDrafts(projectId, paths);
      await audit("discard_changes", projectId, { projectId, paths });
      return { ok: true, projectId, paths };
    },
  };
}

function releaseSummary(release: Release) {
  return {
    id: release.id,
    projectId: release.projectId,
    agentId: release.agentId,
    version: release.version,
    gitSha: release.gitSha,
    imageRef: release.imageRef,
    changelog: release.changelog,
    createdAt: release.createdAt.toISOString(),
  };
}
