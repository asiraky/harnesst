/**
 * Repo-layout detection (PRD §7.9): `agent/` at the root is a single-agent repo;
 * `agents/<member>/agent/` directories form a team roster. Pins the convention so init,
 * connect validation, and the project view all agree on what a repo is.
 */
import { describe, expect, it } from "vitest";

import {
  buildAgentConfig,
  buildSubagentSummaries,
  detectAgentRoots,
  detectSandbox,
  EMPTY_TEAM_MARKER,
  extractDescription,
  hasTeamLayout,
  isEveRepo,
  overlayDrafts,
  subagentDirNames,
  subagentModuleFiles,
} from "~/eve/parse";
import { categoriesFor } from "~/eve/types";

const SINGLE = [
  "agent/instructions.md",
  "agent/agent.ts",
  "agent/schedules/morning.md",
];

const TEAM = [
  "agents/product-manager/agent/instructions.md",
  "agents/product-manager/agent/agent.ts",
  "agents/product-manager/package.json",
  "agents/deployer/agent/agent.ts",
  "agents/deployer/agent/tools/cloudflare.ts",
  "harnesst.json",
];

describe("detectAgentRoots", () => {
  it("detects a single-agent repo as the one 'agent' root", () => {
    expect(detectAgentRoots(SINGLE)).toEqual([
      { name: "agent", root: "agent" },
    ]);
  });

  it("detects team members by the agents/<member>/agent convention, sorted", () => {
    expect(detectAgentRoots(TEAM)).toEqual([
      { name: "deployer", root: "agents/deployer/agent" },
      { name: "product-manager", root: "agents/product-manager/agent" },
    ]);
  });

  it("ignores agents/ entries without an inner agent/ directory", () => {
    expect(detectAgentRoots(["agents/notes.md", "agents/x/README.md"])).toEqual(
      [],
    );
  });

  it("prefers single-agent layout when both shapes exist", () => {
    expect(detectAgentRoots([...SINGLE, ...TEAM])).toEqual([
      { name: "agent", root: "agent" },
    ]);
  });

  it("keeps an empty-team marker out of the member roster", () => {
    expect(detectAgentRoots([EMPTY_TEAM_MARKER])).toEqual([]);
    expect(hasTeamLayout([EMPTY_TEAM_MARKER])).toBe(true);
  });
});

describe("isEveRepo", () => {
  it("accepts both layouts and rejects everything else", () => {
    expect(isEveRepo(SINGLE)).toBe(true);
    expect(isEveRepo(TEAM)).toBe(true);
    expect(isEveRepo([EMPTY_TEAM_MARKER])).toBe(true);
    expect(isEveRepo(["src/index.ts", "README.md"])).toBe(false);
  });
});

describe("buildAgentConfig with a member root", () => {
  it("reads a team member's config from its own agent directory", () => {
    const config = buildAgentConfig(
      {
        paths: TEAM,
        files: {
          "agents/deployer/agent/agent.ts": `export default defineAgent({ model: "anthropic/claude-sonnet-5" });`,
        },
      },
      "agents/deployer/agent",
    );
    expect(config.hasAgentModule).toBe(true);
    expect(config.tools).toEqual([
      {
        name: "cloudflare",
        path: "agents/deployer/agent/tools/cloudflare.ts",
        isDirectory: false,
      },
    ]);
  });

  it("defaults to the single-agent root", () => {
    const config = buildAgentConfig({ paths: SINGLE, files: {} });
    expect(config.tools).toEqual([]);
    expect(config.schedules.map((t) => t.name)).toEqual(["morning"]);
  });

  // The model is workspace configuration resolved from the DB by agent name — never parsed out
  // of agent.ts. buildAgentConfig no longer surfaces a model, so an `harnesstAgentModel('<name>')`
  // module can't leak its NAME argument as if it were a model id (the bug this replaced).
  it("does not expose a model field parsed from agent.ts", () => {
    const config = buildAgentConfig(
      {
        paths: ["agent/agent.ts"],
        files: {
          "agent/agent.ts": `import { harnesstAgentModel } from './harnesst-model';
export default defineAgent({ model: harnesstAgentModel('bookkeeping'), modelContextWindowTokens: 200000 });`,
        },
      },
      "agent",
    );
    expect(config.hasAgentModule).toBe(true);
    expect("model" in config).toBe(false);
  });
});

