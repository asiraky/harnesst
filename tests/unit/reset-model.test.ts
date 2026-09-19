import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { scaffoldAgentModule, setModel } from "~/eve/agentModule";
import { scaffoldOrgModelAgentModule } from "~/eve/org-model-module";
import { resetAgentModelSource } from "~/eve/reset-model";

function evaluate(
  source: string,
  resolve = (...target: string[]) => ({ target }),
) {
  const imports: string[] = [];
  const exports: { default?: Record<string, unknown> } = {};
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(output, {
    exports,
    process: { env: {} },
    require: (specifier: string) => {
      imports.push(specifier);
      if (specifier.endsWith("harnesst/model.js"))
        return { harnesstAgentModel: resolve };
      if (specifier === "eve")
        return {
          defineAgent: (config: unknown) => config,
          defineDynamic: (config: unknown) => config,
        };
      if (specifier === "@ai-sdk/openai-compatible")
        return {
          createOpenAICompatible: () => ({
            chatModel: (id: string) => ({ id }),
          }),
        };
      return {};
    },
  });
  return { config: exports.default!, imports };
}

describe("resetAgentModelSource", () => {
  // Frozen from the ledger prototype catalog, including its two declared subagents. Execute
  // both generations and compare unrelated runtime options, rather than asserting shipped text.
  it.each([
    ["ledger-infra", ""],
    ["ledger-intake", ""],
    ["ledger-implementer", ""],
    ["ledger-implementer", "reviewer"],
    ["ledger-implementer", "qa"],
  ])(
    "converts ledger module %s/%s without losing behavior",
    (agentName, subagentPath) => {
      const filename = `${agentName}${subagentPath ? `-subagents-${subagentPath}` : ""}.ts.txt`;
      const source = readFileSync(
        new URL(`../fixtures/ledger-reset/${filename}`, import.meta.url),
        "utf8",
      );
      const original = evaluate(source).config;
      for (const input of [
        source,
        setModel(source, "codex/abcdefghijkl/pinned", { effort: "high" }),
      ]) {
        const result = resetAgentModelSource(input, agentName, subagentPath);
        const reset = evaluate(result).config;
        expect(reset.model).toEqual({
          target: [agentName, ...(subagentPath ? [subagentPath] : [])],
        });
        const {
          model: _model,
          modelContextWindowTokens: _context,
          ...unrelated
        } = original;
        const { model: _resetModel, ...remaining } = reset;
        expect(remaining).toEqual(unrelated);
        expect(resetAgentModelSource(result, agentName, subagentPath)).toBe(
          result,
        );
      }
    },
  );

  it("switches a literal selection to inheritance without changing tools or instructions", () => {
    const input = `import { defineAgent } from 'eve';
      const tool = { run: () => 'tool result', model: 'leave nested values alone' };
      export default defineAgent({
        model: 'old/model', reasoning: 'high', modelContextWindowTokens: 123_456,
        instructions: 'Keep the words model: old/model', tools: { tool }, maxSteps: 42,
      });`;
    const { config } = evaluate(resetAgentModelSource(input, "ledger"));
    expect(config.model).toEqual({ target: ["ledger"] });
    expect(config.reasoning).toBeUndefined();
    expect(config.modelContextWindowTokens).toBeUndefined();
    expect(config.instructions).toBe("Keep the words model: old/model");
    expect(config.maxSteps).toBe(42);
    const tool = (config.tools as { tool: { run(): string; model: string } })
      .tool;
    expect(tool.run()).toBe("tool result");
    expect(tool.model).toBe("leave nested values alone");
  });

  it("converts the generated fallback and reasoning wrapper to the resolver", () => {
    const source = scaffoldAgentModule("codex/abcdefghijkl/pinned", {
      effort: "high",
      contextWindowTokens: 100_000,
    });
    const { config } = evaluate(resetAgentModelSource(source, "ledger"));
    expect(config.model).toEqual({ target: ["ledger"] });
    expect(config.modelContextWindowTokens).toBeUndefined();
  });

  it("converts the historical generated router", () => {
    const source = readFileSync(
      new URL("../fixtures/agent-module-with-router.ts.txt", import.meta.url),
      "utf8",
    );
    expect(
      evaluate(resetAgentModelSource(source, "ledger")).config.model,
    ).toEqual({ target: ["ledger"] });
  });

  it("addresses a nested subagent through the parent and imports from the right depth", () => {
    const result = resetAgentModelSource(
      scaffoldOrgModelAgentModule("wrong"),
      "ledger",
      "review/qa",
    );
    const evaluated = evaluate(result);
    expect(evaluated.config.model).toEqual({ target: ["ledger", "review/qa"] });
    expect(evaluated.imports).toContain("../../../../../harnesst/model.js");
    expect(resetAgentModelSource(result, "ledger", "review/qa")).toBe(result);
  });

  it("inserts inheritance when the standard declaration has no model", () => {
    const result = resetAgentModelSource(
      "import { defineAgent } from 'eve'; export default defineAgent({ tools: {} });",
      "ledger",
    );
    expect(evaluate(result).config.model).toEqual({ target: ["ledger"] });
  });

  it.each(["reasoning:'high'", "modelContextWindowTokens:200000"])(
    "replaces a minified selection-only declaration: %s",
    (selection) => {
      const source = `import {defineAgent} from 'eve';export default defineAgent({${selection}});`;
      const result = resetAgentModelSource(source, "ledger");
      expect(evaluate(result).config).toEqual({
        model: { target: ["ledger"] },
      });
      expect(resetAgentModelSource(result, "ledger")).toBe(result);
    },
  );

  it("leaves an already inheriting module byte-identical", () => {
    const source =
      "import { defineAgent } from 'eve'; import { harnesstAgentModel } from '../harnesst/model.js'; export default defineAgent({ model: harnesstAgentModel('ledger'), tools: {} });";
    expect(resetAgentModelSource(source, "ledger")).toBe(source);
  });

  it("escapes the target name as data", () => {
    const name = "ledger\"'); throw new Error('unexpected'); //";
    const result = resetAgentModelSource(
      scaffoldOrgModelAgentModule("old"),
      name,
    );
    expect(evaluate(result).config.model).toEqual({ target: [name] });
  });

  it("removes selection properties with inline comments without breaking neighboring properties", () => {
    const source =
      "import { defineAgent } from 'eve'; export default defineAgent({ model: 'old', reasoning: 'high' /* effort */, modelContextWindowTokens: 123 /* tokens */, maxSteps: 9 });";
    const config = evaluate(resetAgentModelSource(source, "ledger")).config;
    expect(config.maxSteps).toBe(9);
    expect(config.reasoning).toBeUndefined();
    expect(config.modelContextWindowTokens).toBeUndefined();
  });

  it.each([
    "model: chooseCustomModel()",
    "model: customProvider('model')",
    "model: defineDynamic({ fallback: 'model', events: {} })",
    "model: 'model', ...customSettings",
    "model: 'model', reasoning: chooseEffort()",
    "model: 'model', modelContextWindowTokens: calculateWindow()",
    "model: 'model', model: 'other'",
    "['model']: 'model'",
    "model: harnesstModel('custom')",
    "model: openrouter('custom')",
    "model: 'model', events: { 'step.started': () => ({model: 'another'}) }",
    "model: 'model', events: customEvents",
    "get model() { return 'model'; }",
  ])("rejects unsupported custom configuration: %s", (properties) => {
    const source = `import { defineAgent } from 'eve'; export default defineAgent({ ${properties} });`;
    expect(() => resetAgentModelSource(source, "ledger")).toThrow(
      "custom model logic",
    );
  });

  it("rejects customized behavior inside a formerly generated wrapper", () => {
    const source = scaffoldAgentModule("old/model").replace(
      "if (!selected) return null;",
      "if (!selected) return chooseModel();",
    );
    expect(() => resetAgentModelSource(source, "ledger")).toThrow(
      "custom model logic",
    );
  });

  it("does not confuse a custom resolver with the platform resolver", () => {
    const source =
      "import { defineAgent } from 'eve'; import { harnesstAgentModel } from './custom.js'; export default defineAgent({model: harnesstAgentModel('ledger')});";
    expect(() => resetAgentModelSource(source, "ledger")).toThrow(
      "custom model logic",
    );
  });

  it.each([
    "import { customResolver as harnesstAgentModel } from '../harnesst/model.js';",
    "import type { harnesstAgentModel } from '../harnesst/model.js';",
    "import { type harnesstAgentModel } from '../harnesst/model.js';",
    "const harnesstAgentModel = (name) => chooseCustomModel(name);",
  ])(
    "rejects custom or non-runtime bindings disguised as the resolver: %s",
    (binding) => {
      const source = `import { defineAgent } from 'eve'; ${binding} export default defineAgent({model: harnesstAgentModel('ledger')});`;
      expect(() => resetAgentModelSource(source, "ledger")).toThrow(
        "custom model logic",
      );
    },
  );
});
