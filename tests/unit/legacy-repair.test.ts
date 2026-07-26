/**
 * The pre-rename repair (issue #235) — the token table and the change-set planner.
 *
 * The load-bearing claim is byte-exactness, and it is pinned against real history: the four
 * fixtures under `tests/fixtures/pre-rename/` are the ACTUAL output of the generators as they
 * stood at `d17c0e9^` (the commit before the #213 tier-2 rename), and each must migrate to
 * exactly what today's generator emits — comments included. That is stricter than it looks:
 * `agentModule`'s self-healing rewriters anchor on exact comment markers, so a migration that
 * got the prose "close enough" would leave files those rewriters can no longer see, and the next
 * model save would append a second helper block instead of replacing the first.
 *
 * The other half is scope. These rules run inside customer repositories, so the tests below spend
 * as much effort on what must NOT change — prose, their own identifiers, a repo called `eden` —
 * as on what must.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scaffoldAgentModule } from "~/eve/agentModule";
import {
  findLegacyNames,
  hasLegacyNames,
  isMigratableGeneratedPath,
  migrateLegacySource,
  renameLegacyPath,
} from "~/eve/legacy-names";
import {
  detectsLegacyDrift,
  legacyRepairCandidates,
  planLegacyRepair,
} from "~/eve/legacy-repair";
import {
  orgModelModuleSource,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";
import { DEFAULT_SANDBOX_MODULE } from "~/eve/templates";

const FIXTURES = path.resolve(__dirname, "../fixtures/pre-rename");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

describe("migrateLegacySource — byte-exact against real pre-#230 output", () => {
  const cases: Array<[string, string, string]> = [
    ["agent.ts", "agent.ts.txt", scaffoldAgentModule("anthropic/claude-opus-5")],
    ["sandbox.ts", "sandbox.ts.txt", DEFAULT_SANDBOX_MODULE],
    ["harnesst-model.ts", "harnesst-model.ts.txt", orgModelModuleSource()],
    [
      "org-model agent.ts",
      "org-model-agent.ts.txt",
      scaffoldOrgModelAgentModule("sam"),
    ],
  ];

  for (const [label, file, current] of cases) {
    it(`reproduces today's ${label}`, () => {
      expect(migrateLegacySource(fixture(file))).toBe(current);
    });
  }

  it("is idempotent — today's output migrates to itself", () => {
    for (const [, , current] of cases) {
      expect(migrateLegacySource(current)).toBe(current);
      expect(hasLegacyNames(current)).toBe(false);
    }
  });

  it("leaves no legacy token behind", () => {
    for (const [, file] of cases) {
      expect(hasLegacyNames(fixture(file))).toBe(true);
      expect(hasLegacyNames(migrateLegacySource(fixture(file)))).toBe(false);
    }
  });
});

describe("migrateLegacySource — scope discipline", () => {
  it("never fires mid-identifier", () => {
    const source = [
      "const CREDENTIALS = 1;",
      "const deployedEnvs = [];",
      "function seedEnvironment() {}",
      "const precedence = 'sweden';",
      "widen(); broaden();",
    ].join("\n");
    expect(migrateLegacySource(source)).toBe(source);
  });

  it("leaves a customer's own eden-named things alone", () => {
    // A repo, a package and a URL that legitimately say "eden" — none is a harnesst-emitted shape.
    const source = [
      "const repo = 'github.com/acme/eden';",
      "import { thing } from 'eden-utils';",
      "const url = 'https://eden.example.com/api';",
      "const edens = ['eden', 'garden'].length;",
    ].join("\n");
    // Only the bare quoted literal (the gateway provider's `name: 'eden'`) is claimed by the table;
    // every path-, package- and host-shaped use survives.
    expect(migrateLegacySource(source)).toBe(
      [
        "const repo = 'github.com/acme/eden';",
        "import { thing } from 'eden-utils';",
        "const url = 'https://eden.example.com/api';",
        "const edens = ['harnesst', 'garden'].length;",
      ].join("\n"),
    );
  });

  it("rewrites env names, identifiers, types and the directive marker", () => {
    expect(migrateLegacySource("process.env.EDEN_SANDBOX_ENV")).toBe(
      "process.env.HARNESST_SANDBOX_ENV",
    );
    expect(migrateLegacySource("edenAgentModel('sam')")).toBe(
      "harnesstAgentModel('sam')",
    );
    expect(migrateLegacySource("type X = EdenModelConfig;")).toBe(
      "type X = HarnesstModelConfig;",
    );
    expect(migrateLegacySource("<!-- eden:model foo -->")).toBe(
      "<!-- harnesst:model foo -->",
    );
    expect(migrateLegacySource("from './eden-model'")).toBe(
      "from './harnesst-model'",
    );
  });

  it("reports the tokens it found as greppable names", () => {
    const found = findLegacyNames(
      "process.env.EDEN_SANDBOX_ENV; edenAgentModel();",
    );
    expect(found).toContain("EDEN_SANDBOX_ENV");
    expect(found).toContain("edenAgentModel");
    expect(found.every((token) => token.length > 0)).toBe(true);
  });
});

describe("renameLegacyPath", () => {
  it("renames the generated files, in place", () => {
    expect(renameLegacyPath("eden-lock.json")).toBe("harnesst-lock.json");
    expect(renameLegacyPath("agents/sam/agent/eden-model.ts")).toBe(
      "agents/sam/agent/harnesst-model.ts",
    );
    expect(renameLegacyPath(".eden/assistant/instructions.md")).toBe(
      ".harnesst/assistant/instructions.md",
    );
  });

  it("leaves everything else where it is", () => {
    expect(renameLegacyPath("harnesst-lock.json")).toBeNull();
    expect(renameLegacyPath("agent/agent.ts")).toBeNull();
    expect(renameLegacyPath("docs/eden-notes.md")).toBeNull();
  });
});

describe("isMigratableGeneratedPath", () => {
  it("takes generated TypeScript under an agent root", () => {
    expect(isMigratableGeneratedPath("agent/agent.ts")).toBe(true);
    expect(isMigratableGeneratedPath("agents/sam/agent/tools/x.ts")).toBe(true);
  });

  it("takes the legacy-named generated files wherever they sit", () => {
    expect(isMigratableGeneratedPath("eden-lock.json")).toBe(true);
    expect(isMigratableGeneratedPath(".eden/assistant/skills/a.md")).toBe(true);
  });

  it("refuses prose and code that isn't ours", () => {
    expect(isMigratableGeneratedPath("agent/instructions.md")).toBe(false);
    expect(isMigratableGeneratedPath("agents/sam/agent/skills/x.md")).toBe(
      false,
    );
    expect(isMigratableGeneratedPath("src/index.ts")).toBe(false);
    expect(isMigratableGeneratedPath("README.md")).toBe(false);
  });
});

describe("planLegacyRepair", () => {
  it("stages a rewrite for a stale generated module", () => {
    const plan = planLegacyRepair({
      "agent/sandbox.ts": fixture("sandbox.ts.txt"),
    });
    expect(plan.writes).toEqual([
      { path: "agent/sandbox.ts", content: DEFAULT_SANDBOX_MODULE },
    ]);
    expect(plan.deletions).toEqual([]);
    expect(plan.files[0].tokens).toContain("EDEN_SANDBOX_ENV");
  });

  it("moves a legacy-named file and stages the old path as a deletion", () => {
    const lock = '{\n  "version": 1,\n  "installs": []\n}\n';
    const plan = planLegacyRepair({ "eden-lock.json": lock });
    // JSON moves byte-for-byte: a `registry` locator may legitimately contain "eden".
    expect(plan.writes).toEqual([
      { path: "harnesst-lock.json", content: lock },
    ]);
    expect(plan.deletions).toEqual(["eden-lock.json"]);
    expect(plan.files[0]).toEqual({
      path: "eden-lock.json",
      renamedTo: "harnesst-lock.json",
      tokens: [],
    });
  });

  it("renames AND rewrites a legacy-named module", () => {
    const plan = planLegacyRepair({
      "agent/eden-model.ts": fixture("harnesst-model.ts.txt"),
    });
    expect(plan.writes).toEqual([
      { path: "agent/harnesst-model.ts", content: orgModelModuleSource() },
    ]);
    expect(plan.deletions).toEqual(["agent/eden-model.ts"]);
  });

  it("skips files that are already current", () => {
    const plan = planLegacyRepair({
      "agent/agent.ts": scaffoldAgentModule("anthropic/claude-opus-5"),
      "agent/sandbox.ts": DEFAULT_SANDBOX_MODULE,
      "harnesst-lock.json": "{}",
    });
    expect(plan.writes).toEqual([]);
    expect(plan.deletions).toEqual([]);
    expect(plan.files).toEqual([]);
  });

  it("is idempotent — replanning the result finds nothing to do", () => {
    const first = planLegacyRepair({
      "agent/agent.ts": fixture("agent.ts.txt"),
      "agent/eden-model.ts": fixture("harnesst-model.ts.txt"),
    });
    const applied = Object.fromEntries(
      first.writes.map((w) => [w.path, w.content]),
    );
    expect(planLegacyRepair(applied).writes).toEqual([]);
  });
});

describe("legacyRepairCandidates", () => {
  it("asks for the generated files only", () => {
    expect(
      legacyRepairCandidates([
        "agent/agent.ts",
        "agent/eden-model.ts",
        "agent/instructions.md",
        "eden-lock.json",
        ".eden/assistant/instructions.md",
        "README.md",
      ]),
    ).toEqual([
      "agent/agent.ts",
      "agent/eden-model.ts",
      "eden-lock.json",
      ".eden/assistant/instructions.md",
    ]);
  });
});

describe("detectsLegacyDrift", () => {
  it("sees a legacy-named path with no file contents at all", () => {
    expect(detectsLegacyDrift({ paths: ["eden-lock.json"], files: {} })).toBe(
      true,
    );
  });

  it("sees a stale agent.ts from the eager read", () => {
    expect(
      detectsLegacyDrift({
        paths: ["agent/agent.ts"],
        files: { "agent/agent.ts": fixture("agent.ts.txt") },
      }),
    ).toBe(true);
  });

  it("stays quiet on a current repo", () => {
    expect(
      detectsLegacyDrift({
        paths: ["agent/agent.ts", "harnesst-lock.json"],
        files: {
          "agent/agent.ts": scaffoldAgentModule("anthropic/claude-opus-5"),
        },
      }),
    ).toBe(false);
  });

  it("ignores the customer's prose", () => {
    expect(
      detectsLegacyDrift({
        paths: ["agent/instructions.md"],
        files: { "agent/instructions.md": "# Eden\n\nWe used to call it eden.\n" },
      }),
    ).toBe(false);
  });
});