describe("detectSandbox", () => {
  it("detects the flat sandbox.<ext> shorthand under the agent root", () => {
    expect(detectSandbox([...SINGLE, "agent/sandbox.ts"], "agent")).toEqual({
      path: "agent/sandbox.ts",
      hasWorkspace: false,
    });
  });

  it("detects the sandbox/ folder layout, noting the workspace seed tree", () => {
    const paths = [
      ...SINGLE,
      "agent/sandbox/sandbox.ts",
      "agent/sandbox/workspace/notes/setup.md",
    ];
    expect(detectSandbox(paths, "agent")).toEqual({
      path: "agent/sandbox/sandbox.ts",
      hasWorkspace: true,
    });
  });

  it("prefers the folder layout when both exist (eve's discovery order)", () => {
    const paths = ["agent/sandbox.ts", "agent/sandbox/sandbox.js"];
    expect(detectSandbox(paths, "agent")).toEqual({
      path: "agent/sandbox/sandbox.js",
      hasWorkspace: false,
    });
  });

  it("returns null for the framework default, and ignores lookalike paths", () => {
    expect(detectSandbox(SINGLE, "agent")).toBeNull();
    // Not a sandbox module: wrong extension, nested under a category, or another agent's.
    expect(
      detectSandbox(
        [
          "agent/sandbox.md",
          "agent/tools/sandbox.ts",
          "agents/x/agent/sandbox.ts",
        ],
        "agent",
      ),
    ).toBeNull();
  });
});

describe("buildAgentConfig sandbox detection", () => {
  it("surfaces the root agent's sandbox and each subagent's own", () => {
    const paths = [
      ...SINGLE,
      "agent/sandbox.ts",
      "agent/subagents/researcher/instructions.md",
      "agent/subagents/researcher/sandbox.ts",
      "agent/subagents/writer/instructions.md",
    ];
    const config = buildAgentConfig({ paths, files: {} });
    expect(config.sandbox).toEqual({
      path: "agent/sandbox.ts",
      hasWorkspace: false,
    });
    expect(config.subagentSandboxes).toEqual({
      researcher: {
        path: "agent/subagents/researcher/sandbox.ts",
        hasWorkspace: false,
      },
    });
  });

  it("reports the framework default (null) when no definition exists", () => {
    const config = buildAgentConfig({ paths: SINGLE, files: {} });
    expect(config.sandbox).toBeNull();
    expect(config.subagentSandboxes).toEqual({});
  });

  it("scopes detection to the member's root in a team repo", () => {
    const config = buildAgentConfig(
      { paths: [...TEAM, "agents/deployer/agent/sandbox.ts"], files: {} },
      "agents/deployer/agent",
    );
    expect(config.sandbox).toEqual({
      path: "agents/deployer/agent/sandbox.ts",
      hasWorkspace: false,
    });
    const other = buildAgentConfig(
      { paths: [...TEAM, "agents/deployer/agent/sandbox.ts"], files: {} },
      "agents/product-manager/agent",
    );
    expect(other.sandbox).toBeNull();
  });
});

