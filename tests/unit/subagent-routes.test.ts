/**
 * Nested-target route behavior (issue #344): the capability gate, path confinement and the
 * subagent-creation flow, exercised through the real loaders/actions.
 *
 * These are the rules that must hold at the ROUTE boundary, not just in the helpers:
 *  - a root-only category (channels, schedules) is a 404 at a subagent target in the LOADER AND
 *    THE ACTION — a category that isn't offered must not be a write surface either;
 *  - every path a route accepts is confined to the target the URL names, so a crafted `?path=` /
 *    form path cannot reach a sibling member's or a sibling subagent's tree;
 *  - creating a subagent stages a directory scaffold whose resolver call names its own target,
 *    and lands on the new nested context;
 *  - deleting a subagent saves a deletion for every file beneath it at any depth, the row stays
 *    visible and undoable until the publish lands, and undo puts every file back in one action;
 *  - a crafted request — a subagent URL hung off the wrong member, an unknown member, a posted
 *    `agent` field — is refused rather than answered from another member's tree.
 *
 * Same seam mocking as `connection-routes.test.ts`: hoisted mock bag, fake data store behind
 * `getRuntime`, GitHub reads stubbed, dynamic import after `vi.resetModules()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeStore, type FakeStore } from "../fakes/store";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-owner", email: "owner@example.com" },
    session: { id: "session-owner" },
    organizationId: "o1",
    requestHeaders: new Headers(),
  },
  discardDrafts: vi.fn(),
  fetchAgentSource: vi.fn(),
  getAgentSource: vi.fn(),
  getLastCommitForPaths: vi.fn(),
  listDrafts: vi.fn(),
  readAgentFile: vi.fn(),
  requireProject: vi.fn(),
  resolveFileView: vi.fn(),
  stageDeletions: vi.fn(),
  stageDraft: vi.fn(),
  store: { current: null as FakeStore | null },
}));

vi.mock("~/auth/session.server", () => ({
  sessionLoader: async (
    _args: unknown,
    callback: (input: { auth: typeof mocks.auth }) => Promise<object>,
  ) => callback({ auth: mocks.auth }),
  getSessionAuth: async () => mocks.auth,
}));

vi.mock("~/drafts/drafts.server", () => ({
  discardDrafts: mocks.discardDrafts,
  listDrafts: mocks.listDrafts,
  resolveFileView: mocks.resolveFileView,
  stageDeletions: mocks.stageDeletions,
  stageDraft: mocks.stageDraft,
}));

vi.mock("~/github/cached.server", () => ({
  getAgentSource: mocks.getAgentSource,
  getLastCommitForPaths: mocks.getLastCommitForPaths,
}));

vi.mock("~/github/repo.server", () => ({
  fetchAgentSource: mocks.fetchAgentSource,
  readAgentFile: mocks.readAgentFile,
}));

// Only the project guards are stubbed — `normalizeAgentPath`/`confineToRoot` are the code under
// test here, so the real implementations stay in place.
vi.mock("~/project/guard.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/project/guard.server")>()),
  requireProject: mocks.requireProject,
  requireRepo: (project: unknown) => project,
}));

vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: mocks.store.current }),
}));

const PROJECT = {
  id: "p1",
  orgId: "o1",
  name: "example",
  layout: "team",
  repoInstallationId: "1234",
  repoOwner: "zero8ai",
  repoName: "example",
};

const IVY_ROOT = "agents/ivy/agent";
const RESEARCHER_ROOT = `${IVY_ROOT}/subagents/researcher`;

const PATHS = [
  `${IVY_ROOT}/agent.ts`,
  `${IVY_ROOT}/instructions.md`,
  `${IVY_ROOT}/tools/search.ts`,
  `${IVY_ROOT}/channels/http.ts`,
  `${RESEARCHER_ROOT}/agent.ts`,
  `${RESEARCHER_ROOT}/instructions.md`,
  `${RESEARCHER_ROOT}/tools/cite.ts`,
  // A subagent of the subagent — the deletion of `researcher` has to take it with it.
  `${RESEARCHER_ROOT}/subagents/citer/agent.ts`,
  `${RESEARCHER_ROOT}/subagents/citer/instructions.md`,
  "agents/sam/agent/agent.ts",
  "agents/sam/agent/tools/secret.ts",
];

/** Every repo file under `researcher/`, i.e. what deleting that one row has to cover. */
const RESEARCHER_FILES = PATHS.filter((p) => p.startsWith(`${RESEARCHER_ROOT}/`));

