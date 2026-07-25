/**
 * Staged change-sets (PRD §7.3) — against the in-memory store, with a fake propose function
 * (no DB, no GitHub). Pins the staging contract: save = upsert per path (refresh-proof),
 * publish = ONE change-set from the SELECTED drafts only (published drafts cleared, unchecked
 * ones kept), and discard is path-exact.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  discardDrafts,
  findOrphanedDrafts,
  getDraft,
  listDrafts,
  publishDrafts,
  resolveFileView,
  stageDeletions,
  type FileViewDeps,
} from "~/drafts/drafts.server";
import { stageDraft } from "~/drafts/drafts.server";
import type { DraftChange } from "~/data/ports";
import { readAgentFile } from "~/github/repo.server";
import type { ProposedChange } from "~/github/write.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

// The publish normalization reads repo files (package.json / package-lock.json) to detect a
// stale lockfile — stub the GitHub read so no test touches the network.
vi.mock("~/github/repo.server", () => ({ readAgentFile: vi.fn() }));
const readAgentFileMock = vi.mocked(readAgentFile);

let store: FakeStore;
const PROJECT = {
  id: "proj_1",
  repoInstallationId: "inst_1",
  repoOwner: "acme",
  repoName: "agent",
  defaultBranch: "main",
};

const proposed: ProposedChange = {
  branch: "eden/publish-x",
  base: "main",
  pullRequestUrl: "https://github.test/pr/7",
  pullRequestNumber: 7,
  reusedPullRequest: false,
};

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT.id, orgId: "org_1" });
  // Drafts key by roster member (Milestone 5.5) — a single-agent repo is a team of one.
  store.seedAgent({ id: "agent_1", projectId: PROJECT.id });
  readAgentFileMock.mockReset();
  readAgentFileMock.mockResolvedValue(null);
});

describe("staging", () => {
  it("persists a draft per path and re-save overwrites it (refresh-proof)", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/instructions.md", content: "v1" },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/instructions.md", content: "v2" },
      store,
    );

    const draft = await getDraft(PROJECT.id, "agent/instructions.md", store);
    expect(draft?.content).toBe("v2");
    expect(await listDrafts(PROJECT.id, store)).toHaveLength(1);
  });

  it("discards path-exactly", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/a.md", content: "a" },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/b.md", content: "b" },
      store,
    );
    await discardDrafts(PROJECT.id, ["agent/a.md"], store);

    expect(await getDraft(PROJECT.id, "agent/a.md", store)).toBeNull();
    expect((await getDraft(PROJECT.id, "agent/b.md", store))?.content).toBe(
      "b",
    );
  });
});

describe("publishDrafts", () => {
  it("publishes ONLY the selected drafts as one change-set and keeps the rest staged", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/a.md", content: "A" },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/b.md", content: "B" },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/c.md", content: "C" },
      store,
    );

    const propose = vi.fn().mockResolvedValue(proposed);
    const change = await publishDrafts(
      { project: PROJECT, paths: ["agent/a.md", "agent/c.md"] }, // b unchecked
      store,
      propose,
    );
    expect(change.pullRequestNumber).toBe(7);

    // One propose call carrying exactly the selected files.
    expect(propose).toHaveBeenCalledOnce();
    const input = propose.mock.calls[0][2];
    expect(input.files).toEqual([
      { path: "agent/a.md", content: "A" },
      { path: "agent/c.md", content: "C" },
    ]);
    expect(input.base).toBe("main");
    expect(input.title).toBe("Update 2 agent files");

    // Published drafts cleared; the unchecked one survives for a later publish.
    const remaining = await listDrafts(PROJECT.id, store);
    expect(remaining.map((d) => d.path)).toEqual(["agent/b.md"]);
  });

  it("uses the single path as the title for a one-file publish", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/tools/x.ts", content: "X" },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    await publishDrafts(
      { project: PROJECT, paths: ["agent/tools/x.ts"] },
      store,
      propose,
    );
    expect(propose.mock.calls[0][2].title).toBe("Update agent/tools/x.ts");
  });

  it("rejects an empty selection", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/a.md", content: "A" },
      store,
    );
    await expect(
      publishDrafts({ project: PROJECT, paths: [] }, store, vi.fn()),
    ).rejects.toThrow(/No staged changes selected/);
  });

  it("skips the build gate for an assistant-only (.eden/assistant) changeset", async () => {
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: ".eden/assistant/instructions.md",
        content: "hi",
      },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    const checkBuild = vi
      .fn()
      .mockResolvedValue({ ok: false, output: "should not run" });
    await publishDrafts(
      { project: PROJECT, paths: [".eden/assistant/instructions.md"] },
      store,
      propose,
      checkBuild,
    );
    expect(checkBuild).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledOnce();
  });

  it("still runs the build gate when a member file is in the selection", async () => {
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: ".eden/assistant/instructions.md",
        content: "hi",
      },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/tools/x.ts", content: "X" },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    const checkBuild = vi.fn().mockResolvedValue({ ok: true });
    await publishDrafts(
      {
        project: PROJECT,
        paths: [".eden/assistant/instructions.md", "agent/tools/x.ts"],
      },
      store,
      propose,
      checkBuild,
    );
    expect(checkBuild).toHaveBeenCalledOnce();
  });

  it("keeps drafts staged when the propose call fails", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/a.md", content: "A" },
      store,
    );
    const propose = vi.fn().mockRejectedValue(new Error("github down"));
    await expect(
      publishDrafts(
        { project: PROJECT, paths: ["agent/a.md"] },
        store,
        propose,
      ),
    ).rejects.toThrow("github down");
    // Nothing was deleted — the human can retry.
    expect(await listDrafts(PROJECT.id, store)).toHaveLength(1);
  });
});

describe("deletion drafts", () => {
  it("stageDeletions stacks null-content drafts alongside edits (one change-set)", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/agent.ts", content: "model" },
      store,
    );
    await stageDeletions(
      { projectId: PROJECT.id, paths: ["agent/schedules/daily.md"] },
      store,
    );

    const drafts = await listDrafts(PROJECT.id, store);
    expect(drafts).toHaveLength(2);
    expect(
      drafts.find((d) => d.path === "agent/schedules/daily.md")?.content,
    ).toBeNull();
  });

  it("a deletion supersedes a staged edit on the same path", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/tools/x.ts", content: "edit" },
      store,
    );
    await stageDeletions(
      { projectId: PROJECT.id, paths: ["agent/tools/x.ts"] },
      store,
    );
    expect(
      (await getDraft(PROJECT.id, "agent/tools/x.ts", store))?.content,
    ).toBeNull();
  });

  it("publishes edits and deletions as ONE change request (null content = delete)", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/agent.ts", content: "model" },
      store,
    );
    await stageDeletions(
      { projectId: PROJECT.id, paths: ["agent/schedules/daily.md"] },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);

    await publishDrafts(
      {
        project: PROJECT,
        paths: ["agent/agent.ts", "agent/schedules/daily.md"],
      },
      store,
      propose,
    );

    expect(propose).toHaveBeenCalledTimes(1);
    const { files } = propose.mock.calls[0][2];
    expect(files).toContainEqual({ path: "agent/agent.ts", content: "model" });
    expect(files).toContainEqual({
      path: "agent/schedules/daily.md",
      content: null,
    });
    expect(await listDrafts(PROJECT.id, store)).toHaveLength(0);
  });

  it("titles a one-file deletion publish as a removal", async () => {
    await stageDeletions(
      { projectId: PROJECT.id, paths: ["agent/tools/x.ts"] },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    await publishDrafts(
      { project: PROJECT, paths: ["agent/tools/x.ts"] },
      store,
      propose,
    );
    expect(propose.mock.calls[0][2].title).toBe("Remove agent/tools/x.ts");
  });

  it("the build gate sees the deletion (null overlay entry checks the post-merge tree)", async () => {
    await stageDeletions(
      { projectId: PROJECT.id, paths: ["agent/tools/x.ts"] },
      store,
    );
    const checkBuild = vi.fn().mockResolvedValue({ ok: true });
    await publishDrafts(
      { project: PROJECT, paths: ["agent/tools/x.ts"] },
      store,
      vi.fn().mockResolvedValue(proposed),
      checkBuild,
    );
    expect(checkBuild.mock.calls[0][0].overlay).toEqual([
      { path: "agent/tools/x.ts", content: null },
    ]);
  });
});

describe("publish gate (build check)", () => {
  it("a failing check blocks the change request and keeps drafts staged", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/tools/w.ts", content: "bad" },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    const failCheck = vi.fn().mockResolvedValue({
      ok: false,
      output: "'eve' does not provide defineTool",
    });

    await expect(
      publishDrafts(
        { project: PROJECT, paths: ["agent/tools/w.ts"] },
        store,
        propose,
        failCheck,
      ),
    ).rejects.toThrow(/Build check failed[\s\S]*does not provide defineTool/);

    expect(propose).not.toHaveBeenCalled(); // no branch, no PR
    expect(await listDrafts(PROJECT.id, store)).toHaveLength(1); // fix & retry
  });

  it("checks exactly the SELECTED drafts against the default branch", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/a.md", content: "A" },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/b.md", content: "B" },
      store,
    );
    const check = vi.fn().mockResolvedValue({ ok: true });
    await publishDrafts(
      { project: PROJECT, paths: ["agent/a.md"] },
      store,
      vi.fn().mockResolvedValue(proposed),
      check,
    );
    expect(check).toHaveBeenCalledWith({
      projectId: PROJECT.id,
      repo: { owner: "acme", repo: "agent" },
      ref: "main",
      installationId: "inst_1",
      overlay: [{ path: "agent/a.md", content: "A" }],
      // All selected drafts belong to the sole roster member, so the gate targets its root.
      agentRoot: "agent",
    });
  });

  it("normalizes stale OpenRouter package drafts before the build gate", async () => {
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "package.json",
        content:
          JSON.stringify(
            {
              dependencies: {
                "@openrouter/ai-sdk-provider": "^2.10.0",
                eve: "latest",
                zod: "^3.23.0",
              },
            },
            null,
            2,
          ) + "\n",
      },
      store,
    );
    const check = vi.fn().mockResolvedValue({ ok: true });
    const propose = vi.fn().mockResolvedValue(proposed);

    await publishDrafts(
      { project: PROJECT, paths: ["package.json"] },
      store,
      propose,
      check,
    );

    const checkedPackage = check.mock.calls[0][0].overlay.find(
      (file: { path: string }) => file.path === "package.json",
    );
    expect(JSON.parse(checkedPackage.content).dependencies).toEqual({
      "@ai-sdk/anthropic": "^4.0.12",
      "@ai-sdk/openai": "^4.0.11",
      "@ai-sdk/openai-compatible": "^3.0.7",
      ai: "^7.0.0",
      // "latest" gets pinned: the docker layer cache would keep serving whatever
      // version the first image build installed (see ensureModelProviderDependencies).
      eve: "^0.22.0",
      zod: "^4.4.3",
    });
    expect(propose.mock.calls[0][2].files).toEqual([
      { path: "package.json", content: checkedPackage.content },
    ]);
  });

  it("adds the member's package overlay when a provider-routed subagent is published alone", async () => {
    // A wired subagent module compiles in its member's build and imports the provider package —
    // without the member package.json overlay the build gate would fail on the missing dependency.
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agent/subagents/reader/agent.ts",
        content: `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";\nimport { defineAgent } from "eve";\nconst openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY ?? "" });\nexport default defineAgent({ description: "Reader.", model: openrouter.chatModel("z-ai/glm-5.2") });\n`,
      },
      store,
    );
    readAgentFileMock.mockImplementation(async (_inst, _repo, path) =>
      path === "package.json"
        ? JSON.stringify({ dependencies: { eve: "^0.22.0" } }, null, 2) + "\n"
        : null,
    );
    const check = vi.fn().mockResolvedValue({ ok: true });
    const propose = vi.fn().mockResolvedValue(proposed);

    await publishDrafts(
      { project: PROJECT, paths: ["agent/subagents/reader/agent.ts"] },
      store,
      propose,
      check,
    );

    const overlay = check.mock.calls[0][0].overlay as {
      path: string;
      content: string | null;
    }[];
    const pkg = overlay.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    expect(
      JSON.parse(pkg!.content!).dependencies["@ai-sdk/openai-compatible"],
    ).toBe("^3.0.7");
  });

  it("stages the stale package-lock.json for deletion when a dependency rewrite changes package.json", async () => {
    const repoPackage =
      JSON.stringify(
        {
          dependencies: {
            "@openrouter/ai-sdk-provider": "^2.10.0",
            eve: "latest",
            zod: "^3.23.0",
          },
        },
        null,
        2,
      ) + "\n";
    // The repo has a committed lockfile built for the OLD dependencies — `npm ci` in the
    // build gate would hard-fail on the rewritten package.json.
    readAgentFileMock.mockImplementation(async (_inst, _repo, path) => {
      if (path === "package.json") return repoPackage;
      if (path === "package-lock.json") return '{"lockfileVersion": 3}';
      return null;
    });
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agent/agent.ts",
        content:
          "export default defineAgent({ model: openrouter.chatModel('m/x') });",
      },
      store,
    );
    const check = vi.fn().mockResolvedValue({ ok: true });
    const propose = vi.fn().mockResolvedValue(proposed);

    await publishDrafts(
      { project: PROJECT, paths: ["agent/agent.ts"] },
      store,
      propose,
      check,
    );

    const overlay = check.mock.calls[0][0].overlay as {
      path: string;
      content: string | null;
    }[];
    expect(overlay.find((f) => f.path === "package-lock.json")).toEqual({
      path: "package-lock.json",
      content: null,
    });
    // The published change-set deletes the lock too, so the deployed image's `npm ci`
    // doesn't hit the same mismatch.
    expect(propose.mock.calls[0][2].files).toContainEqual({
      path: "package-lock.json",
      content: null,
    });
  });

  it("heals a stale harnesst-authored Dockerfile when the lock deletion would break its COPY", async () => {
    const repoPackage =
      JSON.stringify(
        { dependencies: { "@openrouter/ai-sdk-provider": "^2.10.0" } },
        null,
        2,
      ) + "\n";
    // Older harnesst scaffolds committed a copy of the reference image that COPYs the lock
    // explicitly and runs a bare `npm ci` — deleting the lock breaks it at COPY.
    const staleDockerfile = `# Eden reference image for an eve agent (mirrors LocalDockerTarget.build()).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
`;
    readAgentFileMock.mockImplementation(async (_inst, _repo, path) => {
      if (path === "package.json") return repoPackage;
      if (path === "package-lock.json") return '{"lockfileVersion": 3}';
      if (path === "Dockerfile") return staleDockerfile;
      return null;
    });
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agent/agent.ts",
        content:
          "export default defineAgent({ model: openrouter.chatModel('m/x') });",
      },
      store,
    );
    const check = vi.fn().mockResolvedValue({ ok: true });

    await publishDrafts(
      { project: PROJECT, paths: ["agent/agent.ts"] },
      store,
      vi.fn().mockResolvedValue(proposed),
      check,
    );

    const overlay = check.mock.calls[0][0].overlay as {
      path: string;
      content: string | null;
    }[];
    const dockerfile = overlay.find((f) => f.path === "Dockerfile");
    expect(dockerfile?.content).toContain("COPY package*.json ./");
    expect(dockerfile?.content).toContain("npm install");
  });

  it("never touches a user-authored Dockerfile (no harnesst header)", async () => {
    const repoPackage =
      JSON.stringify(
        { dependencies: { "@openrouter/ai-sdk-provider": "^2.10.0" } },
        null,
        2,
      ) + "\n";
    readAgentFileMock.mockImplementation(async (_inst, _repo, path) => {
      if (path === "package.json") return repoPackage;
      if (path === "package-lock.json") return '{"lockfileVersion": 3}';
      if (path === "Dockerfile")
        return "FROM node:24\nCOPY package.json package-lock.json ./\nRUN npm ci\n";
      return null;
    });
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agent/agent.ts",
        content:
          "export default defineAgent({ model: openrouter.chatModel('m/x') });",
      },
      store,
    );
    const check = vi.fn().mockResolvedValue({ ok: true });

    await publishDrafts(
      { project: PROJECT, paths: ["agent/agent.ts"] },
      store,
      vi.fn().mockResolvedValue(proposed),
      check,
    );

    const overlay = check.mock.calls[0][0].overlay as { path: string }[];
    expect(overlay.some((f) => f.path === "Dockerfile")).toBe(false);
  });

  it("keeps the lockfile when the published package.json matches the repo's", async () => {
    // A pinned eve: normalization leaves this package.json byte-identical to the repo's.
    // (A floating "latest" would be rewritten, which correctly stages the lock's deletion.)
    const repoPackage =
      JSON.stringify(
        {
          dependencies: {
            "@ai-sdk/anthropic": "^4.0.12",
            "@ai-sdk/openai": "^4.0.11",
            "@ai-sdk/openai-compatible": "^3.0.7",
            ai: "^7.0.0",
            eve: "^0.22.0",
            zod: "^4.4.3",
          },
        },
        null,
        2,
      ) + "\n";
    readAgentFileMock.mockImplementation(async (_inst, _repo, path) => {
      if (path === "package.json") return repoPackage;
      if (path === "package-lock.json") return '{"lockfileVersion": 3}';
      return null;
    });
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agent/agent.ts",
        content:
          "export default defineAgent({ model: openrouter.chatModel('m/x') });",
      },
      store,
    );
    const check = vi.fn().mockResolvedValue({ ok: true });

    await publishDrafts(
      { project: PROJECT, paths: ["agent/agent.ts"] },
      store,
      vi.fn().mockResolvedValue(proposed),
      check,
    );

    const overlay = check.mock.calls[0][0].overlay as {
      path: string;
      content: string | null;
    }[];
    expect(overlay.some((f) => f.path === "package-lock.json")).toBe(false);
    // The package overlay rides along (pre-existing behavior) but is byte-identical to the
    // repo's — which is exactly why the lock stays.
    expect(overlay.find((f) => f.path === "package.json")?.content).toBe(
      repoPackage,
    );
  });

  it("stages shared root files unattributed, and a mixed selection checks the repo root", async () => {
    // package.json is outside every member — staged with no owning agent (add_dependency).
    const shared = await stageDraft(
      { projectId: PROJECT.id, path: "package.json", content: "{}" },
      store,
    );
    expect(shared.agentId).toBeNull();
    const owned = await stageDraft(
      { projectId: PROJECT.id, path: "agent/tools/x.ts", content: "//" },
      store,
    );
    expect(owned.agentId).toBe("agent_1");

    // Mixed member + shared selection → no member root; the gate builds the repo root.
    const check = vi.fn().mockResolvedValue({ ok: true });
    await publishDrafts(
      { project: PROJECT, paths: ["package.json", "agent/tools/x.ts"] },
      store,
      vi.fn().mockResolvedValue(proposed),
      check,
    );
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ agentRoot: undefined }),
    );
  });

  it("attributes a team member's draft to that member (path root decides)", async () => {
    store.seedAgent({
      id: "agent_pm",
      projectId: PROJECT.id,
      name: "pm",
      root: "agents/pm/agent",
    });
    const draft = await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/pm/agent/tools/plan.ts",
        content: "//",
      },
      store,
    );
    expect(draft.agentId).toBe("agent_pm");
  });

  it("attributes the member's package directory to that member, not 'shared'", async () => {
    // agents/pm/package.json sits outside the agent/ root but is still pm's file. Staged
    // unattributed, it would ride along as a "shared" draft into publishes from other
    // members — dragging pm's build (and any breakage) into unrelated change-sets.
    store.seedAgent({
      id: "agent_pm",
      projectId: PROJECT.id,
      name: "pm",
      root: "agents/pm/agent",
    });
    const pkg = await stageDraft(
      { projectId: PROJECT.id, path: "agents/pm/package.json", content: "{}" },
      store,
    );
    expect(pkg.agentId).toBe("agent_pm");
  });

  it("checks a staged new team member against its inferred agent root", async () => {
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/deployer/agent/instructions.md",
        content: "# deployer",
      },
      store,
    );
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/deployer/package.json",
        content: "{}",
      },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "eden-lock.json", content: "{}" },
      store,
    );

    const check = vi.fn().mockResolvedValue({ ok: true });
    await publishDrafts(
      {
        project: PROJECT,
        paths: [
          "agents/deployer/agent/instructions.md",
          "agents/deployer/package.json",
          "eden-lock.json",
        ],
      },
      store,
      vi.fn().mockResolvedValue(proposed),
      check,
    );

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ agentRoot: "agents/deployer/agent" }),
    );
  });

  it("a multi-member selection checks every member root, not the repo root", async () => {
    store.seedAgent({
      id: "agent_pm",
      projectId: PROJECT.id,
      name: "pm",
      root: "agents/pm/agent",
    });
    store.seedAgent({
      id: "agent_reviewer",
      projectId: PROJECT.id,
      name: "reviewer",
      root: "agents/reviewer/agent",
    });
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/pm/agent/channels/github.ts",
        content: "//",
      },
      store,
    );
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/reviewer/agent/channels/github.ts",
        content: "//",
      },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "eden-lock.json", content: "{}" },
      store,
    );

    const check = vi.fn().mockResolvedValue({ ok: true });
    await publishDrafts(
      {
        project: PROJECT,
        paths: [
          "agents/pm/agent/channels/github.ts",
          "agents/reviewer/agent/channels/github.ts",
          "eden-lock.json",
        ],
      },
      store,
      vi.fn().mockResolvedValue(proposed),
      check,
    );

    const checkedRoots = check.mock.calls.map((c) => c[0].agentRoot).sort();
    expect(checkedRoots).toEqual(["agents/pm/agent", "agents/reviewer/agent"]);
    // Every check sees the full overlay; files outside its build dir are inert.
    for (const call of check.mock.calls) {
      expect(call[0].overlay).toHaveLength(3);
    }
  });

  it("streams an onStage label per member root with an (i/n) suffix, but none for a single root", async () => {
    // Single-root publish (the sole roster member): one label, NO (i/n) suffix.
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/a.md", content: "A" },
      store,
    );
    const singleStages: string[] = [];
    await publishDrafts(
      {
        project: PROJECT,
        paths: ["agent/a.md"],
        onStage: (s) => {
          singleStages.push(s);
        },
      },
      store,
      vi.fn().mockResolvedValue(proposed),
      vi.fn().mockResolvedValue({ ok: true }),
    );
    expect(singleStages).toEqual(["Checking the build for agent…"]);

    // Multi-root publish: one label per member root, each carrying (i/n).
    store.seedAgent({
      id: "agent_pm",
      projectId: PROJECT.id,
      name: "pm",
      root: "agents/pm/agent",
    });
    store.seedAgent({
      id: "agent_reviewer",
      projectId: PROJECT.id,
      name: "reviewer",
      root: "agents/reviewer/agent",
    });
    await stageDraft(
      { projectId: PROJECT.id, path: "agents/pm/agent/channels/github.ts", content: "//" },
      store,
    );
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/reviewer/agent/channels/github.ts",
        content: "//",
      },
      store,
    );
    const multiStages: string[] = [];
    await publishDrafts(
      {
        project: PROJECT,
        paths: [
          "agents/pm/agent/channels/github.ts",
          "agents/reviewer/agent/channels/github.ts",
        ],
        onStage: (s) => {
          multiStages.push(s);
        },
      },
      store,
      vi.fn().mockResolvedValue(proposed),
      vi.fn().mockResolvedValue({ ok: true }),
    );
    expect(multiStages.some((s) => s.includes("(1/2)"))).toBe(true);
    expect(multiStages.some((s) => s.includes("(2/2)"))).toBe(true);
    expect(multiStages).toHaveLength(2);
  });

  it("names the failing member when a multi-member publish is blocked", async () => {
    store.seedAgent({
      id: "agent_pm",
      projectId: PROJECT.id,
      name: "pm",
      root: "agents/pm/agent",
    });
    store.seedAgent({
      id: "agent_reviewer",
      projectId: PROJECT.id,
      name: "reviewer",
      root: "agents/reviewer/agent",
    });
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/pm/agent/channels/github.ts",
        content: "//",
      },
      store,
    );
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/reviewer/agent/channels/github.ts",
        content: "bad",
      },
      store,
    );

    const propose = vi.fn().mockResolvedValue(proposed);
    const check = vi
      .fn()
      .mockImplementation(({ agentRoot }) =>
        agentRoot === "agents/reviewer/agent"
          ? { ok: false, output: "TS2304: Cannot find name 'bad'." }
          : { ok: true },
      );

    await expect(
      publishDrafts(
        {
          project: PROJECT,
          paths: [
            "agents/pm/agent/channels/github.ts",
            "agents/reviewer/agent/channels/github.ts",
          ],
        },
        store,
        propose,
        check,
      ),
    ).rejects.toThrow(/Build check failed for `agents\/reviewer\/agent`/);
    expect(propose).not.toHaveBeenCalled();
  });

  it("a skipped check (no toolchain) still publishes", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: "agent/a.md", content: "A" },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    const change = await publishDrafts(
      { project: PROJECT, paths: ["agent/a.md"] },
      store,
      propose,
      vi.fn().mockResolvedValue({ ok: true, skipped: true }),
    );
    expect(change.pullRequestNumber).toBe(7);
  });
});

describe("orphaned drafts (issue #67)", () => {
  it("blocks an orphaned lone package.json belonging to a deleted member", async () => {
    // A team whose roster no longer has cloudflare-dev, but a stale package.json draft lingers.
    store.seedAgent({
      id: "agent_engineer",
      projectId: PROJECT.id,
      name: "engineer",
      root: "agents/engineer/agent",
    });
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/cloudflare-dev/package.json",
        content: "{}",
      },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    const check = vi.fn().mockResolvedValue({ ok: true });
    const listRepoPaths = vi.fn().mockResolvedValue([]);

    await expect(
      publishDrafts(
        { project: PROJECT, paths: ["agents/cloudflare-dev/package.json"] },
        store,
        propose,
        check,
        listRepoPaths,
      ),
    ).rejects.toThrow(/no longer part of this team/);

    // No build, no PR — and the draft stays staged so the user can discard it.
    expect(check).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(await listDrafts(PROJECT.id, store)).toHaveLength(1);
  });

  it("does not flag a genuine new-member install (agent-dir draft backs the root)", async () => {
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/deployer/agent/instructions.md",
        content: "# deployer",
      },
      store,
    );
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/deployer/package.json",
        content: "{}",
      },
      store,
    );
    await stageDraft(
      { projectId: PROJECT.id, path: "eden-lock.json", content: "{}" },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    const check = vi.fn().mockResolvedValue({ ok: true });
    const listRepoPaths = vi.fn().mockResolvedValue([]);

    await publishDrafts(
      {
        project: PROJECT,
        paths: [
          "agents/deployer/agent/instructions.md",
          "agents/deployer/package.json",
          "eden-lock.json",
        ],
      },
      store,
      propose,
      check,
      listRepoPaths,
    );

    expect(check).toHaveBeenCalled(); // reaches the build gate, not blocked as orphaned
    expect(propose).toHaveBeenCalledOnce();
  });

  it("does not flag a member absent from a stale roster but present in the repo tree", async () => {
    await stageDraft(
      {
        projectId: PROJECT.id,
        path: "agents/analyst/package.json",
        content: "{}",
      },
      store,
    );
    const propose = vi.fn().mockResolvedValue(proposed);
    const check = vi.fn().mockResolvedValue({ ok: true });
    // The repo already has analyst's agent code — the roster is merely stale.
    const listRepoPaths = vi
      .fn()
      .mockResolvedValue([
        "agents/analyst/agent/agent.ts",
        "agents/analyst/package.json",
      ]);

    await publishDrafts(
      { project: PROJECT, paths: ["agents/analyst/package.json"] },
      store,
      propose,
      check,
      listRepoPaths,
    );

    expect(propose).toHaveBeenCalledOnce();
  });
});

describe("findOrphanedDrafts (pure)", () => {
  const draft = (path: string, content: string | null = "x"): DraftChange => ({
    id: "d",
    projectId: "p",
    agentId: null,
    path,
    content,
    baseSha: null,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  it("flags a lone package.json with no roster, repo, or sibling backing", () => {
    const d = draft("agents/cloudflare-dev/package.json", "{}");
    expect(findOrphanedDrafts([], [], [d])).toEqual([d]);
  });

  it("is empty when the member is in the roster", () => {
    const d = draft("agents/cloudflare-dev/package.json", "{}");
    expect(
      findOrphanedDrafts([{ root: "agents/cloudflare-dev/agent" }], [], [d]),
    ).toEqual([]);
  });

  it("is empty when the repo tree backs the member", () => {
    const d = draft("agents/analyst/package.json", "{}");
    expect(
      findOrphanedDrafts([], ["agents/analyst/agent/agent.ts"], [d]),
    ).toEqual([]);
  });

  it("is empty when a sibling agent-dir draft (re)creates the member", () => {
    const pkg = draft("agents/x/package.json", "{}");
    const code = draft("agents/x/agent/agent.ts", "//");
    expect(findOrphanedDrafts([], [], [pkg, code])).toEqual([]);
  });

  it("never flags non-member paths (agent/, root package.json, lock, .eden)", () => {
    const drafts = [
      draft("agent/agent.ts"),
      draft("package.json", "{}"),
      draft("eden-lock.json", "{}"),
      draft(".eden/assistant/instructions.md"),
    ];
    expect(findOrphanedDrafts([], [], drafts)).toEqual([]);
  });
});

describe("resolveFileView", () => {
  const PATH = "agent/agent.ts";
  /** GitHub fakes: repo (default branch) content + one open change touching PATH. */
  function deps({
    repoContent = "repo",
    pendingContent = "pending",
    pending = true,
  }: {
    repoContent?: string | null;
    pendingContent?: string | null;
    pending?: boolean;
  } = {}): FileViewDeps {
    return {
      readFile: vi.fn(async (_inst, repo: { ref?: string }) =>
        repo.ref === "eden/publish-x" ? pendingContent : repoContent,
      ) as FileViewDeps["readFile"],
      findOpenChange: vi.fn(async () =>
        pending
          ? {
              number: 7,
              title: "Update agent files",
              branch: "eden/publish-x",
              url: "u",
            }
          : null,
      ) as FileViewDeps["findOpenChange"],
    };
  }

  it("a staged draft wins over everything (it's the newest edit)", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: PATH, content: "draft" },
      store,
    );
    const view = await resolveFileView(PROJECT, PATH, store, deps());
    expect(view).toMatchObject({
      content: "draft",
      source: "draft",
      existsInRepo: true,
    });
  });

  it("a staged DELETION shows the repo content flagged as stagedDeletion", async () => {
    await stageDeletions({ projectId: PROJECT.id, paths: [PATH] }, store);
    const view = await resolveFileView(PROJECT, PATH, store, deps());
    expect(view).toMatchObject({
      content: "repo",
      source: "draft",
      existsInRepo: true,
      stagedDeletion: true,
    });
  });

  it("with no draft, shows the pending value from the open change request", async () => {
    const view = await resolveFileView(PROJECT, PATH, store, deps());
    expect(view).toMatchObject({
      content: "pending",
      source: "change-request",
      change: { number: 7, title: "Update agent files" },
    });
  });

  it("falls back to repo content when nothing is staged or pending", async () => {
    const view = await resolveFileView(
      PROJECT,
      PATH,
      store,
      deps({ pending: false }),
    );
    expect(view).toMatchObject({
      content: "repo",
      source: "repo",
      change: null,
    });
  });

  it("a change request that ADDS the file still resolves (repo has nothing)", async () => {
    const view = await resolveFileView(
      PROJECT,
      PATH,
      store,
      deps({ repoContent: null }),
    );
    expect(view).toMatchObject({
      content: "pending",
      source: "change-request",
      existsInRepo: false,
    });
  });
});