describe("subagents surfaced as read-only children (issue #146)", () => {
  // Mirrors the real incident: quinn/remy live under ivy; a stray file and another
  // member's subagent must not leak in.
  const TEAM_SUB = {
    paths: [
      "agents/ivy/agent/agent.ts",
      "agents/ivy/agent/subagents/quinn/agent.ts",
      "agents/ivy/agent/subagents/quinn/instructions.md",
      "agents/ivy/agent/subagents/remy/agent.ts",
      "agents/ivy/agent/subagents/remy/instructions.md",
      "agents/ivy/agent/subagents/tess/agent.ts",
      "agents/ivy/agent/subagents/notes.md", // stray file, not a subagent
      "agents/sam/agent/subagents/dana/agent.ts", // other member
    ],
    files: {
      "agents/ivy/agent/subagents/quinn/agent.ts":
        `export default defineAgent({ description: 'QA reviewer for the pipeline', model: 'anthropic/claude-sonnet-5' });`,
      "agents/ivy/agent/subagents/remy/agent.ts":
        `export default defineAgent({ model: 'anthropic/claude-sonnet-5' });`,
      "agents/ivy/agent/subagents/remy/instructions.md":
        "# Remy\nCode reviewer for pull requests.",
      "agents/ivy/agent/subagents/tess/agent.ts":
        `export default defineAgent({ model: 'anthropic/claude-sonnet-5' });`,
    },
  };

  describe("subagentDirNames", () => {
    it("returns only directory-backed subagents, sorted, scoped to the root", () => {
      expect(subagentDirNames(TEAM_SUB.paths, "agents/ivy/agent")).toEqual([
        "quinn",
        "remy",
        "tess",
      ]);
    });

    it("ignores a stray file directly under subagents/ and other members' subagents", () => {
      const names = subagentDirNames(TEAM_SUB.paths, "agents/ivy/agent");
      expect(names).not.toContain("notes");
      expect(names).not.toContain("dana");
    });

    it("scopes to the given member root", () => {
      expect(subagentDirNames(TEAM_SUB.paths, "agents/sam/agent")).toEqual(["dana"]);
    });
  });

  describe("extractDescription", () => {
    it("pulls a single-quoted description literal from a defineAgent source", () => {
      expect(
        extractDescription(
          `export default defineAgent({ description: 'QA reviewer', model: 'x' });`,
        ),
      ).toBe("QA reviewer");
    });

    it("pulls and collapses a template-literal description to one line", () => {
      expect(
        extractDescription(
          "defineAgent({ description: `QA\n  reviewer   here` });",
        ),
      ).toBe("QA reviewer here");
    });

    it("returns null when there is no description and for empty input", () => {
      expect(extractDescription(`defineAgent({ model: 'x' });`)).toBeNull();
      expect(extractDescription(undefined)).toBeNull();
    });
  });

  describe("buildSubagentSummaries", () => {
    it("summarizes each subagent with a best-effort description, scoped and sorted", () => {
      const summaries = buildSubagentSummaries(TEAM_SUB, "agents/ivy/agent");
      expect(summaries).toEqual([
        {
          name: "quinn",
          path: "agents/ivy/agent/subagents/quinn",
          description: "QA reviewer for the pipeline",
          dynamic: false,
        },
        {
          name: "remy",
          path: "agents/ivy/agent/subagents/remy",
          description: "Remy",
          dynamic: false,
        },
        {
          name: "tess",
          path: "agents/ivy/agent/subagents/tess",
          description: null,
          dynamic: false,
        },
      ]);
    });

    it("does not leak another member's subagents", () => {
      const summaries = buildSubagentSummaries(TEAM_SUB, "agents/sam/agent");
      expect(summaries.map((s) => s.name)).toEqual(["dana"]);
    });

    // A `defineDynamic` subagent is offered per session, so the surface must say so rather than
    // claim it is always available (issue #344).
    it("flags a defineDynamic subagent module as dynamic", () => {
      const summaries = buildSubagentSummaries(
        {
          paths: ["agent/subagents/scout/agent.ts", "agent/subagents/fixed/agent.ts"],
          files: {
            "agent/subagents/scout/agent.ts":
              `import { defineDynamic } from 'eve';\nexport default defineDynamic(async () => ({ description: 'Scout' }));`,
            // harnesst writes `model: defineDynamic(...)` into every module it touches — that is
            // the model wrapper, not a dynamic declaration.
            "agent/subagents/fixed/agent.ts":
              `export default defineAgent({ description: 'Fixed', model: defineDynamic({ fallback: x }) });`,
          },
        },
        "agent",
      );
      expect(summaries.map((s) => [s.name, s.dynamic])).toEqual([
        ["fixed", false],
        ["scout", true],
      ]);
    });

    // Nested contexts render their own description/instructions, so the eager read must reach
    // every depth, scoped to the root it was asked about.
    it("subagentModuleFiles collects modules + instructions at any depth, scoped to the root", () => {
      const paths = [
        ...TEAM_SUB.paths,
        "agents/ivy/agent/subagents/quinn/subagents/deep/agent.ts",
        "agents/ivy/agent/subagents/quinn/subagents/deep/instructions.md",
        "agents/ivy/agent/subagents/quinn/tools/x.ts",
        "agents/ivy/agent/instructions.md",
      ];
      expect(subagentModuleFiles(paths, "agents/ivy/agent")).toEqual([
        "agents/ivy/agent/subagents/quinn/agent.ts",
        "agents/ivy/agent/subagents/quinn/instructions.md",
        "agents/ivy/agent/subagents/quinn/subagents/deep/agent.ts",
        "agents/ivy/agent/subagents/quinn/subagents/deep/instructions.md",
        "agents/ivy/agent/subagents/remy/agent.ts",
        "agents/ivy/agent/subagents/remy/instructions.md",
        "agents/ivy/agent/subagents/tess/agent.ts",
      ]);
      expect(subagentModuleFiles(paths, "agents/sam/agent")).toEqual([
        "agents/sam/agent/subagents/dana/agent.ts",
      ]);
    });

    // Discovery recurses by pointing the same helpers at the nested root.
    it("discovers nested subagents by re-rooting at the parent subagent", () => {
      const paths = [
        "agent/subagents/researcher/agent.ts",
        "agent/subagents/researcher/subagents/fact-checker/agent.ts",
        "agent/subagents/researcher/subagents/summarizer/instructions.md",
      ];
      expect(subagentDirNames(paths, "agent")).toEqual(["researcher"]);
      expect(subagentDirNames(paths, "agent/subagents/researcher")).toEqual([
        "fact-checker",
        "summarizer",
      ]);
    });
  });
});