const FILES: Record<string, string> = {
  [`${IVY_ROOT}/agent.ts`]:
    "import { harnesstAgentModel } from '../harnesst/model.js';\nexport default defineAgent({ model: harnesstAgentModel('ivy') });\n",
  [`${RESEARCHER_ROOT}/agent.ts`]:
    "import { harnesstAgentModel } from '../../../harnesst/model.js';\nexport default defineAgent({ model: harnesstAgentModel('ivy', 'researcher') });\n",
};

function routeArgs<P extends Record<string, string>>(
  url: string,
  params: P = {} as P,
) {
  const request = new Request(url);
  return {
    request,
    url: new URL(url),
    pattern: new URL(url).pathname,
    params,
    context: {} as never,
  };
}

function formArgs<P extends Record<string, string>>(
  url: string,
  params: P,
  fields: Record<string, string>,
) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return {
    request: new Request(url, { method: "POST", body }),
    url: new URL(url),
    pattern: new URL(url).pathname,
    params,
    context: {} as never,
  };
}

/** The Response a loader/action throws (redirect or `data()` error), for status assertions. */
async function thrownFrom(operation: unknown): Promise<Response> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Response) return error;
    const init = (error as { init?: ResponseInit }).init;
    if (init) return new Response(null, init);
    throw error;
  }
  throw new Error("expected the route to throw");
}

function reset(drafts: { path: string; content: string | null }[] = []) {
  vi.resetModules();
  const store = makeFakeStore();
  store.seedProject({ id: "p1", orgId: "o1", layout: "team" });
  store.seedAgent({ id: "a-ivy", projectId: "p1", name: "ivy", root: IVY_ROOT });
  store.seedAgent({
    id: "a-sam",
    projectId: "p1",
    name: "sam",
    root: "agents/sam/agent",
  });
  mocks.store.current = store;
  const source = { paths: PATHS, files: FILES };
  mocks.discardDrafts.mockReset().mockResolvedValue(undefined);
  mocks.fetchAgentSource.mockReset().mockResolvedValue(source);
  mocks.getAgentSource.mockReset().mockResolvedValue(source);
  mocks.getLastCommitForPaths.mockReset().mockResolvedValue({});
  mocks.listDrafts.mockReset().mockResolvedValue(
    drafts.map((d, i) => ({
      id: `d${i}`,
      projectId: "p1",
      path: d.path,
      content: d.content,
    })),
  );
  mocks.readAgentFile.mockReset().mockResolvedValue(null);
  mocks.requireProject.mockReset().mockResolvedValue(PROJECT);
  mocks.resolveFileView.mockReset().mockResolvedValue({
    content: null,
    existsInRepo: false,
    source: "none",
    stagedDeletion: false,
  });
  mocks.stageDeletions.mockReset().mockResolvedValue(undefined);
  mocks.stageDraft.mockReset().mockResolvedValue(undefined);
}

const categoryRoute = () =>
  import("~/routes/projects.$projectId.resources.$category");
const editRoute = () => import("~/routes/projects.$projectId.edit");

