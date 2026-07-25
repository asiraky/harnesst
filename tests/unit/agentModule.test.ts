/**
 * agent.ts model read/write — pins the authored forms in the wild. harnesst writes a connection-aware
 * provider router and wraps the model in `defineDynamic` so the playground's per-conversation
 * model directive works (the chosen model is the fallback).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureModelProviderDependencies,
  hasDynamicModel,
  readModel,
  readModelContextWindow,
  readReasoningEffort,
  scaffoldAgentModule,
  setModel,
} from "~/eve/agentModule";

const WRAPPED = `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY ?? "" });

export default defineAgent({
  model: openrouter.chatModel("anthropic/claude-sonnet-4.5"),
  modelContextWindowTokens: 200_000,
});
`;

const LEGACY_WRAPPED = `import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? "" });

export default defineAgent({
  model: openrouter("anthropic/claude-sonnet-4.5"),
  modelContextWindowTokens: 200_000,
});
`;

const PLAIN = `import { defineAgent } from 'eve';

export default defineAgent({
  model: 'anthropic/claude-sonnet-5',
});
`;

// harnesst's generated agent.ts before PR #112: it has the directive selector and dynamic wrapper,
// but no harnesstModel router or gateway factory, and the resolver always chooses OpenRouter.
const PRE_112 = `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { defineAgent, defineDynamic } from 'eve';

const openrouter = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY ?? '' });

// harnesst playground model override: the playground pins a model per conversation by
// prefixing the sent message with one machine-readable line, e.g.
//   <!-- harnesst:model anthropic/claude-sonnet-5 ctx=200000 -->
// harnesst strips that line from every transcript surface; here it picks the model per step.
const HARNESST_MODEL_DIRECTIVE = /<!--\\s*harnesst:model\\s+(\\S+?)(?:\\s+ctx=(\\d+))?\\s*-->/;
function harnesstSelectedModel(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): { id: string; contextWindowTokens: number | undefined } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (!entry || entry.role !== 'user') continue;
    const text = typeof entry.content === 'string' ? entry.content : '';
    const match = text.match(HARNESST_MODEL_DIRECTIVE);
    if (match?.[1]) {
      return { id: match[1], contextWindowTokens: match[2] ? Number(match[2]) : undefined };
    }
  }
  return null;
}

export default defineAgent({
  model: defineDynamic({
    fallback: openrouter.chatModel('anthropic/claude-sonnet-5'),
    events: {
      'step.started': (_event, ctx) => {
        const selected = harnesstSelectedModel(ctx.messages);
        if (!selected) return null; // no directive -> the fallback model above
        return { model: openrouter.chatModel(selected.id), modelContextWindowTokens: selected.contextWindowTokens };
      },
    },
  }),
  modelContextWindowTokens: 200000,
});
`;

describe("readModel", () => {
  it("reads the string argument of a provider call", () => {
    expect(readModel(WRAPPED)).toBe("anthropic/claude-sonnet-4.5");
  });
  it("reads a plain string literal", () => {
    expect(readModel(PLAIN)).toBe("anthropic/claude-sonnet-5");
  });
  it("reads the defineDynamic fallback of a harnesst-written module", () => {
    expect(readModel(scaffoldAgentModule("anthropic/claude-sonnet-5"))).toBe(
      "anthropic/claude-sonnet-5",
    );
  });
  it("reads a user-authored gateway-string fallback", () => {
    const source = `import { defineAgent, defineDynamic } from 'eve';\nexport default defineAgent({\n  model: defineDynamic({ fallback: 'anthropic/claude-sonnet-5', events: {} }),\n});\n`;
    expect(readModel(source)).toBe("anthropic/claude-sonnet-5");
  });
});

describe("hasDynamicModel", () => {
  it("detects the dynamic wrapper harnesst writes", () => {
    expect(
      hasDynamicModel(scaffoldAgentModule("anthropic/claude-sonnet-5")),
    ).toBe(true);
    expect(hasDynamicModel(setModel(WRAPPED, "z-ai/glm-5.2"))).toBe(true);
  });
  it("is false for static modules — a static build ignores model directives", () => {
    expect(hasDynamicModel(WRAPPED)).toBe(false);
    expect(hasDynamicModel(LEGACY_WRAPPED)).toBe(false);
    expect(hasDynamicModel(PLAIN)).toBe(false);
    expect(hasDynamicModel(PRE_112)).toBe(false);
  });
  it("is false for a missing module", () => {
    expect(hasDynamicModel(null)).toBe(false);
    expect(hasDynamicModel(undefined)).toBe(false);
    expect(hasDynamicModel("")).toBe(false);
  });
});

describe("readModelContextWindow", () => {
  it("reads the declared tokens, with or without numeric separators", () => {
    expect(readModelContextWindow(WRAPPED)).toBe(200_000);
    expect(readModelContextWindow("modelContextWindowTokens: 1000000,")).toBe(
      1_000_000,
    );
  });
  it("is null when the prop is absent", () => {
    expect(readModelContextWindow(PLAIN)).toBeNull();
  });
});

/** Structural invariants of the dynamic model wrapper harnesst writes. */
function expectDynamicShape(source: string, model: string) {
  // The fallback (and the directive resolver) route through the harnesstModel(...) helper so a codex/*
  // id reaches harnesst's gateway while everything else stays OpenRouter (issue #28).
  expect(source).toContain(`fallback: harnesstModel('${model}')`);
  expect(source.match(/model\s*:\s*defineDynamic\s*\(/g)).toHaveLength(1);
  expect(source.match(/function harnesstSelectedModel/g)).toHaveLength(1);
  expect(source.match(/function harnesstModel/g)).toHaveLength(1);
  // The harnesstModel router needs both provider factories present exactly once.
  expect(
    source.match(/const harnesstGateway = createOpenAICompatible/g),
  ).toHaveLength(1);
  expect(source).toMatch(
    /import\s*\{[^}]*\bcreateAnthropic\b[^}]*\}\s*from\s*['"]@ai-sdk\/anthropic['"]/,
  );
  expect(source).toMatch(
    /import\s*\{[^}]*\bcreateOpenAI\b(?!\s+as\b)[^}]*\}\s*from\s*['"]@ai-sdk\/openai['"]/,
  );
  expect(source).toContain("createHmac");
  expect(source).toContain("timingSafeEqual");
  expect(source).toContain("HARNESST_MODEL_DIRECTIVE_SECRET");
  expect(source).toContain("<!--\\s*harnesst:sig");
  expect(source).toContain("'HARNESST_PROVIDER_' +");
  expect(source).toMatch(
    /import\s*\{[^}]*\bdefineDynamic\b[^}]*\}\s*from\s*['"]eve['"]/,
  );
  expect(source).toMatch(/['"]step\.started['"]/);
  expect(readModel(source)).toBe(model);
  // Any generated harnesstModel call site must ship with its router definition.
  if (/\bharnesstModel\s*\(/.test(source)) {
    expect(source).toContain("function harnesstModel(");
  }
}

describe("setModel", () => {
  it("upgrades a static provider call to the dynamic wrapper — never a duplicate model prop", () => {
    const next = setModel(WRAPPED, "z-ai/glm-5.2", {
      contextWindowTokens: 131_072,
    });
    expectDynamicShape(next, "z-ai/glm-5.2");
    expect(next).toContain("modelContextWindowTokens: 131072");
    expect(
      next.match(/\bmodel\s*:\s*openrouter\.chatModel\(['"`]/g),
    ).toBeNull();
  });

  it("retargets the fallback in place on re-save (idempotent wiring)", () => {
    const first = setModel(WRAPPED, "z-ai/glm-5.2");
    const second = setModel(first, "openai/gpt-5.1", {
      contextWindowTokens: 400_000,
    });
    expectDynamicShape(second, "openai/gpt-5.1");
    expect(second).toContain("modelContextWindowTokens: 400000");
    // No duplicated helper, import, or resolver from repeated saves.
    expect(second.match(/const HARNESST_MODEL_DIRECTIVE\b/g)).toHaveLength(1);
  });

  it("rewires a user-authored gateway-string fallback to the harnesstModel router", () => {
    const source = `import { defineAgent, defineDynamic } from 'eve';\n\nexport default defineAgent({\n  model: defineDynamic({ fallback: 'anthropic/claude-sonnet-5', events: {} }),\n});\n`;
    const next = setModel(source, "z-ai/glm-5.2");
    expect(next).toContain("fallback: harnesstModel('z-ai/glm-5.2')");
    expect(next).toContain("@ai-sdk/openai-compatible");
    expect(readModel(next)).toBe("z-ai/glm-5.2");
  });

  it("migrates the legacy OpenRouter provider wiring when setting a model", () => {
    const next = setModel(LEGACY_WRAPPED, "z-ai/glm-5.2");
    expect(next).toContain("@ai-sdk/openai-compatible");
    expect(next).not.toContain("@openrouter/ai-sdk-provider");
    expectDynamicShape(next, "z-ai/glm-5.2");
  });

  it("migrates a legacy factory with trailing commas / multiline formatting", () => {
    // As authored in the wild (harnesst-spike-agent): prettier adds a trailing comma, which the
    // old factory regex missed — leaving an orphan createOpenRouter call with no import.
    const legacy = `import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
});

export default defineAgent({
  model: openrouter("anthropic/claude-sonnet-4.5"),
});
`;
    const next = setModel(legacy, "z-ai/glm-5.2");
    expect(next).not.toContain("createOpenRouter");
    expect(next).toContain(
      "const openrouter = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY ?? '' });",
    );
    expectDynamicShape(next, "z-ai/glm-5.2");
  });

  it("converts a plain string literal to OpenRouter provider wiring", () => {
    const next = setModel(PLAIN, "openai/gpt-5.1", {
      contextWindowTokens: 400_000,
    });
    expect(next).toContain(
      `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';`,
    );
    expect(next).toContain(
      `const openrouter = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY ?? '' });`,
    );
    expectDynamicShape(next, "openai/gpt-5.1");
    expect(next).toContain("modelContextWindowTokens: 400000");
  });

  it("inserts wiring after multiline imports without duplicate or malformed bindings", () => {
    const source = `import {
  defineAgent,
  type AgentOptions,
} from "eve";
import {
  createAnthropic,
} from "@ai-sdk/anthropic";
import { createOpenAI as customOpenAI } from "@ai-sdk/openai";
import { createHmac } from "node:crypto";

export default defineAgent({
  model: "legacy/model",
} satisfies AgentOptions);
`;
    const next = setModel(source, "anthropic/abcdefghijkl/claude-sonnet-4-5");
    expect(next).not.toContain("import {\nimport");
    expect(next).not.toContain(",, defineDynamic");
    expect(next.match(/\bcreateHmac\b/g)?.length).toBeGreaterThanOrEqual(2);
    expect(next.match(/import \{ createHmac \}/g)).toHaveLength(1);
    expect(next.match(/import \{ timingSafeEqual \}/g)).toHaveLength(1);
    expect(next.match(/import \{ createOpenAI \}/g)).toHaveLength(1);
    expect(next).toContain("import { defineDynamic } from 'eve';");
    expectDynamicShape(next, "anthropic/abcdefghijkl/claude-sonnet-4-5");
  });

  it("still injects into defineAgent({...}) when no model exists", () => {
    const next = setModel(
      `import { defineAgent } from 'eve';\nexport default defineAgent({\n});\n`,
      "anthropic/claude-haiku-4-5",
    );
    expectDynamicShape(next, "anthropic/claude-haiku-4-5");
  });

  it("scaffolds OpenRouter wiring when no agent module exists", () => {
    const next = setModel("", "anthropic/claude-sonnet-5");
    expect(next).toContain("@ai-sdk/openai-compatible");
    expectDynamicShape(next, "anthropic/claude-sonnet-5");
    expect(next).toContain("modelContextWindowTokens: 200000");
  });

  it("routes a codex/<connection>/<slug> model through the harnesstModel gateway wrapper (issue #28)", () => {
    const id = "codex/abcdefghijkl/gpt-5.5";
    const next = setModel(WRAPPED, id, { contextWindowTokens: 272_000 });
    expectDynamicShape(next, id);
    // The gateway factory is wired so harnesstModel('codex/…') resolves at runtime.
    expect(next).toContain(
      "const harnesstGateway = createOpenAICompatible({ name: 'harnesst', baseURL: process.env.HARNESST_MODEL_GATEWAY_URL ?? '', apiKey: process.env.HARNESST_MODEL_GATEWAY_TOKEN ?? '' });",
    );
    expect(readModel(next)).toBe(id);
  });

  it("upgrades pre-#112 generated wiring for a Codex model", () => {
    const id = "codex/abcdefghijkl/gpt-5.5";
    const next = setModel(PRE_112, id);
    expectDynamicShape(next, id);
    expect(next).toContain("return { model: harnesstModel(selected.id)");
    expect(next).not.toContain("openrouter.chatModel(selected.id)");
    expect(
      next.match(/const harnesstGateway = createOpenAICompatible/g),
    ).toHaveLength(1);
  });

  it("upgrades pre-#112 generated wiring for an OpenRouter model", () => {
    const id = "openai/gpt-5.1";
    const next = setModel(PRE_112, id);
    expectDynamicShape(next, id);
    expect(next).toContain("return { model: harnesstModel(selected.id)");
    expect(next).not.toContain("openrouter.chatModel(selected.id)");
  });

  it("leaves current wiring byte-identical except for the requested fallback", () => {
    const current = scaffoldAgentModule("anthropic/claude-sonnet-5");
    const expected = current.replace(
      "fallback: harnesstModel('anthropic/claude-sonnet-5')",
      "fallback: harnesstModel('openai/gpt-5.1')",
    );
    const next = setModel(current, "openai/gpt-5.1");
    expect(next).toBe(expected);
    expectDynamicShape(next, "openai/gpt-5.1");
  });

  it("preserves user code next to harnesst's generated helper while upgrading it", () => {
    const current = scaffoldAgentModule("anthropic/claude-sonnet-5").replace(
      "\nexport default defineAgent",
      "\nconst userOwned = 'keep me';\n\nexport default defineAgent",
    );
    const next = setModel(current, "openai/abcdefghijkl/gpt-5.4");
    expect(next).toContain("const userOwned = 'keep me';");
    expectDynamicShape(next, "openai/abcdefghijkl/gpt-5.4");
  });

  it("rewrites the checked-in engineer template without duplicating its model router", () => {
    const current = readFileSync(
      path.join(
        process.cwd(),
        "catalog/templates/agents/engineer/files/agent.ts",
      ),
      "utf8",
    );
    const model = "anthropic/abcdefghijkl/claude-sonnet-4-5";
    const next = setModel(current, model);
    expect(next.match(/function harnesstSelectedModel/g)).toHaveLength(1);
    expect(next.match(/function harnesstModel/g)).toHaveLength(1);
    expectDynamicShape(next, model);
  });

  it("writes, reads, changes, and clears explicit reasoning effort idempotently", () => {
    const high = setModel(WRAPPED, "openai/abcdefghijkl/gpt-5.2", {
      effort: "high",
    });
    expect(readReasoningEffort(high)).toBe("high");
    expect(high).toContain("harnesstModel('openai/abcdefghijkl/gpt-5.2', 'high')");
    expect(high).toContain("reasoning: effort");

    const low = setModel(high, "openai/abcdefghijkl/gpt-5.2", {
      effort: "low",
    });
    expect(readReasoningEffort(low)).toBe("low");
    expect(low.match(/function harnesstReasoningModel/g)).toHaveLength(1);
    // `ai`'s LanguageModel union includes bare id strings, which eve's model slot rejects — the
    // generated signature must exclude them or `tsc --noEmit` fails in the publish gate.
    expect(low).toContain(
      "function harnesstReasoningModel(model: Exclude<LanguageModel, string>",
    );
    expect(
      setModel(low, "openai/abcdefghijkl/gpt-5.2", { effort: "low" }),
    ).toBe(low);

    const providerDefault = setModel(low, "openai/abcdefghijkl/gpt-5.2", {
      effort: null,
    });
    expect(readReasoningEffort(providerDefault)).toBeNull();
    expect(providerDefault).toContain(
      "fallback: harnesstModel('openai/abcdefghijkl/gpt-5.2')",
    );
  });

  it("removes a stale static reasoning property when provider default is selected", () => {
    const source = `import { defineAgent } from 'eve';

export default defineAgent({
  model: 'openai/abcdefghijkl/gpt-5.2',
  reasoning: 'high',
});
`;

    const providerDefault = setModel(source, "openai/abcdefghijkl/gpt-5.2", {
      effort: null,
    });
    expect(readReasoningEffort(providerDefault)).toBeNull();
    expect(providerDefault).not.toContain("reasoning: 'high'");

    const low = setModel(source, "openai/abcdefghijkl/gpt-5.2", {
      effort: "low",
    });
    expect(readReasoningEffort(low)).toBe("low");
    expect(low).not.toContain("reasoning: 'high'");
  });
});

describe("ensureModelProviderDependencies", () => {
  it("adds every provider dependency without dropping existing dependencies", () => {
    const next = ensureModelProviderDependencies(
      JSON.stringify(
        { dependencies: { eve: "^0.22.0", zod: "^3.23.0" } },
        null,
        2,
      ) + "\n",
    );
    expect(JSON.parse(next).dependencies).toEqual({
      "@ai-sdk/anthropic": "^4.0.12",
      "@ai-sdk/openai": "^4.0.11",
      "@ai-sdk/openai-compatible": "^3.0.7",
      ai: "^7.0.0",
      eve: "^0.22.0",
      zod: "^4.4.3",
    });
  });

  it("keeps package.json unchanged when the dependency already exists", () => {
    const pkg =
      JSON.stringify(
        {
          dependencies: {
            "@ai-sdk/anthropic": "^4.0.12",
            "@ai-sdk/openai": "^4.0.11",
            "@ai-sdk/openai-compatible": "^3.0.7",
            ai: "^7.0.0",
            zod: "^4.4.3",
          },
        },
        null,
        2,
      ) + "\n";
    expect(ensureModelProviderDependencies(pkg)).toBe(pkg);
  });

  it("upgrades the old provider pin and zod 3 peer conflict", () => {
    const next = ensureModelProviderDependencies(
      JSON.stringify(
        {
          dependencies: {
            "@openrouter/ai-sdk-provider": "^2.10.0",
            eve: "^0.23.1",
            zod: "^3.23.0",
          },
        },
        null,
        2,
      ) + "\n",
    );
    expect(JSON.parse(next).dependencies).toEqual({
      "@ai-sdk/anthropic": "^4.0.12",
      "@ai-sdk/openai": "^4.0.11",
      "@ai-sdk/openai-compatible": "^3.0.7",
      ai: "^7.0.0",
      eve: "^0.23.1",
      zod: "^4.4.3",
    });
  });

  it("bumps an eve pin too old for defineDynamic (< 0.22)", () => {
    // A 0.x caret can never reach 0.22 — the generated agent.ts would import a
    // non-existent export and fail the build gate.
    const next = ensureModelProviderDependencies(
      JSON.stringify(
        {
          dependencies: {
            "@openrouter/ai-sdk-provider": "^2.10.0",
            eve: "^0.18.1",
            zod: "^3.23.0",
          },
        },
        null,
        2,
      ) + "\n",
    );
    expect(JSON.parse(next).dependencies.eve).toBe("^0.22.0");
  });

  it("leaves guaranteed-modern, absent, or fork eve specs alone", () => {
    for (const eve of [
      "^0.22.0",
      "~0.22.4",
      ">=0.22.0",
      "0.22.1",
      "^1.0.0",
      "github:someone/eve",
      "file:../eve",
      undefined,
    ]) {
      const pkg =
        JSON.stringify(
          {
            dependencies: {
              "@ai-sdk/anthropic": "^4.0.12",
              "@ai-sdk/openai": "^4.0.11",
              "@ai-sdk/openai-compatible": "^3.0.7",
              ai: "^7.0.0",
              ...(eve === undefined ? {} : { eve }),
              zod: "^4.4.3",
            },
          },
          null,
          2,
        ) + "\n";
      expect(ensureModelProviderDependencies(pkg)).toBe(pkg);
    }
  });

  it("pins floating eve specs — the docker layer cache freezes them at first install", () => {
    // "latest" resolves at npm-install time, but agent builds reuse the cached install layer
    // as long as package.json's bytes are unchanged, so "latest" silently stays whatever
    // version the first build got (a prod repo was stuck on eve 0.20.0 — no defineDynamic,
    // failed publish gate). The rewrite is the cache-buster.
    for (const eve of ["latest", "*", "next", ">=0.20.0", "^0.18.1"]) {
      const pkg =
        JSON.stringify(
          {
            dependencies: {
              "@ai-sdk/anthropic": "^4.0.12",
              "@ai-sdk/openai": "^4.0.11",
              "@ai-sdk/openai-compatible": "^3.0.7",
              eve,
              zod: "^4.4.3",
            },
          },
          null,
          2,
        ) + "\n";
      expect(
        JSON.parse(ensureModelProviderDependencies(pkg)).dependencies.eve,
      ).toBe("^0.22.0");
    }
  });
});

/**
 * The generated router must never throw while the MODULE evaluates: `eve build` runs inside
 * `docker build`, where harnesst deliberately injects no HARNESST_PROVIDER_* credentials (they reach only
 * the running container). A module-scope throw failed every publish-gate and deploy image build
 * for qualified anthropic/openai/openrouter references. The "No credential was deployed" error is
 * deferred into a request-time middleware instead.
 */
describe("harnesstModel missing-credential deferral", () => {
  it("keeps the credential error out of harnesstModel's synchronous path", () => {
    const source = scaffoldAgentModule("openrouter/abcdefghijkl/z-ai/glm-5.2");
    const errorAt = source.indexOf("No credential was deployed");
    expect(errorAt).toBeGreaterThan(-1);
    // The throw may only live inside a deferred middleware (transformParams), not in the
    // synchronous body between `function harnesstModel(` and the middleware wrapper.
    const before = source.slice(0, errorAt);
    const routerAt = before.lastIndexOf("function harnesstModel(");
    expect(routerAt).toBeGreaterThan(-1);
    expect(before.lastIndexOf("transformParams")).toBeGreaterThan(routerAt);
    // A missing key builds the model with a placeholder instead of exploding at module scope.
    expect(source).toContain("harnesst-missing-credential");
  });

  it("mirrors the deferral in the engineer template's copy of the router", () => {
    const source = readFileSync(
      path.join(
        __dirname,
        "../../catalog/templates/agents/engineer/files/agent.ts",
      ),
      "utf8",
    );
    const errorAt = source.indexOf("No credential was deployed");
    expect(errorAt).toBeGreaterThan(-1);
    const before = source.slice(0, errorAt);
    const routerAt = before.lastIndexOf("function harnesstModel(");
    expect(routerAt).toBeGreaterThan(-1);
    expect(before.lastIndexOf("transformParams")).toBeGreaterThan(routerAt);
    expect(source).toContain("harnesst-missing-credential");
  });
});
