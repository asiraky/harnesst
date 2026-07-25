/**
 * The generated `eden-model.ts` workspace module + the resolver-style `agent.ts` scaffold.
 * Pins the shape both harnesst and the migration prompt rely on: one exported
 * `edenAgentModel(agentName)` used verbatim by agents and subagents (subagents pass the
 * PARENT's name), runtime resolution against `<EDEN_MODEL_GATEWAY_URL>/model-config`, the
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
  orgModelImportSpecifier,
  orgModelModulePath,
  orgModelModuleSource,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";

describe("orgModelModuleSource", () => {
  const source = orgModelModuleSource();

  it("exports edenAgentModel and resolves through the harnesst model-config endpoint", () => {
    expect(source).toContain("export function edenAgentModel(agentName: string)");
    expect(source).toContain("/model-config?agent=");
    expect(source).toContain("EDEN_MODEL_GATEWAY_URL");
    expect(source).toContain("EDEN_MODEL_GATEWAY_TOKEN");
  });

  it("checks the playground directive before the workspace configuration", () => {
    const directive = source.indexOf("edenSelectedModel(ctx.messages)");
    const configured = source.indexOf("await edenConfiguredModel(agentName)");
    expect(directive).toBeGreaterThan(-1);
    expect(configured).toBeGreaterThan(directive);
  });

  it("carries the shared credential router and directive parser (no drift from setModel)", () => {
    expect(source).toContain("function edenModel(");
    expect(source).toContain("EDEN_MODEL_DIRECTIVE_SECRET");
    expect(source).toContain("timingSafeEqual");
  });

  it("never bakes a resolvable model id — the fallback errors readably instead", () => {
    expect(source).toContain("eden/unconfigured");
    expect(source).toContain("Org settings");
  });
});

describe("scaffoldOrgModelAgentModule", () => {
  it("emits a model-free agent.ts that resolves by agent name", () => {
    const source = scaffoldOrgModelAgentModule("bookkeeping");
    expect(source).toContain("model: edenAgentModel('bookkeeping')");
    expect(source).toContain("from './eden-model'");
    // No model id anywhere — the workspace configuration is the only source of truth.
    expect(source).not.toMatch(/anthropic|openai|openrouter|codex/);
  });

  it("strips quote characters from the agent name (no source injection)", () => {
    expect(scaffoldOrgModelAgentModule("a'b\"c`d\\e")).toContain(
      "edenAgentModel('abcde')",
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
  it("places eden-model.ts at the member root", () => {
    expect(orgModelModulePath("agents/bob/agent")).toBe(
      "agents/bob/agent/eden-model.ts",
    );
  });

  it("builds the import specifier for the member root and for subagents", () => {
    expect(orgModelImportSpecifier()).toBe("./eden-model");
    // subagents/<name>/agent.ts sits two directories below the member root.
    expect(orgModelImportSpecifier(2)).toBe("../../eden-model");
  });
});