describe("overlayDrafts", () => {
  const base = {
    paths: ["agent/agent.ts", "agent/instructions.md"],
    files: { "agent/instructions.md": "published" },
  };

  it("returns the source untouched when there are no drafts", () => {
    expect(overlayDrafts(base, [])).toBe(base);
  });

  it("adds new paths, replaces content, and removes deletions", () => {
    const overlaid = overlayDrafts(base, [
      { path: "agent/subagents/drafty/agent.ts", content: "export default {};" },
      { path: "agent/instructions.md", content: "saved" },
      { path: "agent/agent.ts", content: null },
    ]);
    expect(overlaid.paths.sort()).toEqual([
      "agent/instructions.md",
      "agent/subagents/drafty/agent.ts",
    ]);
    expect(overlaid.files["agent/instructions.md"]).toBe("saved");
    expect(overlaid.files["agent/subagents/drafty/agent.ts"]).toBe("export default {};");
  });

  it("does not mutate the source it overlays", () => {
    overlayDrafts(base, [{ path: "agent/tools/x.ts", content: "x" }]);
    expect(base.paths).toEqual(["agent/agent.ts", "agent/instructions.md"]);
    expect(base.files).toEqual({ "agent/instructions.md": "published" });
  });

  it("makes a draft-only subagent discoverable and a draft-deleted one disappear", () => {
    const source = {
      paths: ["agent/subagents/old/agent.ts"],
      files: {},
    };
    const overlaid = overlayDrafts(source, [
      { path: "agent/subagents/new/agent.ts", content: "export default {};" },
      { path: "agent/subagents/old/agent.ts", content: null },
    ]);
    expect(subagentDirNames(overlaid.paths, "agent")).toEqual(["new"]);
  });
});

describe("capability matrix (issue #344)", () => {
  it("gives a top-level agent every category, including hooks", () => {
    expect(categoriesFor("agent").map((c) => c.key)).toEqual([
      "tools",
      "skills",
      "subagents",
      "channels",
      "schedules",
      "connections",
      "hooks",
    ]);
  });

  it("withholds the root-only categories from a declared subagent", () => {
    // eve resolves channels and schedules at the agent root only; a subagent that offered them
    // would render controls that can never take effect.
    const keys = categoriesFor("subagent").map((c) => c.key);
    expect(keys).toEqual(["tools", "skills", "subagents", "connections", "hooks"]);
    expect(keys).not.toContain("channels");
    expect(keys).not.toContain("schedules");
  });

  it("parses the hooks directory into the config like any other category", () => {
    const config = buildAgentConfig(
      { paths: ["agent/hooks/audit.ts", "agent/hooks/notes.test.ts"], files: {} },
      "agent",
    );
    expect(config.hooks).toEqual([
      { name: "audit", path: "agent/hooks/audit.ts", isDirectory: false },
    ]);
  });
});

describe("withPreservedNames", () => {
  it("keeps the human-given name for the root-layout member", async () => {
    const { withPreservedNames } = await import("~/db/queries.server");
    const existing = [
      {
        id: "a1",
        projectId: "p",
        name: "pm",
        root: "agent",
        kind: "member",
        pendingName: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    expect(
      withPreservedNames(existing, [{ name: "agent", root: "agent" }]),
    ).toEqual([{ name: "pm", root: "agent" }]);
    // Team members are named by directory — untouched.
    expect(
      withPreservedNames(existing, [{ name: "qa", root: "agents/qa/agent" }]),
    ).toEqual([{ name: "qa", root: "agents/qa/agent" }]);
  });
});