describe("capability matrix at the route boundary", () => {
  beforeEach(() => reset());

  it("404s a root-only category at a subagent target, in the loader", async () => {
    const { loader } = await categoryRoute();
    const response = await thrownFrom(
      loader(
        routeArgs(
          "https://h.example.com/repos/p1/agents/ivy/sub/researcher/resources/channels",
          { projectId: "p1", agentName: "ivy", subPath: "researcher", category: "channels" },
        ),
      ),
    );
    expect(response.status).toBe(404);
  });

  it("404s a root-only category at a subagent target, in the ACTION too", async () => {
    const { action } = await categoryRoute();
    const response = await thrownFrom(
      action(
        formArgs(
          "https://h.example.com/repos/p1/agents/ivy/sub/researcher/resources/schedules",
          { projectId: "p1", agentName: "ivy", subPath: "researcher", category: "schedules" },
          { intent: "delete-resource", path: `${IVY_ROOT}/schedules/daily.md` },
        ),
      ),
    );
    expect(response.status).toBe(404);
  });

  it("serves the same root-only category at the member target", async () => {
    const { loader } = await categoryRoute();
    const view = await loader(
      routeArgs(
        "https://h.example.com/repos/p1/agents/ivy/resources/channels",
        { projectId: "p1", agentName: "ivy", category: "channels" },
      ),
    );
    expect(view.category.key).toBe("channels");
    expect(view.rows.map((r) => r.name)).toContain("http");
  });

  it("serves hooks at BOTH depths — an any-scope category is a real surface for a subagent", async () => {
    const { loader } = await categoryRoute();
    for (const [url, params] of [
      [
        "https://h.example.com/repos/p1/agents/ivy/resources/hooks",
        { projectId: "p1", agentName: "ivy", category: "hooks" },
      ],
      [
        "https://h.example.com/repos/p1/agents/ivy/sub/researcher/resources/hooks",
        { projectId: "p1", agentName: "ivy", subPath: "researcher", category: "hooks" },
      ],
    ] as const) {
      const view = await loader(routeArgs(url, params));
      expect(view.category).toEqual({ key: "hooks", label: "Hooks" });
    }
  });

  it("lists a nested target's own resources, rooted at the subagent", async () => {
    const { loader } = await categoryRoute();
    const view = await loader(
      routeArgs(
        "https://h.example.com/repos/p1/agents/ivy/sub/researcher/resources/tools",
        { projectId: "p1", agentName: "ivy", subPath: "researcher", category: "tools" },
      ),
    );
    expect(view.activeRoot).toBe(RESEARCHER_ROOT);
    expect(view.subagentPath).toEqual(["researcher"]);
    expect(view.rows.map((r) => r.path)).toEqual([`${RESEARCHER_ROOT}/tools/cite.ts`]);
  });
});

describe("subagent rows", () => {
  it("groups a draft-only subagent into one saved-new directory row", async () => {
    reset([
      { path: `${IVY_ROOT}/subagents/scout/agent.ts`, content: "export default {}" },
      { path: `${IVY_ROOT}/subagents/scout/instructions.md`, content: "# scout" },
    ]);
    const { loader } = await categoryRoute();
    const view = await loader(
      routeArgs("https://h.example.com/repos/p1/agents/ivy/resources/subagents", {
        projectId: "p1",
        agentName: "ivy",
        category: "subagents",
      }),
    );
    const scout = view.rows.find((r) => r.name === "scout");
    expect(scout).toMatchObject({ isDirectory: true, staged: true, inRepo: false });
    // …and never as a bare `agent.ts` file row.
    expect(view.rows.map((r) => r.name)).not.toContain("agent.ts");
  });

  it("marks the published subagent as in-repo, not saved", async () => {
    reset();
    const { loader } = await categoryRoute();
    const view = await loader(
      routeArgs("https://h.example.com/repos/p1/agents/ivy/resources/subagents", {
        projectId: "p1",
        agentName: "ivy",
        category: "subagents",
      }),
    );
    expect(view.rows).toEqual([
      expect.objectContaining({
        name: "researcher",
        isDirectory: true,
        inRepo: true,
        staged: false,
      }),
    ]);
  });
});

