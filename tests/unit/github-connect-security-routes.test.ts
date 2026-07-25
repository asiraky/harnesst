import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", email: "user@example.test" },
    session: { id: "session-1" },
    organizationId: "org-1",
  },
  active: {
    org: { id: "org-1", name: "Workspace", slug: "workspace" },
    member: {
      id: "member-1",
      organizationId: "org-1",
      userId: "user-1",
      role: "owner",
    },
  },
  createState: vi.fn(),
  verifyState: vi.fn(),
  bind: vi.fn(),
  known: vi.fn(),
  resolveGrant: vi.fn(),
  listRepos: vi.fn(),
  fetchSource: vi.fn(),
  createRepo: vi.fn(),
  createProject: vi.fn(),
  warm: vi.fn(),
}));

vi.mock("~/auth/session.server", async () => {
  const actual = await vi.importActual<typeof import("~/auth/session.server")>(
    "~/auth/session.server",
  );
  return {
    ...actual,
    getSessionAuth: vi.fn(async () => mocks.auth),
    sessionLoader: vi.fn(async (_args, callback) => ({
      ...(await callback({ auth: mocks.auth })),
      user: mocks.auth.user,
    })),
  };
});
vi.mock("~/auth/workspace.server", () => ({
  ensureWorkspace: vi.fn(),
  // The fixture member is an owner, so the D10 back-of-house gate is a pass-through here.
  requireBackOfHouse: vi.fn(),
  resolveActiveWorkspace: vi.fn(async () => mocks.active),
}));
// Repo-team creation is best-effort in connect (FOH D9) and covered by its own suites.
vi.mock("~/auth/teams.server", () => ({ ensureProjectTeam: vi.fn() }));
vi.mock("~/github/install-state.server", () => ({
  createGitHubInstallState: mocks.createState,
  verifyGitHubInstallState: mocks.verifyState,
  bindGitHubInstallationCandidate: mocks.bind,
  pkceChallenge: vi.fn(() => "challenge"),
}));
vi.mock("~/github/installations.server", () => ({
  listKnownInstallations: mocks.known,
  resolveInstallationGrantForOrg: mocks.resolveGrant,
}));
vi.mock("~/github/client.server", () => ({
  getInstallUrl: vi.fn((state) => `https://github.test/install?state=${state}`),
  getGitHubConfig: vi.fn(() => ({ clientId: "github-client" })),
  githubUserAuthorizeUrl: vi.fn(
    ({ state }) =>
      `https://github.test/oauth?state=${encodeURIComponent(state)}`,
  ),
}));
vi.mock("~/github/repo.server", () => ({
  listInstallationRepos: mocks.listRepos,
  fetchAgentSource: mocks.fetchSource,
}));
vi.mock("~/github/create.server", () => ({ createEveRepo: mocks.createRepo }));
vi.mock("~/db/queries.server", () => ({ createProject: mocks.createProject }));
vi.mock("~/github/cached.server", () => ({ warmAgentSource: mocks.warm }));
vi.mock("~/org/workspace.server", () => ({
  getWorkspaceAssistantSelection: vi.fn(async () => ({
    model: "openai/gpt-test",
    effort: null,
  })),
}));
vi.mock("~/models/union.server", () => ({
  ownsWorkspaceModelReference: vi.fn(async () => true),
}));

import { action, loader } from "~/routes/connect";

const args = (url: string) =>
  ({ request: new Request(url), context: {} }) as never;

