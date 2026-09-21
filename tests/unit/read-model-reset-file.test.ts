import { beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
  get: vi.fn(),
  getContent: vi.fn(),
  getCommit: vi.fn(),
  client: vi.fn(),
}));
vi.mock("~/github/client.server", () => ({
  getInstallationOctokit: github.client,
}));

import { readModelResetFile } from "~/github/read-model-reset-file.server";

const repo = { owner: "owner", repo: "agents", ref: "committed-sha" };
const file = (bytes: Buffer) => ({
  data: {
    type: "file",
    encoding: "base64",
    content: bytes.toString("base64"),
    size: bytes.length,
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  github.client.mockResolvedValue({ rest: { repos: github } });
  github.get.mockResolvedValue({ data: { default_branch: "main" } });
  github.getCommit.mockResolvedValue({ data: { sha: "committed-sha" } });
});

describe("readModelResetFile", () => {
  it("reads exact UTF-8 source at the requested revision", async () => {
    const source = "export default { instructions: '你好' };\n";
    github.getContent.mockResolvedValue(file(Buffer.from(source)));
    expect(await readModelResetFile(42, repo, "agent/agent.ts")).toBe(source);
    expect(github.getContent).toHaveBeenCalledWith({
      ...repo,
      path: "agent/agent.ts",
    });
    expect(github.get).not.toHaveBeenCalled();
  });

  it("resolves the default branch when no ref is provided", async () => {
    github.getContent.mockResolvedValue(file(Buffer.from("")));
    expect(
      await readModelResetFile(
        "42",
        { owner: "owner", repo: "agents" },
        "package.json",
      ),
    ).toBe("");
    expect(github.getContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "agents",
      ref: "main",
      path: "package.json",
    });
  });

  it("returns null for an absent path only after confirming the repo revision is readable", async () => {
    github.getContent.mockRejectedValue({ status: 404 });
    expect(await readModelResetFile(42, repo, "agent/agent.ts")).toBeNull();
    expect(github.getCommit).toHaveBeenCalledWith(repo);
  });

  it.each([401, 403, 429, 500, 503])(
    "propagates HTTP %s instead of treating source as absent",
    async (status) => {
      const error = { status };
      github.getContent.mockRejectedValue(error);
      await expect(readModelResetFile(42, repo, "agent/agent.ts")).rejects.toBe(
        error,
      );
      expect(github.getCommit).not.toHaveBeenCalled();
    },
  );

  it("propagates a timeout without allowing source replacement", async () => {
    const error = new Error("Request timed out");
    github.getContent.mockRejectedValue(error);
    await expect(readModelResetFile(42, repo, "agent/agent.ts")).rejects.toBe(
      error,
    );
  });

  it("propagates a missing or inaccessible repo/ref despite a Contents 404", async () => {
    github.getContent.mockRejectedValue({ status: 404 });
    const error = { status: 404, message: "Revision not found" };
    github.getCommit.mockRejectedValue(error);
    await expect(readModelResetFile(42, repo, "agent/agent.ts")).rejects.toBe(
      error,
    );
  });

  it.each([
    { data: [] },
    { data: { type: "dir" } },
    { data: { type: "symlink", target: "other" } },
    { data: { type: "file", encoding: "none", content: "", size: 1000001 } },
    { data: { type: "file", encoding: "base64", content: "%%%", size: 0 } },
    { data: { type: "file", encoding: "base64", content: "", size: 10 } },
    file(Buffer.from([0xff, 0xfe])),
    file(Buffer.from([0, 1, 2])),
    file(Buffer.from([1, 2, 3])),
  ])(
    "rejects unreadable content rather than returning null: %j",
    async (response) => {
      github.getContent.mockResolvedValue(response);
      await expect(
        readModelResetFile(42, repo, "agent/agent.ts"),
      ).rejects.toThrow("not a readable UTF-8 text file");
    },
  );
});