describe("create-subagent", () => {
  beforeEach(() => reset());

  it("scaffolds the directory under the member and lands on the nested context", async () => {
    const { action } = await categoryRoute();
    const response = await thrownFrom(
      action(
        formArgs(
          "https://h.example.com/repos/p1/agents/ivy/resources/subagents",
          { projectId: "p1", agentName: "ivy", category: "subagents" },
          { intent: "create-subagent", name: "Deep Scout" },
        ),
      ),
    );
    expect(response.headers.get("location")).toBe(
      "/repos/p1/agents/ivy/sub/deep-scout",
    );
    const staged = Object.fromEntries(
      mocks.stageDraft.mock.calls.map(([input]) => [input.path, input.content]),
    );
    expect(Object.keys(staged).sort()).toEqual([
      `${IVY_ROOT}/subagents/deep-scout/agent.ts`,
      `${IVY_ROOT}/subagents/deep-scout/instructions.md`,
    ]);
    // The resolver call names the PARENT's identity plus this subagent's own path, and the
    // import climbs the two directories `subagents/<name>/` adds.
    expect(staged[`${IVY_ROOT}/subagents/deep-scout/agent.ts`]).toContain(
      "harnesstAgentModel('ivy', 'deep-scout')",
    );
    expect(staged[`${IVY_ROOT}/subagents/deep-scout/agent.ts`]).toContain(
      "'../../../harnesst/model.js'",
    );
  });

  it("nests under the addressed subagent at depth, with the full chain in the resolver call", async () => {
    const { action } = await categoryRoute();
    const response = await thrownFrom(
      action(
        formArgs(
          "https://h.example.com/repos/p1/agents/ivy/sub/researcher/resources/subagents",
          { projectId: "p1", agentName: "ivy", subPath: "researcher", category: "subagents" },
          { intent: "create-subagent", name: "cite-checker" },
        ),
      ),
    );
    expect(response.headers.get("location")).toBe(
      "/repos/p1/agents/ivy/sub/researcher~cite-checker",
    );
    const agentModule = mocks.stageDraft.mock.calls
      .map(([input]) => input)
      .find((input) => input.path.endsWith("cite-checker/agent.ts"));
    expect(agentModule.path).toBe(`${RESEARCHER_ROOT}/subagents/cite-checker/agent.ts`);
    expect(agentModule.content).toContain(
      "harnesstAgentModel('ivy', 'researcher/cite-checker')",
    );
  });

  it("refuses a name that already exists and stages nothing", async () => {
    const { action } = await categoryRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/resources/subagents",
        { projectId: "p1", agentName: "ivy", category: "subagents" },
        { intent: "create-subagent", name: "researcher" },
      ),
    );
    expect(result).toEqual({ error: "A subagent named researcher already exists." });
    expect(mocks.stageDraft).not.toHaveBeenCalled();
  });
});