function post(fields: Record<string, string>) {
  return {
    request: new Request("https://harnesst.test/connect", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    context: {},
  } as never;
}

describe("secure GitHub connect routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createState.mockResolvedValue({ state: "signed-state" });
    mocks.known.mockResolvedValue([]);
    mocks.resolveGrant.mockResolvedValue({
      grantId: "grant1234567",
      installationId: "987654321",
    });
    mocks.listRepos.mockResolvedValue([]);
    mocks.createProject.mockResolvedValue({ id: "project12345" });
  });

  it("does no grant or GitHub API work for missing/invalid setup state", async () => {
    const result = await loader(
      args("https://harnesst.test/connect?installation_id=123&state=tampered"),
    );
    expect(result.github).toMatchObject({ state: "unconfigured" });
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.listRepos).not.toHaveBeenCalled();
  });

  it("rejects wrong-session setup state before binding", async () => {
    mocks.verifyState.mockReturnValue({
      nonce: "nonce",
      userId: "user-1",
      sessionId: "other-session",
      orgId: "org-1",
    });
    const result = await loader(
      args("https://harnesst.test/connect?installation_id=123&state=signed"),
    );
    expect(result.github).toMatchObject({ state: "unconfigured" });
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("rejects wrong-workspace setup state before binding or calling GitHub", async () => {
    mocks.verifyState.mockReturnValue({
      nonce: "nonce",
      userId: "user-1",
      sessionId: "session-1",
      orgId: "org-2",
    });
    const result = await loader(
      args("https://harnesst.test/connect?installation_id=123&state=signed"),
    );
    expect(result.github).toMatchObject({ state: "unconfigured" });
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.known).not.toHaveBeenCalled();
    expect(mocks.listRepos).not.toHaveBeenCalled();
  });

  it("atomically binds a valid setup callback and redirects to PKCE user OAuth", async () => {
    mocks.verifyState.mockReturnValue({
      nonce: "nonce",
      userId: "user-1",
      sessionId: "session-1",
      orgId: "org-1",
    });
    mocks.bind.mockResolvedValue("verifier");
    await expect(
      loader(
        args("https://harnesst.test/connect?installation_id=123&state=signed"),
      ),
    ).rejects.toMatchObject({ status: 302 });
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "123", orgId: "org-1" }),
    );
    expect(mocks.known).not.toHaveBeenCalled();
  });

  it("uses opaque grant ids in the picker and never exposes the raw id", async () => {
    mocks.known.mockResolvedValue([
      { grantId: "grant1234567", accountLogin: "octo" },
    ]);
    mocks.listRepos.mockResolvedValue([
      { owner: "octo", repo: "eve", fullName: "octo/eve" },
    ]);
    const result = await loader(args("https://harnesst.test/connect"));
    expect(result.github).toMatchObject({
      state: "pick",
      installationGrantId: "grant1234567",
    });
    expect(JSON.stringify(result.github)).not.toContain("installationId");
  });

  it("rejects missing and other-org grants before a GitHub helper", async () => {
    await expect(
      action(post({ owner: "octo", repo: "eve" })),
    ).resolves.toMatchObject({
      error: expect.stringMatching(/Missing installation/),
    });
    mocks.resolveGrant.mockRejectedValueOnce(new Error("reauthorize"));
    await expect(
      action(
        post({
          installationGrantId: "otherOrg1234",
          owner: "octo",
          repo: "eve",
        }),
      ),
    ).resolves.toEqual({ error: "reauthorize" });
    expect(mocks.listRepos).not.toHaveBeenCalled();
    expect(mocks.fetchSource).not.toHaveBeenCalled();
  });

  it("rejects a forged repo selection before reading or persisting", async () => {
    mocks.listRepos.mockResolvedValue([
      {
        owner: "octo",
        repo: "allowed",
        fullName: "octo/allowed",
        defaultBranch: "main",
      },
    ]);
    await expect(
      action(
        post({
          installationGrantId: "grant1234567",
          owner: "attacker",
          repo: "forged",
        }),
      ),
    ).resolves.toMatchObject({ error: expect.stringMatching(/not available/) });
    expect(mocks.fetchSource).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("connects a listed repo and persists only the opaque grant id", async () => {
    mocks.listRepos.mockResolvedValue([
      {
        owner: "octo",
        repo: "eve",
        fullName: "octo/eve",
        defaultBranch: "main",
      },
    ]);
    mocks.fetchSource.mockResolvedValue({
      paths: ["agent/agent.ts"],
      files: {},
      ref: "main",
      truncated: false,
    });
    await expect(
      action(
        post({
          installationGrantId: "grant1234567",
          owner: "octo",
          repo: "eve",
        }),
      ),
    ).rejects.toMatchObject({ status: 302 });
    expect(mocks.fetchSource).toHaveBeenCalledWith("grant1234567", {
      owner: "octo",
      repo: "eve",
    });
    expect(mocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ repoInstallationId: "grant1234567" }),
    );
  });

  it("creates a repository with only the resolved opaque grant id", async () => {
    mocks.createRepo.mockResolvedValue({
      owner: "octo-org",
      repo: "new-agent",
      defaultBranch: "main",
    });
    await expect(
      action(
        post({
          intent: "create",
          installationGrantId: "grant1234567",
          owner: "octo-org",
          name: "new-agent",
          layout: "single",
          agentName: "helper",
        }),
      ),
    ).rejects.toMatchObject({ status: 302 });
    expect(mocks.createRepo).toHaveBeenCalledWith(
      "grant1234567",
      expect.objectContaining({
        owner: "octo-org",
        name: "new-agent",
        agentName: "helper",
      }),
    );
    expect(mocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        repoInstallationId: "grant1234567",
        repoOwner: "octo-org",
        repoName: "new-agent",
      }),
    );
    expect(JSON.stringify(mocks.createRepo.mock.calls)).not.toContain(
      "987654321",
    );
    expect(JSON.stringify(mocks.createProject.mock.calls)).not.toContain(
      "987654321",
    );
  });
});
