/**
 * Saved drafts (PRD §7.3, issue #225) — against the in-memory store (no DB, no GitHub).
 * Pins the save contract (save = upsert per path, refresh-proof; discard is path-exact;
 * deletions are null-content drafts), member attribution, the pure orphan detector and
 * build-root inference the publish pipeline runs on, the OpenRouter coherence pass
 * (normalizeOpenRouterPackageDrafts), and resolveFileView's draft-over-repo precedence.
 * The pipeline itself is covered in publish-pipeline.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  discardDrafts,
  findOrphanedDrafts,
  getDraft,
  inferBuildRoots,
  listDrafts,
  normalizeOpenRouterPackageDrafts,
  resolveFileView,
  stageDeletions,
  stageDraft,
  type FileViewDeps,
} from "~/drafts/drafts.server";
import type { DraftChange } from "~/data/ports";
import { readAgentFile } from "~/github/repo.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

// The coherence pass reads repo files (package.json / package-lock.json / Dockerfile) to
// detect a stale lockfile — stub the GitHub read so no test touches the network.
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

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT.id, orgId: "org_1" });
  // Drafts key by roster member (Milestone 5.5) — a single-agent repo is a team of one.
  store.seedAgent({ id: "agent_1", projectId: PROJECT.id });
  readAgentFileMock.mockReset();
  readAgentFileMock.mockResolvedValue(null);
});

describe("saving", () => {
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

  it("saves shared root files unattributed", async () => {
    // package.json is outside every member — saved with no owning agent (add_dependency).
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
    // agents/pm/package.json sits outside the agent/ root but is still pm's file. Saved
    // unattributed, it would render as a "shared" change in the publish panel and drag pm's
    // build concerns into what looks like an everyone-file.
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
});

describe("deletion drafts", () => {
  it("stageDeletions rides null-content drafts alongside edits (one change-set)", async () => {
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

  it("a deletion supersedes a saved edit on the same path", async () => {
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
});

describe("inferBuildRoots", () => {
  const draft = (
    path: string,
    agentId: string | null = null,
    content: string | null = "x",
  ): DraftChange => ({
    id: "d",
    projectId: "p",
    agentId,
    path,
    content,
    baseSha: null,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const AGENTS = [
    { id: "agent_1", root: "agent" },
    { id: "agent_pm", root: "agents/pm/agent" },
  ];

  it("maps a member's drafts to its root via the agent row", () => {
    expect(
      inferBuildRoots(AGENTS, [draft("agent/tools/x.ts", "agent_1")]),
    ).toEqual(["agent"]);
  });

  it("a multi-member set yields every member root", () => {
    expect(
      inferBuildRoots(AGENTS, [
        draft("agent/tools/x.ts", "agent_1"),
        draft("agents/pm/agent/tools/plan.ts", "agent_pm"),
      ]),
    ).toEqual(["agent", "agents/pm/agent"]);
  });

  it("infers the root of a saved NEW member from its path (no agent row yet)", () => {
    expect(
      inferBuildRoots(AGENTS, [
        draft("agents/deployer/agent/instructions.md"),
        draft("agents/deployer/package.json"),
      ]),
    ).toEqual(["agents/deployer/agent"]);
  });

  it("a truly shared file forces the repo-root build (undefined)", () => {
    expect(
      inferBuildRoots(AGENTS, [
        draft("package.json"),
        draft("agent/tools/x.ts", "agent_1"),
      ]),
    ).toBeUndefined();
  });

  it("repo-level harnesst metadata never forces a repo-root build", () => {
    // harnesst-lock.json (marketplace provenance) and the team-layout marker README (saved by a
    // remove-member) ride along without widening the build.
    expect(
      inferBuildRoots(AGENTS, [
        draft("harnesst-lock.json"),
        draft("agents/README.md"),
        draft("agents/pm/agent/tools/plan.ts", "agent_pm"),
      ]),
    ).toEqual(["agents/pm/agent"]);
  });
});

describe("normalizeOpenRouterPackageDrafts (coherence pass)", () => {
  const normalize = (files: { path: string; content: string | null }[]) =>
    normalizeOpenRouterPackageDrafts({ project: PROJECT, files });

  it("normalizes stale OpenRouter package drafts in place", async () => {
    const files = await normalize([
      {
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
    ]);
    const pkg = files.find((f) => f.path === "package.json");
    expect(JSON.parse(pkg!.content!).dependencies).toEqual({
      "@ai-sdk/anthropic": "^4.0.12",
      "@ai-sdk/openai": "^4.0.11",
      "@ai-sdk/openai-compatible": "^3.0.7",
      ai: "^7.0.0",
      // "latest" gets pinned: the docker layer cache would keep serving whatever
      // version the first image build installed (see ensureModelProviderDependencies).
      eve: "^0.22.0",
      zod: "^4.4.3",
    });
  });

  it("adds the member's package overlay when a provider-routed subagent is published alone", async () => {
    // A wired subagent module compiles in its member's build and imports the provider package —
    // without the member package.json overlay the build would fail on the missing dependency.
    readAgentFileMock.mockImplementation(async (_inst, _repo, path) =>
      path === "package.json"
        ? JSON.stringify({ dependencies: { eve: "^0.22.0" } }, null, 2) + "\n"
        : null,
    );
    const files = await normalize([
      {
        path: "agent/subagents/reader/agent.ts",
        content: `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";\nimport { defineAgent } from "eve";\nconst openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY ?? "" });\nexport default defineAgent({ description: "Reader.", model: openrouter.chatModel("z-ai/glm-5.2") });\n`,
      },
    ]);
    const pkg = files.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    expect(
      JSON.parse(pkg!.content!).dependencies["@ai-sdk/openai-compatible"],
    ).toBe("^3.0.7");
  });

  it("saves the stale package-lock.json for deletion when a dependency rewrite changes package.json", async () => {
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
    // build would hard-fail on the rewritten package.json.
    readAgentFileMock.mockImplementation(async (_inst, _repo, path) => {
      if (path === "package.json") return repoPackage;
      if (path === "package-lock.json") return '{"lockfileVersion": 3}';
      return null;
    });
    const files = await normalize([
      {
        path: "agent/agent.ts",
        content:
          "export default defineAgent({ model: openrouter.chatModel('m/x') });",
      },
    ]);
    expect(files.find((f) => f.path === "package-lock.json")).toEqual({
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
    const staleDockerfile = `# harnesst reference image for an eve agent (mirrors LocalDockerTarget.build()).
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
    const files = await normalize([
      {
        path: "agent/agent.ts",
        content:
          "export default defineAgent({ model: openrouter.chatModel('m/x') });",
      },
    ]);
    const dockerfile = files.find((f) => f.path === "Dockerfile");
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
    const files = await normalize([
      {
        path: "agent/agent.ts",
        content:
          "export default defineAgent({ model: openrouter.chatModel('m/x') });",
      },
    ]);
    expect(files.some((f) => f.path === "Dockerfile")).toBe(false);
  });

  it("keeps the lockfile when the normalized package.json matches the repo's", async () => {
    // A pinned eve: normalization leaves this package.json byte-identical to the repo's.
    // (A floating "latest" would be rewritten, which correctly saves the lock's deletion.)
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
    const files = await normalize([
      {
        path: "agent/agent.ts",
        content:
          "export default defineAgent({ model: openrouter.chatModel('m/x') });",
      },
    ]);
    expect(files.some((f) => f.path === "package-lock.json")).toBe(false);
    // The package overlay rides along (pre-existing behavior) but is byte-identical to the
    // repo's — which is exactly why the lock stays.
    expect(files.find((f) => f.path === "package.json")?.content).toBe(
      repoPackage,
    );
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

  it("never flags non-member paths (agent/, root package.json, lock, .harnesst)", () => {
    const drafts = [
      draft("agent/agent.ts"),
      draft("package.json", "{}"),
      draft("harnesst-lock.json", "{}"),
      draft(".harnesst/assistant/instructions.md"),
    ];
    expect(findOrphanedDrafts([], [], drafts)).toEqual([]);
  });
});

describe("resolveFileView", () => {
  const PATH = "agent/agent.ts";
  /** GitHub fake: the repo (default branch) content. */
  function deps({
    repoContent = "repo",
  }: { repoContent?: string | null } = {}): FileViewDeps {
    return {
      readFile: vi.fn(async () => repoContent) as FileViewDeps["readFile"],
    };
  }

  it("a saved draft wins over the repo (it's the newest edit)", async () => {
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

  it("a saved DELETION shows the repo content flagged as stagedDeletion", async () => {
    await stageDeletions({ projectId: PROJECT.id, paths: [PATH] }, store);
    const view = await resolveFileView(PROJECT, PATH, store, deps());
    expect(view).toMatchObject({
      content: "repo",
      source: "draft",
      existsInRepo: true,
      stagedDeletion: true,
    });
  });

  it("falls back to repo content when nothing is saved", async () => {
    const view = await resolveFileView(PROJECT, PATH, store, deps());
    expect(view).toMatchObject({ content: "repo", source: "repo" });
  });

  it("a draft that ADDS the file still resolves (repo has nothing)", async () => {
    await stageDraft(
      { projectId: PROJECT.id, path: PATH, content: "new" },
      store,
    );
    const view = await resolveFileView(
      PROJECT,
      PATH,
      store,
      deps({ repoContent: null }),
    );
    expect(view).toMatchObject({
      content: "new",
      source: "draft",
      existsInRepo: false,
    });
  });
});
