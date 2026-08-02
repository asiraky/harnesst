/**
 * The generated `harnesst/model.ts` workspace module + the resolver-style `agent.ts` scaffold.
 * Pins the shape both harnesst and the migration prompt rely on: one exported
 * `harnesstAgentModel(agentName)` used verbatim by agents and subagents (subagents pass the
 * PARENT's name), runtime resolution against `<HARNESST_MODEL_GATEWAY_URL>/model-config`, the
 * playground directive taking precedence, and the read-side helpers recognizing the shape
 * (so a model save writes the org map instead of rewriting the file).
 */
import { describe, expect, it } from "vitest";

import {
  hasDynamicModel,
  orgResolverAgentName,
  readModel,
  usesOrgModelResolver,
} from "~/eve/agentModule";
import {
  isOrgModelModulePath,
  legacyOrgModelModulePath,
  orgModelImportSpecifier,
  orgModelModulePath,
  orgModelModuleSource,
  rewriteOrgModelImports,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";

describe("orgModelModuleSource", () => {
  const source = orgModelModuleSource();

  it("exports harnesstAgentModel and resolves through the harnesst model-config endpoint", () => {
    expect(source).toContain("export function harnesstAgentModel(agentName: string)");
    expect(source).toContain("/model-config?agent=");
    expect(source).toContain("HARNESST_MODEL_GATEWAY_URL");
    expect(source).toContain("HARNESST_MODEL_GATEWAY_TOKEN");
  });

  it("checks the playground directive before the workspace configuration", () => {
    const directive = source.indexOf("harnesstSelectedModel(ctx.messages)");
    const configured = source.indexOf("await harnesstConfiguredModel(agentName)");
    expect(directive).toBeGreaterThan(-1);
    expect(configured).toBeGreaterThan(directive);
  });

  it("carries the shared credential router and directive parser (no drift from setModel)", () => {
    expect(source).toContain("function harnesstModel(");
    expect(source).toContain("HARNESST_MODEL_DIRECTIVE_SECRET");
    expect(source).toContain("timingSafeEqual");
  });

  it("never bakes a resolvable model id — the fallback errors readably instead", () => {
    expect(source).toContain("harnesst/unconfigured");
    expect(source).toContain("Org settings");
  });
});

describe("scaffoldOrgModelAgentModule", () => {
  it("emits a model-free agent.ts that resolves by agent name", () => {
    const source = scaffoldOrgModelAgentModule("bookkeeping");
    expect(source).toContain("model: harnesstAgentModel('bookkeeping')");
    // `agent.ts` sits in the agent root; the module is that root's sibling (issue #254).
    expect(source).toContain("from '../harnesst/model.js'");
    // No model id anywhere — the workspace configuration is the only source of truth.
    expect(source).not.toMatch(/anthropic|openai|openrouter|codex/);
  });

  it("strips quote characters from the agent name (no source injection)", () => {
    expect(scaffoldOrgModelAgentModule("a'b\"c`d\\e")).toContain(
      "harnesstAgentModel('abcde')",
    );
  });

  it("is recognized by the read-side helpers as dynamic with no baked model", () => {
    const source = scaffoldOrgModelAgentModule("bookkeeping");
    expect(usesOrgModelResolver(source)).toBe(true);
    expect(orgResolverAgentName(source)).toBe("bookkeeping");
    expect(hasDynamicModel(source)).toBe(true);
    // The resolver argument is an agent NAME — it must never read back as a model id.
    expect(readModel(source)).toBeNull();
  });
});

describe("module placement helpers", () => {
  it("places model.ts in the agent root's platform sibling, both layouts", () => {
    expect(orgModelModulePath("agents/bob/agent")).toBe("agents/bob/harnesst/model.ts");
    expect(orgModelModulePath("agent")).toBe("harnesst/model.ts");
  });

  it("recognizes the module's own path (the one platform file no install owns)", () => {
    expect(isOrgModelModulePath("harnesst/model.ts")).toBe(true);
    expect(isOrgModelModulePath("agents/bob/harnesst/model.ts")).toBe(true);
    expect(isOrgModelModulePath("harnesst/github-channel.ts")).toBe(false);
    expect(isOrgModelModulePath("harnesst/nested/model.ts")).toBe(false);
    expect(isOrgModelModulePath("agent/harnesst-model.ts")).toBe(false);
  });

  it("builds the import specifier for the agent root and for subagents", () => {
    // Every specifier climbs OUT of the agent root first — the module is its sibling.
    expect(orgModelImportSpecifier()).toBe("../harnesst/model.js");
    // subagents/<name>/agent.ts sits two directories below the agent root.
    expect(orgModelImportSpecifier(2)).toBe("../../../harnesst/model.js");
  });

  it("names the legacy location the publish relocation moves away from", () => {
    expect(legacyOrgModelModulePath("agents/bob/agent")).toBe(
      "agents/bob/agent/harnesst-model.ts",
    );
    expect(legacyOrgModelModulePath("agent")).toBe("agent/harnesst-model.ts");
  });
});

describe("rewriteOrgModelImports", () => {
  it("rewrites the agent-root and subagent specifiers to the relocated module", () => {
    expect(
      rewriteOrgModelImports(`import { harnesstAgentModel } from './harnesst-model';`, 0),
    ).toBe(`import { harnesstAgentModel } from '../harnesst/model.js';`);
    expect(
      rewriteOrgModelImports(
        `import { harnesstAgentModel } from "../../harnesst-model";`,
        2,
      ),
    ).toBe(`import { harnesstAgentModel } from "../../../harnesst/model.js";`);
  });

  it("rewrites specifiers carrying an explicit extension", () => {
    expect(rewriteOrgModelImports(`from './harnesst-model.js'`, 0)).toBe(
      `from '../harnesst/model.js'`,
    );
    expect(rewriteOrgModelImports(`from './harnesst-model.ts'`, 0)).toBe(
      `from '../harnesst/model.js'`,
    );
  });

  it("adds the emitted-file extension to already-relocated imports", () => {
    expect(rewriteOrgModelImports(`from '../harnesst/model'`, 0)).toBe(
      `from '../harnesst/model.js'`,
    );
    expect(rewriteOrgModelImports(`from '../../../harnesst/model'`, 2)).toBe(
      `from '../../../harnesst/model.js'`,
    );
    expect(rewriteOrgModelImports(`from '../harnesst/model.js'`, 0)).toBe(
      `from '../harnesst/model.js'`,
    );
  });

  it("returns the source unchanged when nothing imports the module", () => {
    // Callers use identity to decide whether a file needs restaging at all — so prose that
    // merely mentions the filename must not read as an import.
    const prose = "// harnesst-model was relocated in issue #254.\n";
    expect(rewriteOrgModelImports(prose, 0)).toBe(prose);
    expect(rewriteOrgModelImports("import { defineAgent } from 'eve';", 0)).toBe(
      "import { defineAgent } from 'eve';",
    );
  });

  it("rewrites every occurrence, not just the first", () => {
    const source = `import a from './harnesst-model';\nimport b from './harnesst-model';\n`;
    expect(rewriteOrgModelImports(source, 0)).toBe(
      `import a from '../harnesst/model.js';\nimport b from '../harnesst/model.js';\n`,
    );
  });
});
