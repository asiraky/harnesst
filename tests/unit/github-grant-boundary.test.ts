import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  getInstallationOctokit: vi.fn(),
  createInstallationAccessToken: vi.fn(),
  appConstructor: vi.fn(),
}));

vi.mock("~/github/installations.server", () => ({
  resolveInstallationGrant: mocks.resolve,
}));

vi.mock("octokit", () => ({
  App: class MockApp {
    octokit = {
      rest: {
        apps: {
          createInstallationAccessToken: mocks.createInstallationAccessToken,
        },
      },
    };
    getInstallationOctokit = mocks.getInstallationOctokit;
    constructor(config: unknown) {
      mocks.appConstructor(config);
    }
  },
}));

describe("opaque GitHub installation grant boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-key";
    process.env.GITHUB_APP_CLIENT_ID = "client";
    process.env.GITHUB_APP_CLIENT_SECRET = "secret";
    process.env.GITHUB_APP_SLUG = "harnesst-test";
  });

  it("rejects raw or unverified ids before constructing an App client", async () => {
    mocks.resolve.mockRejectedValueOnce(new Error("reauthorize"));
    const { getInstallationOctokit } = await import("~/github/client.server");
    await expect(getInstallationOctokit("12345678")).rejects.toThrow(
      /reauthorize/,
    );
    expect(mocks.appConstructor).not.toHaveBeenCalled();
    expect(mocks.getInstallationOctokit).not.toHaveBeenCalled();
  });

  it("resolves a verified opaque grant and supplies only its raw id internally", async () => {
    mocks.resolve.mockResolvedValueOnce({
      grantId: "opaqueGrant1",
      orgId: "org-1",
      installationId: "987654",
      accountLogin: "octo-org",
    });
    mocks.getInstallationOctokit.mockResolvedValueOnce({ ok: true });
    const { getInstallationOctokit } = await import("~/github/client.server");
    await expect(getInstallationOctokit("opaqueGrant1")).resolves.toEqual({
      ok: true,
    });
    expect(mocks.resolve).toHaveBeenCalledWith("opaqueGrant1");
    expect(mocks.getInstallationOctokit).toHaveBeenCalledWith(987654);
  });

  it("resolves before minting and narrows the token to the verified installation", async () => {
    mocks.resolve.mockResolvedValueOnce({
      grantId: "opaqueGrant1",
      orgId: "org-1",
      installationId: "987654",
      accountLogin: "octo-org",
    });
    mocks.createInstallationAccessToken.mockResolvedValueOnce({
      data: { token: "short-lived", expires_at: "2026-07-14T01:00:00Z" },
    });
    const { mintNarrowedReadToken } = await import("~/github/client.server");
    await expect(
      mintNarrowedReadToken({
        installationId: "opaqueGrant1",
        repo: "eve-agent",
      }),
    ).resolves.toEqual({
      token: "short-lived",
      expiresAt: "2026-07-14T01:00:00Z",
    });
    expect(mocks.createInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 987654,
      repositories: ["eve-agent"],
      permissions: { contents: "read" },
    });
  });
});