describe("path confinement", () => {
  beforeEach(() => reset());

  it("refuses a deletion aimed at another member's tree", async () => {
    const { action } = await categoryRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/resources/tools",
        { projectId: "p1", agentName: "ivy", category: "tools" },
        { intent: "delete-resource", path: "agents/sam/agent/tools/secret.ts" },
      ),
    );
    expect(result).toEqual({ error: "Invalid resource path." });
    expect(mocks.stageDeletions).not.toHaveBeenCalled();
  });

  it("refuses a deletion that escapes the nested target into its parent", async () => {
    const { action } = await categoryRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/sub/researcher/resources/tools",
        { projectId: "p1", agentName: "ivy", subPath: "researcher", category: "tools" },
        { intent: "delete-resource", path: `${IVY_ROOT}/tools/search.ts` },
      ),
    );
    expect(result).toEqual({ error: "Invalid resource path." });
  });

  it("stages the deletion when the path really is the target's", async () => {
    const { action } = await categoryRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/sub/researcher/resources/tools",
        { projectId: "p1", agentName: "ivy", subPath: "researcher", category: "tools" },
        { intent: "delete-resource", path: `${RESEARCHER_ROOT}/tools/cite.ts` },
      ),
    );
    expect(result).toEqual({ ok: true, staged: "cite.ts" });
    expect(mocks.stageDeletions).toHaveBeenCalledWith(
      expect.objectContaining({ paths: [`${RESEARCHER_ROOT}/tools/cite.ts`] }),
    );
  });

  it("refuses an editor save aimed at another member's file", async () => {
    const { action } = await editRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/edit",
        { projectId: "p1", agentName: "ivy" },
        { path: "agents/sam/agent/tools/secret.ts", content: "// pwned" },
      ),
    );
    expect(result).toEqual({ error: "That file is outside this agent." });
    expect(mocks.stageDraft).not.toHaveBeenCalled();
  });

  it("refuses an editor save aimed at a sibling subagent", async () => {
    const { action } = await editRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/sub/researcher/edit",
        { projectId: "p1", agentName: "ivy", subPath: "researcher" },
        { path: `${IVY_ROOT}/tools/search.ts`, content: "// pwned" },
      ),
    );
    expect(result).toEqual({ error: "That file is outside this agent." });
  });

  it("saves a file that belongs to the addressed subagent", async () => {
    const { action } = await editRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/sub/researcher/edit",
        { projectId: "p1", agentName: "ivy", subPath: "researcher" },
        { path: `${RESEARCHER_ROOT}/tools/cite.ts`, content: "// ok" },
      ),
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.stageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${RESEARCHER_ROOT}/tools/cite.ts` }),
    );
  });

  it("403s the editor loader on a cross-target path instead of quietly editing it", async () => {
    const { loader } = await editRoute();
    const response = await thrownFrom(
      loader(
        routeArgs(
          `https://h.example.com/repos/p1/agents/ivy/edit?path=${encodeURIComponent("agents/sam/agent/tools/secret.ts")}`,
          { projectId: "p1", agentName: "ivy" },
        ),
      ),
    );
    expect(response.status).toBe(403);
  });
});

describe("subagent subtree deletion", () => {
  it("saves a deletion for every file under the subagent, at any depth", async () => {
    reset();
    const { action } = await categoryRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/resources/subagents",
        { projectId: "p1", agentName: "ivy", category: "subagents" },
        { intent: "delete-resource", path: `${IVY_ROOT}/subagents/researcher` },
      ),
    );
    expect(result).toEqual({ ok: true, staged: "researcher" });
    const [staged] = mocks.stageDeletions.mock.calls[0];
    expect([...staged.paths].sort()).toEqual([...RESEARCHER_FILES].sort());
    // Nothing outside the subtree is touched — the member's own files survive.
    expect(staged.paths).not.toContain(`${IVY_ROOT}/agent.ts`);
  });

  it("deletes a nested subagent from its parent's own subagents page", async () => {
    reset();
    const { action } = await categoryRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/sub/researcher/resources/subagents",
        { projectId: "p1", agentName: "ivy", subPath: "researcher", category: "subagents" },
        { intent: "delete-resource", path: `${RESEARCHER_ROOT}/subagents/citer` },
      ),
    );
    expect(result).toEqual({ ok: true, staged: "citer" });
    expect(mocks.stageDeletions.mock.calls[0][0].paths.sort()).toEqual([
      `${RESEARCHER_ROOT}/subagents/citer/agent.ts`,
      `${RESEARCHER_ROOT}/subagents/citer/instructions.md`,
    ]);
  });

  it("undoes the whole subtree deletion in one go", async () => {
    // The state after the deletion above: one null-content draft per file.
    reset(RESEARCHER_FILES.map((path) => ({ path, content: null })));
    const { action } = await categoryRoute();
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/resources/subagents",
        { projectId: "p1", agentName: "ivy", category: "subagents" },
        { intent: "undo-delete", path: `${IVY_ROOT}/subagents/researcher` },
      ),
    );
    expect(result).toEqual({ ok: true, restored: "researcher" });
    const [projectId, discarded] = mocks.discardDrafts.mock.calls[0];
    expect(projectId).toBe("p1");
    expect([...discarded].sort()).toEqual([...RESEARCHER_FILES].sort());
    // Undo never stages anything new — it only removes the deletion drafts.
    expect(mocks.stageDeletions).not.toHaveBeenCalled();
  });

  it("shows the pending deletion on the row until it is published", async () => {
    reset(RESEARCHER_FILES.map((path) => ({ path, content: null })));
    const { loader } = await categoryRoute();
    const view = await loader(
      routeArgs("https://h.example.com/repos/p1/agents/ivy/resources/subagents", {
        projectId: "p1",
        agentName: "ivy",
        category: "subagents",
      }),
    );
    expect(view.rows).toEqual([
      expect.objectContaining({
        name: "researcher",
        stagedDelete: true,
        inRepo: true,
      }),
    ]);
  });
});

