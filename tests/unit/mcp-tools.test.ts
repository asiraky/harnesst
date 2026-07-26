import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMcpToolService,
  type McpIdentity,
  type McpToolDeps,
} from "~/mcp/tools.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const identity: McpIdentity = {
  keyId: "key_1",
  orgId: "org_1",
  userId: "user_1",
  scopes: ["read", "deploy"],
};

const authorIdentity: McpIdentity = {
  ...identity,
  scopes: ["read", "author"],
};

describe("MCP deployment tools", () => {
  let store: FakeStore;
  let deps: Partial<McpToolDeps>;

  beforeEach(() => {
    store = makeFakeStore();
    store.seedProject({
      id: "project_1",
      orgId: "org_1",
      name: "Team",
      slug: "team",
      layout: "team",
      repoOwner: "acme",
      repoName: "agents",
      repoInstallationId: "42",
      defaultBranch: "main",
    });
    store.seedAgent({ id: "agent_1", projectId: "project_1", name: "alpha" });
    store.seedAgent({
      id: "assistant_1",
      projectId: "project_1",
      name: "assistant",
      kind: "assistant",
    });
    store.seedEnvironment({
      id: "env_1",
      projectId: "project_1",
      agentId: "agent_1",
      name: "production",
    });
    deps = {
      store,
      getBranchHead: vi.fn(async () => ({ sha: "head-sha", branch: "main" })),
    };
  });

  async function release(gitSha: string, version: string) {
    return store.releases.insert({
      projectId: "project_1",
      agentId: "agent_1",
      gitSha,
      version,
    });
  }

  it("lists only tenant-owned projects and roster members", async () => {
    store.seedProject({ id: "project_other", orgId: "org_2", name: "Private" });
    const tools = createMcpToolService(identity, deps);

    await expect(tools.listProjects()).resolves.toMatchObject({
      projects: [{ id: "project_1", repoOwner: "acme", defaultBranch: "main" }],
    });
    await expect(tools.listAgents({ projectId: "project_1" })).resolves.toEqual(
      {
        agents: [expect.objectContaining({ id: "agent_1", name: "alpha" })],
      },
    );
    await expect(
      tools.listAgents({ projectId: "project_other" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists release and environment shapes with nested ownership checks", async () => {
    const row = await release("sha-1", "v1");
    const tools = createMcpToolService(identity, deps);

    await expect(
      tools.listReleases({ projectId: "project_1", agentId: "agent_1" }),
    ).resolves.toEqual({
      releases: [
        expect.objectContaining({
          id: row.id,
          agentId: "agent_1",
          gitSha: "sha-1",
          version: "v1",
        }),
      ],
    });
    await expect(
      tools.listEnvironments({ projectId: "project_1", agentId: "agent_1" }),
    ).resolves.toEqual({
      environments: [
        expect.objectContaining({
          id: "env_1",
          agent: { id: "agent_1", name: "alpha" },
        }),
      ],
    });

    store.seedAgent({
      id: "agent_other",
      projectId: "project_other",
      name: "other",
    });
    await expect(
      tools.listReleases({ projectId: "project_1", agentId: "agent_other" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it.each(["pending", "building", "live", "failed"])(
    "returns the requested %s polling state without confusing target and live SHAs",
    async (status) => {
      const liveRelease = await release("deployed-sha", "v1");
      const targetRelease = await release("release-sha", "v2");
      await store.deployments.insert({
        environmentId: "env_1",
        releaseId: liveRelease.id,
        status: "live",
        trafficWeight: 100,
      });
      const target = await store.deployments.insert({
        environmentId: "env_1",
        releaseId: targetRelease.id,
        status,
        trafficWeight: 100,
      });

      const result = await createMcpToolService(identity, deps).getDeployStatus(
        {
          deploymentId: target.id,
        },
      );

      expect(result).toMatchObject({
        deployment: {
          id: target.id,
          status,
          release: { gitSha: "release-sha" },
        },
        deployedSha: status === "live" ? "release-sha" : "deployed-sha",
        latestReleaseSha: "release-sha",
        headSha: "head-sha",
        hasUnreleasedChanges: true,
        hasUndeployedRelease: status === "live" ? false : true,
        headError: null,
      });
    },
  );

  it("keeps deployment status available when repository HEAD is unknown", async () => {
    const targetRelease = await release("release-sha", "v1");
    const target = await store.deployments.insert({
      environmentId: "env_1",
      releaseId: targetRelease.id,
      status: "failed",
      trafficWeight: 100,
    });
    const tools = createMcpToolService(identity, {
      ...deps,
      getBranchHead: vi.fn(async () => {
        throw new Error("secret provider detail");
      }),
    });

    await expect(
      tools.getDeployStatus({ deploymentId: target.id }),
    ).resolves.toMatchObject({
      deployment: { status: "failed" },
      headSha: null,
      hasUnreleasedChanges: null,
      hasUndeployedRelease: null,
      headError: expect.stringMatching(/unable to read/i),
    });
  });

  it("authorizes deployment status through deployment → environment → project", async () => {
    store.seedProject({ id: "project_other", orgId: "org_2" });
    store.seedAgent({ id: "agent_other", projectId: "project_other" });
    store.seedEnvironment({
      id: "env_other",
      projectId: "project_other",
      agentId: "agent_other",
    });
    const otherRelease = await store.releases.insert({
      projectId: "project_other",
      agentId: "agent_other",
      gitSha: "private-sha",
      version: "v1",
    });
    const otherDeployment = await store.deployments.insert({
      environmentId: "env_other",
      releaseId: otherRelease.id,
      status: "live",
      trafficWeight: 100,
    });

    await expect(
      createMcpToolService(identity, deps).getDeployStatus({
        deploymentId: otherDeployment.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns direct deployment ids for team-version and HEAD deploys and audits them", async () => {
    const deployTeamVersion = vi.fn(async () => ({
      deployed: [
        {
          agentName: "alpha",
          environmentId: "env_1",
          deploymentId: "dep_version",
        },
      ],
      skipped: [],
    }));
    const shipRepoHead = vi.fn(async () => ({
      version: "v3",
      gitSha: "head-sha",
      envName: "production",
      deployed: [
        {
          agentName: "alpha",
          environmentId: "env_1",
          deploymentId: "dep_head",
        },
      ],
      skipped: [],
    }));
    const tools = createMcpToolService(identity, {
      ...deps,
      deployTeamVersion,
      shipRepoHead,
    });

    await expect(
      tools.deployTeamVersion({
        projectId: "project_1",
        gitSha: "release-sha",
        environment: "production",
      }),
    ).resolves.toMatchObject({ deployed: [{ deploymentId: "dep_version" }] });
    expect(deployTeamVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        rollback: true,
        rebuild: false,
        createdBy: "user_1",
      }),
    );
    await expect(
      tools.deployHead({ projectId: "project_1", environment: "production" }),
    ).resolves.toMatchObject({
      gitSha: "head-sha",
      deployed: [{ deploymentId: "dep_head" }],
    });
    expect(store.auditEntries.map((entry) => entry.action)).toEqual([
      "mcp.deploy_team_version",
      "mcp.deploy_head",
    ]);
  });

  it("retries only failed owned deployments with a new id and clears failed rows", async () => {
    const failedRelease = await release("failed-sha", "v1");
    const failed = await store.deployments.insert({
      environmentId: "env_1",
      releaseId: failedRelease.id,
      status: "failed",
      trafficWeight: 100,
    });
    const queueDeploy = vi.fn(async () => ({
      id: "dep_retry",
      status: "pending",
    }));
    const clearFailedDeployments = vi.fn(async () => undefined);
    const tools = createMcpToolService(identity, {
      ...deps,
      queueDeploy,
      clearFailedDeployments,
    });

    await expect(
      tools.retryDeployment({ deploymentId: failed.id }),
    ).resolves.toMatchObject({
      deploymentId: "dep_retry",
      status: "pending",
      releaseId: failedRelease.id,
    });
    expect(queueDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ rollback: true, createdBy: "user_1" }),
    );
    await expect(
      tools.clearFailed({ environmentId: "env_1" }),
    ).resolves.toEqual({
      ok: true,
      environmentId: "env_1",
    });
    expect(clearFailedDeployments).toHaveBeenCalledWith("env_1");
    expect(store.auditEntries.map((entry) => entry.action)).toEqual([
      "mcp.retry_deployment",
      "mcp.clear_failed",
    ]);
  });

  it("surfaces preflight and database-race collisions as stable already-deploying errors", async () => {
    const targetRelease = await release("release-sha", "v1");
    await store.deployments.insert({
      environmentId: "env_1",
      releaseId: targetRelease.id,
      status: "pending",
      trafficWeight: 100,
    });
    const deployTeamVersion = vi.fn();
    await expect(
      createMcpToolService(identity, {
        ...deps,
        deployTeamVersion,
      }).deployTeamVersion({
        projectId: "project_1",
        gitSha: "release-sha",
        environment: "production",
      }),
    ).rejects.toMatchObject({ code: "already_deploying" });
    expect(deployTeamVersion).not.toHaveBeenCalled();

    await store.deployments.update(
      (await store.deployments.listByEnvironment("env_1"))[0].id,
      { status: "failed" },
    );
    const collision = Object.assign(new Error("db detail"), {
      code: "23505",
      constraint_name: "deployments_env_inflight_uq",
    });
    await expect(
      createMcpToolService(identity, {
        ...deps,
        deployTeamVersion: vi.fn(async () => {
          throw new Error("wrapped", { cause: collision });
        }),
      }).deployTeamVersion({
        projectId: "project_1",
        gitSha: "release-sha",
        environment: "production",
      }),
    ).rejects.toMatchObject({ code: "already_deploying" });
  });

  it("requires deploy scope for every mutation", async () => {
    const readOnly = createMcpToolService(
      { ...identity, scopes: ["read"] },
      deps,
    );
    await expect(
      readOnly.deployHead({
        projectId: "project_1",
        environment: "production",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      readOnly.clearFailed({ environmentId: "env_1" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("MCP PR-enforced authoring tools", () => {
  let store: FakeStore;
  let deps: Partial<McpToolDeps>;

  beforeEach(() => {
    store = makeFakeStore();
    store.seedProject({
      id: "project_1",
      orgId: "org_1",
      name: "Team",
      repoOwner: "acme",
      repoName: "agents",
      repoInstallationId: "42",
      defaultBranch: "trunk",
    });
    store.seedAgent({ id: "agent_1", projectId: "project_1", name: "alpha" });
    deps = { store };
  });

  function openChange(overrides: Record<string, unknown> = {}) {
    return {
      number: 12,
      title: "Update instructions",
      body: "",
      url: "https://github.example/acme/agents/pull/12",
      branch: "harnesst/publish-123",
      base: "trunk",
      createdAt: "2026-07-14T00:00:00Z",
      mergeable: true,
      mergeableState: "clean",
      draft: false,
      files: [],
      ...overrides,
    };
  }

  it("stages normalized edits sequentially with the caller identity and audits no content", async () => {
    const recordAudit = vi.spyOn(store.audit, "record");
    const tools = createMcpToolService(authorIdentity, deps);

    const result = await tools.stageChanges({
      projectId: "project_1",
      edits: [
        {
          path: " /agent/instructions.md ",
          content: "Keep this out of audit output",
          baseSha: "blob_1",
        },
        { path: "agent/old.md", content: null },
      ],
    });

    expect(result).toEqual({
      projectId: "project_1",
      drafts: [
        {
          path: "agent/instructions.md",
          operation: "write",
          baseSha: "blob_1",
        },
        { path: "agent/old.md", operation: "delete", baseSha: null },
      ],
    });
    await expect(
      store.drafts.get("project_1", "agent/instructions.md"),
    ).resolves.toMatchObject({
      content: "Keep this out of audit output",
      baseSha: "blob_1",
      createdBy: "user_1",
    });
    expect(store.auditEntries.map((entry) => entry.action)).toEqual([
      "mcp.stage_changes",
    ]);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "user_1",
        meta: expect.objectContaining({
          paths: ["agent/instructions.md", "agent/old.md"],
          operations: ["write", "delete"],
        }),
      }),
    );
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain(
      "Keep this out of audit output",
    );
    expect(JSON.stringify(result)).not.toContain(
      "Keep this out of audit output",
    );
  });

  it.each([
    {
      label: "an invalid path",
      edits: [
        { path: "agent/valid.md", content: "valid" },
        { path: "../secrets", content: "invalid" },
      ],
    },
    {
      label: "duplicate normalized paths",
      edits: [
        { path: "agent/duplicate.md", content: "first" },
        { path: "/agent/duplicate.md", content: "second" },
      ],
    },
  ])("rejects $label before staging any edit", async ({ edits }) => {
    const stageDraft = vi.fn();
    const tools = createMcpToolService(authorIdentity, { ...deps, stageDraft });

    await expect(
      tools.stageChanges({ projectId: "project_1", edits }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(stageDraft).not.toHaveBeenCalled();
    await expect(store.drafts.listByProject("project_1")).resolves.toEqual([]);
  });

  it("does not stage drafts into a project owned by another organization", async () => {
    store.seedProject({ id: "project_other", orgId: "org_2" });
    const stageDraft = vi.fn();
    const tools = createMcpToolService(authorIdentity, { ...deps, stageDraft });

    await expect(
      tools.stageChanges({
        projectId: "project_other",
        edits: [{ path: "agent/instructions.md", content: "private" }],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(stageDraft).not.toHaveBeenCalled();
  });

  it("publishes selected drafts through the connected project and default branch", async () => {
    const publishDrafts = vi.fn(async () => ({
      branch: "harnesst/publish-123",
      base: "trunk",
      pullRequestUrl: "https://github.example/acme/agents/pull/12",
      pullRequestNumber: 12,
      reusedPullRequest: false,
    }));
    const tools = createMcpToolService(authorIdentity, {
      ...deps,
      publishDrafts,
    });

    await expect(
      tools.publishChanges({
        projectId: "project_1",
        paths: ["/agent/instructions.md"],
        title: "Update instructions",
      }),
    ).resolves.toMatchObject({
      projectId: "project_1",
      change: {
        branch: "harnesst/publish-123",
        base: "trunk",
        pullRequestNumber: 12,
      },
    });
    expect(publishDrafts).toHaveBeenCalledWith({
      project: {
        id: "project_1",
        repoInstallationId: "42",
        repoOwner: "acme",
        repoName: "agents",
        defaultBranch: "trunk",
      },
      paths: ["agent/instructions.md"],
      title: "Update instructions",
      createdBy: "user_1",
    });
    expect(store.auditEntries.map((entry) => entry.action)).toEqual([
      "mcp.publish_changes",
    ]);
  });

  it("forwards bounded open-change listing to the connected repository", async () => {
    const listOpenChanges = vi.fn(async () => [openChange()]);
    const tools = createMcpToolService(authorIdentity, {
      ...deps,
      listOpenChanges,
    });

    await expect(
      tools.listOpenChanges({ projectId: "project_1", limit: 7 }),
    ).resolves.toEqual({ changes: [openChange()] });
    expect(listOpenChanges).toHaveBeenCalledWith(
      "42",
      { owner: "acme", repo: "agents" },
      7,
    );
    expect(store.auditEntries.map((entry) => entry.action)).toEqual([
      "mcp.list_open_changes",
    ]);
  });

  it("merges only the server-resolved harnesst branch targeting the default branch", async () => {
    const listOpenChanges = vi.fn(async () => [openChange()]);
    const mergePullRequest = vi.fn(async () => ({
      mergeSha: "merge_sha",
      method: "squash" as const,
    }));
    const tools = createMcpToolService(authorIdentity, {
      ...deps,
      listOpenChanges,
      mergePullRequest,
    });

    await expect(
      tools.mergeChange({ projectId: "project_1", pullRequestNumber: 12 }),
    ).resolves.toMatchObject({
      change: {
        number: 12,
        branch: "harnesst/publish-123",
        base: "trunk",
      },
      merge: { mergeSha: "merge_sha", method: "squash" },
    });
    expect(listOpenChanges).toHaveBeenCalledWith(
      "42",
      { owner: "acme", repo: "agents" },
      50,
    );
    expect(mergePullRequest).toHaveBeenCalledWith(
      "42",
      { owner: "acme", repo: "agents" },
      12,
      "harnesst/publish-123",
    );
    expect(store.auditEntries.map((entry) => entry.action)).toEqual([
      "mcp.merge_change",
    ]);
  });

  it.each([
    { label: "is absent", changes: [], code: "not_found" },
    {
      label: "targets another base",
      changes: [openChange({ base: "release" })],
      code: "invalid_state",
    },
  ])(
    "refuses to merge when the requested PR $label",
    async ({ changes, code }) => {
      const mergePullRequest = vi.fn();
      const tools = createMcpToolService(authorIdentity, {
        ...deps,
        listOpenChanges: vi.fn(async () => changes),
        mergePullRequest,
      });

      await expect(
        tools.mergeChange({ projectId: "project_1", pullRequestNumber: 12 }),
      ).rejects.toMatchObject({ code });
      expect(mergePullRequest).not.toHaveBeenCalled();
    },
  );

  it("discards only normalized staged drafts and audits the operation", async () => {
    await store.drafts.upsert({
      projectId: "project_1",
      agentId: "agent_1",
      path: "agent/instructions.md",
      content: "draft",
      createdBy: "user_1",
    });
    const tools = createMcpToolService(authorIdentity, deps);

    await expect(
      tools.discardChanges({
        projectId: "project_1",
        paths: ["/agent/instructions.md"],
      }),
    ).resolves.toEqual({
      ok: true,
      projectId: "project_1",
      paths: ["agent/instructions.md"],
    });
    await expect(store.drafts.listByProject("project_1")).resolves.toEqual([]);
    expect(store.auditEntries.map((entry) => entry.action)).toEqual([
      "mcp.discard_changes",
    ]);
  });

  it.each([
    [
      "stage_changes",
      (tools: ReturnType<typeof createMcpToolService>) =>
        tools.stageChanges({
          projectId: "project_1",
          edits: [{ path: "agent/a.md", content: "a" }],
        }),
    ],
    [
      "publish_changes",
      (tools: ReturnType<typeof createMcpToolService>) =>
        tools.publishChanges({ projectId: "project_1", paths: ["agent/a.md"] }),
    ],
    [
      "list_open_changes",
      (tools: ReturnType<typeof createMcpToolService>) =>
        tools.listOpenChanges({ projectId: "project_1" }),
    ],
    [
      "merge_change",
      (tools: ReturnType<typeof createMcpToolService>) =>
        tools.mergeChange({ projectId: "project_1", pullRequestNumber: 12 }),
    ],
    [
      "discard_changes",
      (tools: ReturnType<typeof createMcpToolService>) =>
        tools.discardChanges({ projectId: "project_1", paths: ["agent/a.md"] }),
    ],
  ])("requires author scope for %s", async (_name, call) => {
    const tools = createMcpToolService(identity, deps);
    await expect(call(tools)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("offers no direct-commit or direct-default-branch method", () => {
    const tools = createMcpToolService(authorIdentity, deps);
    expect(Object.keys(tools)).not.toContain("commitFiles");
    expect(Object.keys(tools)).not.toContain("commitToDefaultBranch");
  });
});
