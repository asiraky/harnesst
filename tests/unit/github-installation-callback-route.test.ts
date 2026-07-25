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
  } as {
    org: { id: string; name: string; slug: string };
    member: object;
  } | null,
  callback: { code: "oauth-code", error: null, state: "signed-state" } as {
    code: string | null;
    error: string | null;
    state: string | null;
  } | null,
  verifyState: vi.fn(),
  consume: vi.fn(),
  exchange: vi.fn(),
  list: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("~/auth/session.server", async () => {
  const actual = await vi.importActual<typeof import("~/auth/session.server")>(
    "~/auth/session.server",
  );
  return {
    ...actual,
    sessionLoader: vi.fn(async (_args, callback) => ({
      ...(await callback({ auth: mocks.auth })),
      user: mocks.auth.user,
    })),
  };
});
vi.mock("~/auth/workspace.server", () => ({
  resolveActiveWorkspace: vi.fn(async () => mocks.active),
}));
vi.mock("~/github/installation-callback.server", () => ({
  isGitHubInstallationCallbackStagingRequest: vi.fn(() => false),
  stageGitHubInstallationCallback: vi.fn(),
  readStagedGitHubInstallationCallback: vi.fn(() => mocks.callback),
}));
vi.mock("~/github/install-state.server", () => ({
  verifyGitHubInstallState: mocks.verifyState,
  consumeGitHubInstallationState: mocks.consume,
}));
vi.mock("~/github/client.server", () => ({
  getGitHubConfig: vi.fn(() => ({
    clientId: "client",
    clientSecret: "secret",
  })),
  exchangeGitHubUserCode: mocks.exchange,
  listGitHubUserInstallations: mocks.list,
}));
vi.mock("~/github/installations.server", () => ({
  upsertVerifiedInstallation: mocks.upsert,
}));

import { loader } from "~/routes/github.installations.callback";

const args = () =>
  ({
    request: new Request("https://eden.test/github/installations/callback"),
    context: {},
  }) as never;

describe("GitHub installation OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callback = { code: "oauth-code", error: null, state: "signed-state" };
    mocks.active = {
      org: { id: "org-1", name: "Workspace", slug: "workspace" },
      member: {},
    };
    mocks.verifyState.mockReturnValue({
      nonce: "nonce",
      userId: "user-1",
      sessionId: "session-1",
      orgId: "org-1",
    });
    mocks.consume.mockResolvedValue({
      installationId: "123",
      codeVerifier: "verifier",
    });
    mocks.exchange.mockResolvedValue("user-token");
    mocks.list.mockResolvedValue([{ id: "123", accountLogin: "octo-org" }]);
  });

  it("rejects invalid, wrong-session, and replayed callbacks without network or persistence", async () => {
    mocks.verifyState.mockReturnValueOnce(null);
    await expect(loader(args())).resolves.toMatchObject({
      error: expect.stringMatching(/invalid/),
    });

    mocks.verifyState.mockReturnValueOnce({
      nonce: "nonce",
      userId: "user-1",
      sessionId: "other-session",
      orgId: "org-1",
    });
    await expect(loader(args())).resolves.toMatchObject({
      error: expect.stringMatching(/different harnesst session/),
    });

    mocks.consume.mockResolvedValueOnce(null);
    await expect(loader(args())).resolves.toMatchObject({
      error: expect.stringMatching(/already been used/),
    });
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a changed active workspace before consuming or calling GitHub", async () => {
    mocks.active = {
      org: { id: "org-2", name: "Other", slug: "other" },
      member: {},
    };
    await expect(loader(args())).resolves.toMatchObject({
      error: expect.stringMatching(/different workspace/),
    });
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("consumes before exchanging and refuses a spoofed inaccessible installation", async () => {
    const order: string[] = [];
    mocks.consume.mockImplementationOnce(async () => {
      order.push("consume");
      return { installationId: "999", codeVerifier: "verifier" };
    });
    mocks.exchange.mockImplementationOnce(async () => {
      order.push("exchange");
      return "user-token";
    });
    mocks.list.mockResolvedValueOnce([{ id: "123", accountLogin: "octo" }]);
    await expect(loader(args())).resolves.toMatchObject({
      error: expect.stringMatching(/did not confirm/),
    });
    expect(order).toEqual(["consume", "exchange"]);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("persists a verified grant only after the user installation list matches", async () => {
    await expect(loader(args())).rejects.toMatchObject({ status: 302 });
    expect(mocks.upsert).toHaveBeenCalledWith({
      orgId: "org-1",
      installationId: "123",
      accountLogin: "octo-org",
      verifiedByUserId: "user-1",
    });
  });
});