describe("crafted requests against the nested routes", () => {
  beforeEach(() => reset());

  it("404s a subagent URL hung off a member that does not own it", async () => {
    const { loader } = await categoryRoute();
    const response = await thrownFrom(
      loader(
        routeArgs(
          "https://h.example.com/repos/p1/agents/sam/sub/researcher/resources/tools",
          { projectId: "p1", agentName: "sam", subPath: "researcher", category: "tools" },
        ),
      ),
    );
    expect(response.status).toBe(404);
  });

  it("404s a subagent URL under an agent that is not on the roster", async () => {
    const { loader } = await categoryRoute();
    const response = await thrownFrom(
      loader(
        routeArgs(
          "https://h.example.com/repos/p1/agents/nobody/sub/researcher/resources/tools",
          { projectId: "p1", agentName: "nobody", subPath: "researcher", category: "tools" },
        ),
      ),
    );
    expect(response.status).toBe(404);
  });

  it("ignores a posted agent field when saving instructions", async () => {
    const { action } = await import("~/routes/projects.$projectId.edit.instructions");
    const result = await action(
      formArgs(
        "https://h.example.com/repos/p1/agents/ivy/sub/researcher/edit/instructions",
        { projectId: "p1", agentName: "ivy", subPath: "researcher" },
        { agent: "sam", content: "# pwned" },
      ),
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.stageDraft).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${RESEARCHER_ROOT}/instructions.md` }),
    );
  });

  it("refuses to save instructions for a subagent of another member", async () => {
    const { action } = await import("~/routes/projects.$projectId.edit.instructions");
    const response = await thrownFrom(
      action(
        formArgs(
          "https://h.example.com/repos/p1/agents/sam/sub/researcher/edit/instructions",
          { projectId: "p1", agentName: "sam", subPath: "researcher" },
          { content: "# pwned" },
        ),
      ),
    );
    expect(response.status).toBe(404);
    expect(mocks.stageDraft).not.toHaveBeenCalled();
  });
});

describe("editor templates at a nested root", () => {
  beforeEach(() => reset());

  it("starts a new nested tool from the tool template", async () => {
    const { loader } = await editRoute();
    const view = await loader(
      routeArgs(
        `https://h.example.com/repos/p1/agents/ivy/sub/researcher/edit?path=${encodeURIComponent(`${RESEARCHER_ROOT}/tools/lookup.ts`)}`,
        { projectId: "p1", agentName: "ivy", subPath: "researcher" },
      ),
    );
    expect(view.isNew).toBe(true);
    expect(view.subagentPath).toEqual(["researcher"]);
    expect(view.content).toContain("defineTool");
  });

  it("starts a nested sandbox from the sandbox scaffold", async () => {
    const { loader } = await editRoute();
    const view = await loader(
      routeArgs(
        `https://h.example.com/repos/p1/agents/ivy/sub/researcher/edit?path=${encodeURIComponent(`${RESEARCHER_ROOT}/sandbox.ts`)}`,
        { projectId: "p1", agentName: "ivy", subPath: "researcher" },
      ),
    );
    expect(view.isNew).toBe(true);
  });
});
