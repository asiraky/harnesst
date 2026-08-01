import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
  invalidateRepoSource: vi.fn(),
}));

vi.mock("~/github/client.server", () => ({
  getInstallationOctokit: mocks.getInstallationOctokit,
}));
vi.mock("~/github/cached.server", () => ({
  invalidateRepoSource: mocks.invalidateRepoSource,
}));

const { commitToDefaultBranch } = await import("~/github/write.server");

describe("Git writes for binary assets", () => {
  const git = {
    createBlob: vi.fn(),
    getCommit: vi.fn(),
    createTree: vi.fn(),
    createCommit: vi.fn(),
    updateRef: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    git.createBlob.mockResolvedValue({ data: { sha: "blob-sha" } });
    git.getCommit.mockResolvedValue({ data: { tree: { sha: "tree-base" } } });
    git.createTree.mockResolvedValue({ data: { sha: "tree-next" } });
    git.createCommit.mockResolvedValue({ data: { sha: "commit-next" } });
    git.updateRef.mockResolvedValue({});
    mocks.getInstallationOctokit.mockResolvedValue({ rest: { git } });
  });

  it("preserves arbitrary bytes and leaves the agent-source cache warm for asset-only commits", async () => {
    const bytes = Buffer.from([0, 255, 17, 34]);
    await commitToDefaultBranch(
      "installation-grant",
      { owner: "acme", repo: "agents" },
      {
        branch: "main",
        expectedHeadSha: "head-base",
        files: [{ path: "assets/brand/logo.png", content: bytes }],
        message: "assets: put brand",
        invalidateSourceCache: false,
      },
    );

    expect(git.createBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        content: bytes.toString("base64"),
        encoding: "base64",
      }),
    );
    expect(git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/main", sha: "commit-next" }),
    );
    expect(mocks.invalidateRepoSource).not.toHaveBeenCalled();
  });

  it("keeps cache invalidation as the default for publish commits", async () => {
    await commitToDefaultBranch(
      "installation-grant",
      { owner: "acme", repo: "agents" },
      {
        branch: "main",
        expectedHeadSha: "head-base",
        files: [{ path: "agent/instructions.md", content: "updated" }],
        message: "Update instructions",
      },
    );

    expect(mocks.invalidateRepoSource).toHaveBeenCalledWith(
      "installation-grant",
      { owner: "acme", repo: "agents" },
    );
  });
});
