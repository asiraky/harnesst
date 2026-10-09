/**
 * The "Add from marketplace" dialog's data route (api.projects.$projectId.marketplace): who may
 * load it, which targets it offers, and what it reports installed at each — with every
 * collaborator mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isWorkspaceAdmin } from "~/auth/roles";

const mocks = vi.hoisted(() => ({
  role: "admin",
  index: vi.fn(),
  getAgentSource: vi.fn(),
  listDrafts: vi.fn(async () => [] as Array<{ path: string; content: string }>),
  resolveSyncedAgentContext: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  sessionLoader: async (
    _args: unknown,
    callback: (input: { auth: object }) => Promise<object>,
  ) => callback({ auth: { user: { id: "user_1" } } }),
}));
vi.mock("~/auth/workspace.server", () => ({
  requireWorkspaceAdmin: (active: { member: { role: string } }) => {
    if (!isWorkspaceAdmin(active.member.role)) {
      throw Response.json({ error: "admins only" }, { status: 403 });
    }
  },
}));
vi.mock("~/project/guard.server", () => ({
  requireProjectAccess: async () => ({
    project: {
      id: "proj_1",
      repoInstallationId: "inst",
      repoOwner: "o",
      repoName: "r",
    },
    active: { member: { role: mocks.role } },
    role: "write",
  }),
  requireRepo: (project: unknown) => project,
}));
vi.mock("~/github/cached.server", () => ({
  getAgentSource: mocks.getAgentSource,
}));
vi.mock("~/drafts/drafts.server", () => ({ listDrafts: mocks.listDrafts }));
vi.mock("~/project/agent-context.server", () => ({
  resolveSyncedAgentContext: mocks.resolveSyncedAgentContext,
}));
vi.mock("~/marketplace/install.server", () => ({
  catalogProviderEvidence: async () => [],
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ catalog: { index: mocks.index } }),
}));

import { loader } from "~/routes/api.projects.$projectId.marketplace";

const ARGS = {
  request: new Request("http://x/api/repos/proj_1/marketplace"),
  params: { projectId: "proj_1" },
  context: {},
} as unknown as Parameters<typeof loader>[0];

const TEMPLATE = {
  id: "web-search",
  type: "tool",
  name: "Web search",
  version: "1.0.0",
  description: "Search the web",
  hash: "abc",
};

function lockFile(installs: object[]) {
  return JSON.stringify({ version: 1, installs });
}

function install(member: string | null, subagent?: string) {
  return {
    id: "web-search",
    type: "tool",
    name: "Web search",
    version: "1.0.0",
    hash: "abc",
    registry: "fixture",
    member,
    ...(subagent ? { subagent } : {}),
    files: [],
  };
}

beforeEach(() => {
  mocks.role = "admin";
  mocks.index.mockResolvedValue({ templates: [TEMPLATE] });
});

describe("marketplace picker route", () => {
  it("refuses a workspace member who isn't an admin", async () => {
    mocks.role = "member";
    await expect(loader(ARGS)).rejects.toMatchObject({ status: 403 });
  });

  it("offers each team member and its declared subagents, with installs scoped to each", async () => {
    mocks.getAgentSource.mockResolvedValue({
      paths: [
        "agents/alpha/agent/agent.ts",
        "agents/alpha/agent/subagents/reader/agent.ts",
        "agents/beta/agent/agent.ts",
      ],
      files: {
        "harnesst-lock.json": lockFile([install("alpha", "reader")]),
      },
    });
    mocks.resolveSyncedAgentContext.mockResolvedValue({
      isTeam: true,
      roster: [
        { name: "alpha", root: "agents/alpha/agent" },
        { name: "beta", root: "agents/beta/agent" },
      ],
    });

    const data = await loader(ARGS);
    expect(data.isTeam).toBe(true);
    expect(data.catalogError).toBeNull();
    expect(data.templates).toEqual([
      {
        id: "web-search",
        type: "tool",
        name: "Web search",
        version: "1.0.0",
        description: "Search the web",
      },
    ]);
    expect(
      data.targets.map((t) => [t.value, t.installed]),
    ).toEqual([
      ["alpha", []],
      ["alpha:reader", ["tool/web-search"]],
      ["beta", []],
    ]);
  });

  it("reads a single-agent repo's installs from the lock's null member", async () => {
    mocks.getAgentSource.mockResolvedValue({
      paths: ["agent/agent.ts"],
      files: { "harnesst-lock.json": lockFile([install(null)]) },
    });
    mocks.resolveSyncedAgentContext.mockResolvedValue({
      isTeam: false,
      roster: [{ name: "my-agent", root: "agent" }],
    });

    const data = await loader(ARGS);
    expect(data.targets).toEqual([
      {
        value: "my-agent",
        member: "my-agent",
        subagentPath: "",
        installed: ["tool/web-search"],
      },
    ]);
  });

  it("counts a staged install as installed", async () => {
    mocks.getAgentSource.mockResolvedValue({
      paths: ["agent/agent.ts"],
      files: {},
    });
    mocks.listDrafts.mockResolvedValueOnce([
      { path: "harnesst-lock.json", content: lockFile([install(null)]) },
    ]);
    mocks.resolveSyncedAgentContext.mockResolvedValue({
      isTeam: false,
      roster: [{ name: "my-agent", root: "agent" }],
    });

    const data = await loader(ARGS);
    expect(data.targets[0].installed).toEqual(["tool/web-search"]);
  });

  it("still returns targets when the catalog is unreachable", async () => {
    mocks.index.mockRejectedValue(new Error("/secret/path/index.json: ENOENT"));
    mocks.getAgentSource.mockResolvedValue({
      paths: ["agent/agent.ts"],
      files: {},
    });
    mocks.resolveSyncedAgentContext.mockResolvedValue({
      isTeam: false,
      roster: [{ name: "my-agent", root: "agent" }],
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const data = await loader(ARGS);
    expect(data.templates).toEqual([]);
    expect(data.catalogError).not.toBeNull();
    expect(data.catalogError).not.toContain("/secret/path");
    expect(data.targets).toHaveLength(1);
  });
});
