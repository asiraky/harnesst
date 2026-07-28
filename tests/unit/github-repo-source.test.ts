/**
 * `fetchAgentSource` tree filtering (issue #254).
 *
 * The path list this produces is the only view most of harnesst has of the repo — including the
 * publish-time platform-file gate, which can only verify files it can see. The single-agent hole
 * these tests close: repo-root `harnesst/**` sits BESIDE `agent/`, so a filter keyed on `agent/`,
 * `agents/` and the assistant config never read it, and a direct push to a platform file was
 * invisible from the moment it stopped being a draft.
 *
 * The rest pins what widening the filter must NOT do: no new agent roots, no new eager reads, and
 * no unrelated repo-root file smuggled in by a loose prefix test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectAgentRoots, isPlatformPath } from "~/eve/parse";

const mocks = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
  getTree: vi.fn(),
  getContent: vi.fn(),
  reposGet: vi.fn(),
}));

vi.mock("~/github/client.server", () => ({
  getInstallationOctokit: mocks.getInstallationOctokit,
}));

/** A git tree response carrying `paths` as blobs, plus the directory entries git also returns. */
function treeOf(paths: string[], dirs: string[] = []) {
  return {
    data: {
      tree: [
        ...dirs.map((path) => ({ path, type: "tree" })),
        ...paths.map((path) => ({ path, type: "blob" })),
      ],
      truncated: false,
    },
  };
}

async function fetchPaths(paths: string[], dirs: string[] = []) {
  mocks.getTree.mockResolvedValue(treeOf(paths, dirs));
  const { fetchAgentSource } = await import("~/github/repo.server");
  return fetchAgentSource("42", { owner: "acme", repo: "agents", ref: "main" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reposGet.mockResolvedValue({ data: { default_branch: "main" } });
  // Every eager read misses unless a test says otherwise — content is not what these tests pin.
  mocks.getContent.mockRejectedValue(new Error("not found"));
  mocks.getInstallationOctokit.mockResolvedValue({
    rest: {
      repos: { get: mocks.reposGet, getContent: mocks.getContent },
      git: { getTree: mocks.getTree },
    },
  });
});

describe("fetchAgentSource tree filtering", () => {
  it("carries a single-agent repo's repo-root platform files", async () => {
    const source = await fetchPaths([
      "package.json",
      "agent/agent.ts",
      "agent/channels/github.ts",
      "harnesst/model.ts",
      "harnesst/github-channel.ts",
      "harnesst-lock.json",
    ]);

    // The whole point: the gate's input now contains the platform files.
    expect(source.paths).toContain("harnesst/model.ts");
    expect(source.paths).toContain("harnesst/github-channel.ts");
    expect(source.paths.filter(isPlatformPath).sort()).toEqual([
      "harnesst/github-channel.ts",
      "harnesst/model.ts",
    ]);
    // Unrelated repo-root files stay out — the filter is a listing, not a whole-repo read.
    expect(source.paths).not.toContain("package.json");
    expect(source.paths).toContain("harnesst-lock.json");
  });

  it("still carries a team member's platform files", async () => {
    const source = await fetchPaths([
      "agents/ivy/agent/agent.ts",
      "agents/ivy/harnesst/model.ts",
      "agents/sam/harnesst/github-channel.ts",
    ]);

    expect(source.paths.filter(isPlatformPath).sort()).toEqual([
      "agents/ivy/harnesst/model.ts",
      "agents/sam/harnesst/github-channel.ts",
    ]);
  });

  it("admits the lock by name, not by the platform prefix", async () => {
    // `harnesst-lock.json` and `harnesst.md` both start with "harnesst"; only the directory —
    // and the lock, which is admitted by its own name — belongs in the listing.
    const source = await fetchPaths([
      "agent/agent.ts",
      "harnesst-lock.json",
      "harnesst.md",
      "harnesstrc.json",
    ]);

    expect(source.paths).toContain("harnesst-lock.json");
    expect(source.paths).not.toContain("harnesst.md");
    expect(source.paths).not.toContain("harnesstrc.json");
  });

  it("keeps the assistant config surface, which is a different `.harnesst` root", async () => {
    const source = await fetchPaths([
      "agent/agent.ts",
      ".harnesst/assistant/instructions.md",
      ".harnesst/notes.md",
    ]);

    expect(source.paths).toContain(".harnesst/assistant/instructions.md");
    // Leading dot: the assistant's surface is not platform code and must not be gated as such.
    expect(source.paths.some(isPlatformPath)).toBe(false);
    expect(source.paths).not.toContain(".harnesst/notes.md");
  });

  it("does not turn a platform root into an agent root", async () => {
    // A team repo whose members all live under `agents/` plus a repo-root `harnesst/`: the roster
    // must stay the two members. `detectAgentRoots` short-circuits to single-agent on anything
    // under `agent/`, so a spurious root here would silently collapse the whole team.
    const source = await fetchPaths([
      "harnesst/model.ts",
      "agents/ivy/agent/agent.ts",
      "agents/sam/agent/agent.ts",
      "agents/sam/harnesst/github-channel.ts",
    ]);

    expect(detectAgentRoots(source.paths)).toEqual([
      { name: "ivy", root: "agents/ivy/agent" },
      { name: "sam", root: "agents/sam/agent" },
    ]);
  });

  it("does not eagerly read platform files", async () => {
    mocks.getContent.mockResolvedValue({
      data: { type: "file", content: Buffer.from("hi").toString("base64") },
    });
    const source = await fetchPaths([
      "agent/agent.ts",
      "agent/instructions.md",
      "harnesst/model.ts",
      "harnesst/github-channel.ts",
    ]);

    // Platform bytes are read on demand by the gate, one path at a time — folding them into the
    // cached eager read would put unbounded template code in every loader's memory.
    expect(Object.keys(source.files).sort()).toEqual([
      "agent/agent.ts",
      "agent/instructions.md",
    ]);
    for (const call of mocks.getContent.mock.calls) {
      expect(isPlatformPath(call[0].path)).toBe(false);
    }
  });

  it("ignores tree entries for the platform directory itself", async () => {
    // git returns `tree` entries alongside blobs; a directory is not a file to verify.
    const source = await fetchPaths(["agent/agent.ts"], ["harnesst", "agent"]);

    expect(source.paths).toEqual(["agent/agent.ts"]);
  });
});
