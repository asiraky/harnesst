/**
 * Minimal, pure read/write helpers for `agent/agent.ts` (the `defineAgent({...})` entrypoint).
 *
 * We deliberately avoid a full TS parse/print round-trip: for the runtime-config editor we
 * only need to read and set a small set of scalar options (model to start), and a targeted
 * source edit preserves the developer's formatting and comments (D3 — the repo stays theirs).
 * When `agent.ts` is absent we scaffold a minimal valid module.
 */

export const ANTHROPIC_PROVIDER_PACKAGE = "@ai-sdk/anthropic";
export const ANTHROPIC_PROVIDER_VERSION = "^4.0.12";
export const OPENAI_PROVIDER_PACKAGE = "@ai-sdk/openai";
export const OPENAI_PROVIDER_VERSION = "^4.0.11";
export const OPENROUTER_PROVIDER_PACKAGE = "@ai-sdk/openai-compatible";
export const OPENROUTER_PROVIDER_VERSION = "^3.0.7";
export const LEGACY_OPENROUTER_PROVIDER_PACKAGE = "@openrouter/ai-sdk-provider";
export const ZOD_PACKAGE = "zod";
export const ZOD_VERSION = "^4.4.3";
export const EVE_PACKAGE = "eve";
export const AI_PACKAGE = "ai";
export const AI_VERSION = "^7.0.0";
/** `defineDynamic` (root export) first shipped in eve@0.22.0 — the generated model wrapper needs it. */
export const EVE_MIN_VERSION = "^0.22.0";
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;

/** A curated OpenRouter shortlist for the picker; the UI also allows a free-text override. */
export const SUGGESTED_MODELS = [
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.1",
  "google/gemini-3.1-pro-preview",
  "z-ai/glm-5.2",
  "moonshotai/kimi-k2.7-code",
] as const;

const MODEL_LITERAL = /(\bmodel\s*:\s*)(['"`])([^'"`]*)\2/;
// Provider-wrapped form, e.g. `model: openrouter.chatModel("anthropic/claude-sonnet-4.5")`.
// We also keep reading the older `openrouter("...")` shape so existing repos can be migrated.
const MODEL_CALL =
  /(\bmodel\s*:\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(\s*(['"`])([^'"`]*)\3/;
// The same provider call, matched to its closing paren — used when the whole value is replaced
// (upgrading a static model to the harnesst dynamic wrapper below).
const MODEL_CALL_FULL =
  /(\bmodel\s*:\s*)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\s*(['"`])[^'"`]*\2\s*\)/;
// harnesst's dynamic wrapper: `model: defineDynamic({ fallback: openrouter.chatModel('id'), … })`.
// The deploy-default id lives in the fallback; the resolver honors the playground's
// per-conversation directive (see ~/models/model-directive).
const MODEL_DYNAMIC = /\bmodel\s*:\s*defineDynamic\s*\(/;
const FALLBACK_CALL =
  /(\bfallback\s*:\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(\s*(['"`])([^'"`]*)\3/;
const FALLBACK_HARNESST_FULL =
  /(\bfallback\s*:\s*)harnesstModel\(\s*(['"`])[^'"`]*\2(?:\s*,\s*(['"`])(?:none|minimal|low|medium|high|xhigh)\3)?\s*\)/;
const FALLBACK_LITERAL = /\bfallback\s*:\s*(['"`])([^'"`]*)\1/;
const FALLBACK_EFFORT =
  /\bfallback\s*:\s*harnesstModel\(\s*(['"`])[^'"`]*\1\s*,\s*(['"`])(none|minimal|low|medium|high|xhigh)\2\s*\)/;
const STATIC_REASONING_PROP =
  /^[ \t]*reasoning\s*:\s*(['"`])(?:none|minimal|low|medium|high|xhigh)\1\s*,?[ \t]*(?:\r?\n|$)/m;
const DEFINE_AGENT_OPEN = /defineAgent\s*\(\s*\{/;
const MODEL_CONTEXT = /(\bmodelContextWindowTokens\s*:\s*)[\d_]+/;
const MODEL_PROP =
  /\bmodel\s*:\s*(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\([^)]*\)|['"`][^'"`]*['"`])\s*,?/;
const ANTHROPIC_IMPORT = `import { createAnthropic } from '${ANTHROPIC_PROVIDER_PACKAGE}';\n`;
const OPENAI_IMPORT = `import { createOpenAI } from '${OPENAI_PROVIDER_PACKAGE}';\n`;
const OPENROUTER_IMPORT = `import { createOpenAICompatible } from '${OPENROUTER_PROVIDER_PACKAGE}';\n`;
const AI_IMPORT = `import { wrapLanguageModel, type LanguageModel } from '${AI_PACKAGE}';\n`;
const CRYPTO_IMPORT =
  "import { createHmac, timingSafeEqual } from 'node:crypto';\n";
const CREATE_HMAC_IMPORT = "import { createHmac } from 'node:crypto';\n";
const TIMING_SAFE_EQUAL_IMPORT =
  "import { timingSafeEqual } from 'node:crypto';\n";
export const OPENROUTER_FACTORY =
  "const openrouter = createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY ?? '' });\n";
// harnesst's model gateway (issue #28): a `codex/<connectionId>/<slug>` model runs on the org's
// connected Codex subscription through harnesst's translating gateway. The base URL + token are
// injected at deploy only when the org has a Codex connection; OpenRouter ids never touch it.
export const HARNESST_GATEWAY_FACTORY =
  "const harnesstGateway = createOpenAICompatible({ name: 'harnesst', baseURL: process.env.HARNESST_MODEL_GATEWAY_URL ?? '', apiKey: process.env.HARNESST_MODEL_GATEWAY_TOKEN ?? '' });\n";
const LEGACY_OPENROUTER_IMPORT =
  /import\s+\{\s*createOpenRouter\s*\}\s+from\s+['"]@openrouter\/ai-sdk-provider['"];\n?/;
const LEGACY_OPENROUTER_FACTORY =
  /const\s+openrouter\s*=\s*createOpenRouter\(\s*\{\s*apiKey\s*:\s*process\.env\.OPENROUTER_API_KEY\s*\?\?\s*(['"`])[^'"`]*\1\s*,?\s*\}\s*,?\s*\)\s*;?\n?/;

// Write-sites use the `harnesstModel(...)` router (defined in HARNESST_MODEL_HELPER) rather than a bare
// provider call so every qualified reference uses its exact connection credential.
function harnesstModelCall(model: string, effort?: string | null): string {
  return `harnesstModel('${model}'${effort ? `, '${effort}'` : ""})`;
}

function harnesstModelCallStart(model: string, effort?: string | null): string {
  return `harnesstModel('${model}'${effort ? `, '${effort}'` : ""}`;
}

/**
 * The message-directive parser injected into `agent.ts` alongside the dynamic model wrapper.
 * Its regex must stay in sync with `~/models/model-directive` (the harnesst-side builder/stripper).
 * Kept dependency-free (structural message type) so it compiles in any agent repo.
 */
export const HARNESST_MODEL_HELPER = `// harnesst playground model override: the playground pins a model per conversation by
// prefixing the sent message with one machine-readable line, e.g.
//   <!-- harnesst:model anthropic/<connection>/claude-sonnet-5 ctx=200000 effort=high -->
//   <!-- harnesst:sig <hmac> -->
// harnesst strips that line from every transcript surface; here it picks the model per step.
const HARNESST_MODEL_DIRECTIVE = /^<!--\\s*harnesst:model\\s+(\\S+?)(?:\\s+ctx=(\\d+))?(?:\\s+effort=(none|minimal|low|medium|high|xhigh))?\\s*-->\\n<!--\\s*harnesst:sig\\s+([a-f0-9]{64})\\s*-->\\n\\n([\\s\\S]*)$/;
function harnesstSelectedModel(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): { id: string; contextWindowTokens: number | undefined; effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (!entry || entry.role !== 'user') continue;
    const text =
      typeof entry.content === 'string'
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content
              .map((part) =>
                part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                  ? (part as { text: string }).text
                  : '',
              )
              .join('\\n')
          : '';
    const match = text.match(HARNESST_MODEL_DIRECTIVE);
    const secret = process.env.HARNESST_MODEL_DIRECTIVE_SECRET;
    if (match?.[1] && match[4] && secret) {
      const effortBytes = match[3] ? match[3] + '\\n' : '';
      const expected = createHmac('sha256', secret)
        .update(match[1] + '\\n' + (match[2] ?? '') + '\\n' + effortBytes + match[5])
        .digest();
      const received = Buffer.from(match[4], 'hex');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) continue;
      return { id: match[1], contextWindowTokens: match[2] ? Number(match[2]) : undefined, effort: match[3] as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined };
    }
  }
  return null;
}
// harnesst model router: qualified API-key references go directly to their provider with the exact
// connection credential. Codex OAuth alone uses harnesst's translating gateway. A bare id is an old
// OpenRouter reference and remains runnable so repos created before the connection model can be
// upgraded on their next model save.
function harnesstModel(id: string, effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh') {
  const qualified = id.match(/^(anthropic|codex|openai|openrouter)\\/([a-z]{12})\\/(.+)$/);
  if (!qualified) return harnesstReasoningModel(openrouter.chatModel(id), effort);
  const provider = qualified[1];
  const connectionId = qualified[2];
  const upstreamModelId = qualified[3];
  if (provider === 'codex') return harnesstReasoningModel(harnesstGateway.chatModel(id), effort);
  const envName =
    'HARNESST_PROVIDER_' + provider.toUpperCase() + '_' + connectionId.toUpperCase() + '_API_KEY';
  const apiKey = process.env[envName];
  // \`eve build\` evaluates this module INSIDE \`docker build\`, where harnesst deliberately injects no
  // connection credentials (they reach only the running container's env). A missing key must not
  // throw here — that would fail every publish-gate and deploy image build. Construct the model
  // with a placeholder and raise the same error on the first actual request instead.
  const key = apiKey ?? 'harnesst-missing-credential';
  const model =
    provider === 'anthropic'
      ? createAnthropic({ name: 'anthropic/' + connectionId, apiKey: key }).chat(upstreamModelId)
      : provider === 'openai'
        ? createOpenAI({ name: 'openai/' + connectionId, apiKey: key }).responses(upstreamModelId)
        : createOpenAICompatible({
            name: 'openrouter/' + connectionId,
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: key,
          }).chatModel(upstreamModelId);
  if (!apiKey) {
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: 'v4',
        transformParams: async () => {
          throw new Error('No credential was deployed for the selected ' + provider + ' connection.');
        },
      },
    });
  }
  return harnesstReasoningModel(model, effort);
}
// \`ai\`'s LanguageModel union admits bare gateway id strings, which eve's defineDynamic model slot
// rejects — exclude them so harnesstModel's inferred return type stays assignable.
function harnesstReasoningModel(model: Exclude<LanguageModel, string>, effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh') {
  if (!effort) return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({ ...params, reasoning: effort }),
    },
  });
}
`;

// harnesst owns the marked helper region. Match the generated selector plus its optional router, but
// stop before any neighboring user code between that wiring and the agent export.
const HARNESST_MODEL_HELPER_BLOCK =
  /\/\/ harnesst playground model override:[\s\S]*?\n}\n(?:(?:(?:[ \t]*|\/\/[^\n]*)\n)*function harnesstModel\s*\([\s\S]*?\n}\n)?(?:(?:(?:[ \t]*|\/\/[^\n]*)\n)*function harnesstReasoningModel\s*\([\s\S]*?\n}\n)?/;
const LEGACY_HARNESST_MODEL_RESOLVER =
  "return { model: openrouter.chatModel(selected.id), modelContextWindowTokens: selected.contextWindowTokens };";
const CURRENT_HARNESST_MODEL_RESOLVER =
  "return { model: harnesstModel(selected.id), modelContextWindowTokens: selected.contextWindowTokens };";

/** The `model:` value harnesst writes — deploy default as the fallback, directive override per step. */
function dynamicModelValue(model: string, effort?: string | null): string {
  return `defineDynamic({
    fallback: ${harnesstModelCall(model, effort)},
    events: {
      'step.started': (_event, ctx) => {
        const selected = harnesstSelectedModel(ctx.messages);
        if (!selected) return null; // no directive -> the fallback model above
        return { model: harnesstModel(selected.id, selected.effort), modelContextWindowTokens: selected.contextWindowTokens };
      },
    },
  })`;
}

/**
 * True when the module's `model:` is the harnesst dynamic wrapper — i.e. a build of this source
 * honors the playground's per-conversation model directive. A static module (plain provider
 * call or bare string) ignores the directive and always runs its baked-in model.
 */
export function hasDynamicModel(source: string | null | undefined): boolean {
  if (usesOrgModelResolver(source)) return true;
  return (
    typeof source === "string" &&
    MODEL_DYNAMIC.test(source) &&
    source.includes("HARNESST_MODEL_DIRECTIVE_SECRET") &&
    source.includes("timingSafeEqual")
  );
}

/** Read the model string from an agent module, or null if not found. */
export function readModel(source: string): string | null {
  // A workspace-resolver module has no baked-in model: the id lives in harnesst's org
  // configuration, and the resolver argument is an agent NAME, not a model.
  if (usesOrgModelResolver(source)) return null;
  if (MODEL_DYNAMIC.test(source)) {
    const fallbackCall = source.match(FALLBACK_CALL);
    if (fallbackCall) return fallbackCall[4];
    const fallbackLiteral = source.match(FALLBACK_LITERAL);
    if (fallbackLiteral) return fallbackLiteral[2];
  }
  const call = source.match(MODEL_CALL);
  if (call) return call[4];
  const m = source.match(MODEL_LITERAL);
  return m ? m[3] : null;
}

// The workspace-config resolver call harnesst scaffolds (`model: harnesstAgentModel('<agent-name>')`,
// exported by the repo's generated `harnesst/model.ts`). The module resolves the model at runtime
// from harnesst's org configuration, so the agent file itself never carries a model string.
// Deliberately matched on the CALL, never on the import specifier: the module moved out of the
// agent root in #254, and a repo mid-relocation still resolves its model the same way.
// The optional SECOND argument is a declared subagent's own path below the parent's agent root
// (issue #344) — absent in every pre-#344 module, which is exactly what marks one as needing the
// upgrade rewrite before its own selection can reach the runtime.
const ORG_MODEL_RESOLVER =
  /\bmodel\s*:\s*harnesstAgentModel\s*\(\s*(['"`])([^'"`]*)\1(?:\s*,\s*(['"`])([^'"`]*)\3)?/;

/**
 * True when the module's model is resolved through the workspace configuration
 * (`harnesstAgentModel(...)` from the generated `harnesst/model.ts`). Such a module has no baked-in
 * model: harnesst's Settings save writes the org override map instead of rewriting this file.
 */
export function usesOrgModelResolver(source: string | null | undefined): boolean {
  return typeof source === "string" && ORG_MODEL_RESOLVER.test(source);
}

/**
 * eve's DYNAMIC SUBAGENT declaration: a subagent module whose default export is
 * `defineDynamic(...)` is offered to a session only when its predicate says so, rather than being
 * permanently available. Deliberately anchored on the DEFAULT EXPORT — `MODEL_DYNAMIC` above
 * matches harnesst's unrelated `model: defineDynamic(...)` wrapper, and every harnesst-written
 * agent module carries one, so an unanchored test would call every subagent dynamic.
 */
const DYNAMIC_SUBAGENT = /export\s+default\s+defineDynamic\s*\(/;

/**
 * True when this subagent module is declared dynamically (see `DYNAMIC_SUBAGENT`). The UI shows
 * a "dynamic availability" badge for these: claiming a session-dependent capability is always
 * active would misreport what the agent can actually do (issue #344).
 */
export function isDynamicSubagentModule(source: string | null | undefined): boolean {
  return typeof source === "string" && DYNAMIC_SUBAGENT.test(source);
}

/** The agent name a `model: harnesstAgentModel('<name>')` module resolves itself by, or null. */
export function orgResolverAgentName(source: string): string | null {
  const match = source.match(ORG_MODEL_RESOLVER);
  return match ? match[2] : null;
}

/**
 * The full configuration target a resolver module asks harnesst for: the agent name and, for a
 * declared subagent that has been upgraded to the two-argument call, its own subagent path.
 * A module that passes only a name reads back as `subagentPath: ""` — it resolves the AGENT's
 * target and therefore inherits, which is what tells the write path an upgrade rewrite is due.
 */
export function orgResolverTarget(
  source: string,
): { agentName: string; subagentPath: string } | null {
  const match = source.match(ORG_MODEL_RESOLVER);
  return match ? { agentName: match[2], subagentPath: match[4] ?? "" } : null;
}

/**
 * Upgrade a resolver module's call to name its own target: `harnesstAgentModel('<parent>')` →
 * `harnesstAgentModel('<parent>', '<subagentPath>')` (and back, with `""`). Only the resolver
 * call is touched — everything else the subagent authored is left exactly as written. Returns
 * the source unchanged when there is no resolver call, so callers can use identity to decide
 * whether the file needs staging at all.
 */
export function setOrgResolverSubagentPath(
  source: string,
  subagentPath: string,
): string {
  const safe = subagentPath.replace(/['"`\\]/g, "");
  // The match stops at the last argument's closing quote — the call's `)` is not part of it and
  // must not be re-emitted.
  return source.replace(ORG_MODEL_RESOLVER, (_match, quote: string, name: string) =>
    safe
      ? `model: harnesstAgentModel(${quote}${name}${quote}, ${quote}${safe}${quote}`
      : `model: harnesstAgentModel(${quote}${name}${quote}`,
  );
}

/** Read harnesst's explicit fallback reasoning effort, or null for provider default. */
export function readReasoningEffort(
  source: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null {
  const fallback = source.match(FALLBACK_EFFORT);
  if (fallback) return fallback[3] as ReturnType<typeof readReasoningEffort>;
  const topLevel = source.match(
    /\breasoning\s*:\s*(['"`])(none|minimal|low|medium|high|xhigh)\1/,
  );
  return (topLevel?.[2] as ReturnType<typeof readReasoningEffort>) ?? null;
}

/** Read the declared `modelContextWindowTokens` from an agent module, or null if absent. */
export function readModelContextWindow(source: string): number | null {
  const match = source.match(/\bmodelContextWindowTokens\s*:\s*([\d_]+)/);
  if (!match) return null;
  const tokens = Number(match[1].replaceAll("_", ""));
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

function contextWindow(input?: {
  contextWindowTokens?: number | null;
}): number {
  const n = input?.contextWindowTokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.round(n)
    : DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
}

function importDeclarations(source: string): RegExpMatchArray[] {
  return [
    ...source.matchAll(
      /^import(?:[\s\S]*?\sfrom\s*)?["'][^"']+["'];?[ \t]*(?:\r?\n|$)/gm,
    ),
  ];
}

function insertProviderImport(source: string, statement: string): string {
  const imports = importDeclarations(source);
  if (imports.length === 0) return `${statement}${source}`;
  const last = imports[imports.length - 1];
  const at = (last.index ?? 0) + last[0].length;
  return `${source.slice(0, at)}${statement}${source.slice(at)}`;
}

function withNamedProviderImport(
  source: string,
  packageName: string,
  importedName: string,
  statement: string,
): string {
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namedImport = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${escapedPackage}\\2;?`,
    "g",
  );
  for (const match of source.matchAll(namedImport)) {
    if (new RegExp(`\\b${importedName}\\b(?!\\s+as\\b)`).test(match[1])) {
      return source;
    }
  }
  return insertProviderImport(source, statement);
}

function withModelProviderWiring(source: string): string {
  let next = source;
  next = next.replace(LEGACY_OPENROUTER_IMPORT, OPENROUTER_IMPORT);
  next = next.replace(LEGACY_OPENROUTER_FACTORY, OPENROUTER_FACTORY);
  next = withNamedProviderImport(
    next,
    "node:crypto",
    "createHmac",
    CREATE_HMAC_IMPORT,
  );
  next = withNamedProviderImport(
    next,
    AI_PACKAGE,
    "wrapLanguageModel",
    AI_IMPORT,
  );
  next = withNamedProviderImport(
    next,
    "node:crypto",
    "timingSafeEqual",
    TIMING_SAFE_EQUAL_IMPORT,
  );
  next = withNamedProviderImport(
    next,
    ANTHROPIC_PROVIDER_PACKAGE,
    "createAnthropic",
    ANTHROPIC_IMPORT,
  );
  next = withNamedProviderImport(
    next,
    OPENAI_PROVIDER_PACKAGE,
    "createOpenAI",
    OPENAI_IMPORT,
  );
  next = withNamedProviderImport(
    next,
    OPENROUTER_PROVIDER_PACKAGE,
    "createOpenAICompatible",
    OPENROUTER_IMPORT,
  );

  if (!/\bopenrouter\s*=/.test(next)) {
    const imports = importDeclarations(next);
    if (imports.length > 0) {
      const last = imports[imports.length - 1];
      const at = (last.index ?? 0) + last[0].length;
      next = `${next.slice(0, at)}\n${OPENROUTER_FACTORY}${next.slice(at)}`;
    } else {
      next = `${OPENROUTER_FACTORY}\n${next}`;
    }
  }
  return next;
}

/**
 * Ensure the `harnesstGateway` factory const exists (issue #28) so a `codex/*` fallback/directive can
 * route through harnesst's model gateway. Runs after `withModelProviderWiring` (which guarantees the
 * openrouter factory), inserting the gateway factory right after it; the `harnesstModel` router itself
 * ships in HARNESST_MODEL_HELPER via `withHarnesstDynamicWiring`.
 */
function withHarnesstGatewayWiring(source: string): string {
  if (/\bharnesstGateway\s*=/.test(source)) return source;
  const factory = source.match(/const\s+openrouter\s*=[^\n]*\n/);
  if (factory && factory.index !== undefined) {
    const at = factory.index + factory[0].length;
    return `${source.slice(0, at)}${HARNESST_GATEWAY_FACTORY}${source.slice(at)}`;
  }
  const imports = importDeclarations(source);
  if (imports.length > 0) {
    const last = imports[imports.length - 1];
    const at = (last.index ?? 0) + last[0].length;
    return `${source.slice(0, at)}\n${HARNESST_GATEWAY_FACTORY}${source.slice(at)}`;
  }
  return `${HARNESST_GATEWAY_FACTORY}\n${source}`;
}

function withContextWindow(source: string, tokens: number): string {
  const formatted = String(tokens);
  if (MODEL_CONTEXT.test(source)) {
    return source.replace(MODEL_CONTEXT, `$1${formatted}`);
  }
  return source.replace(MODEL_PROP, (match) => {
    const modelLine = match.trimEnd().endsWith(",")
      ? match.trimEnd()
      : `${match.trimEnd()},`;
    return `${modelLine}\n  modelContextWindowTokens: ${formatted},`;
  });
}

/** Ensure the `defineDynamic` import (value import from 'eve') and the directive helper exist. */
function withHarnesstDynamicWiring(source: string): string {
  let next = source;
  const hasDynamicImport =
    /import\s*(?!type\b)[^;]*\bdefineDynamic\b[^;]*from\s*['"]eve['"]/.test(
      next,
    );
  if (!hasDynamicImport) {
    next = insertProviderImport(next, "import { defineDynamic } from 'eve';\n");
  }
  if (HARNESST_MODEL_HELPER_BLOCK.test(next)) {
    next = next.replace(HARNESST_MODEL_HELPER_BLOCK, HARNESST_MODEL_HELPER);
  } else {
    next = /(^|\n)export default defineAgent/.test(next)
      ? next.replace(
          /(^|\n)(export default defineAgent)/,
          `$1${HARNESST_MODEL_HELPER}\n$2`,
        )
      : `${next}\n${HARNESST_MODEL_HELPER}`;
  }
  next = next.replace(LEGACY_HARNESST_MODEL_RESOLVER, CURRENT_HARNESST_MODEL_RESOLVER);
  return next;
}

/**
 * Return `source` with the model set to `model`. harnesst always writes the dynamic wrapper
 * (`defineDynamic` with the chosen model as the fallback + the playground-directive resolver),
 * so every save makes the agent playground-switchable. Strategy, in order:
 *  1. Retarget the fallback of an existing harnesst dynamic wrapper in place.
 *  2. Upgrade a static provider call or plain string literal to the dynamic wrapper.
 *  3. Inject a dynamic `model:` prop into an existing `defineAgent({ ... })`.
 *  4. Scaffold a fresh module.
 */
export function setModel(
  source: string,
  model: string,
  options?: { contextWindowTokens?: number | null; effort?: string | null },
): string {
  // The fallback effort lives on harnesst's model wrapper so a playground directive can replace it
  // per turn. Remove a static property first; otherwise clearing effort would leave it active.
  source = source.replace(STATIC_REASONING_PROP, "");
  const safe = model.replace(/['"`\\]/g, "");
  const tokens = contextWindow(options);
  // Replace INSIDE the existing wrapper/call first — injecting a second `model:` prop would
  // silently lose (object literals: last prop wins) and fail typecheck (duplicate property).
  if (
    MODEL_DYNAMIC.test(source) &&
    (FALLBACK_CALL.test(source) || FALLBACK_LITERAL.test(source))
  ) {
    let next = FALLBACK_HARNESST_FULL.test(source)
      ? source.replace(FALLBACK_HARNESST_FULL, (_match, prefix) => {
          return `${prefix}${harnesstModelCall(safe, options?.effort)}`;
        })
      : FALLBACK_CALL.test(source)
        ? source.replace(FALLBACK_CALL, (_match, prefix) => {
            return `${prefix}${harnesstModelCallStart(safe, options?.effort)}`;
          })
        : // A user-authored dynamic wrapper with a gateway-string fallback: rewire it to harnesstModel.
          source.replace(
            FALLBACK_LITERAL,
            `fallback: ${harnesstModelCall(safe, options?.effort)}`,
          );
    // MODEL_PROP would match only a prefix of the dynamic wrapper, so never append after it —
    // when the tokens prop is missing here, drop it right inside defineAgent({ instead.
    next = MODEL_CONTEXT.test(next)
      ? next.replace(MODEL_CONTEXT, `$1${tokens}`)
      : next.replace(
          DEFINE_AGENT_OPEN,
          (match) => `${match}\n  modelContextWindowTokens: ${tokens},`,
        );
    return withHarnesstDynamicWiring(
      withHarnesstGatewayWiring(withModelProviderWiring(next)),
    );
  }
  if (MODEL_CALL.test(source) || MODEL_LITERAL.test(source)) {
    // Set the context window while the model prop is still static (MODEL_PROP anchors on that
    // shape), then swap the static value for the dynamic wrapper.
    let next = withContextWindow(source, tokens);
    next = MODEL_CALL_FULL.test(next)
      ? next.replace(
          MODEL_CALL_FULL,
          (_match, prefix) =>
            `${prefix}${dynamicModelValue(safe, options?.effort)}`,
        )
      : next.replace(
          MODEL_LITERAL,
          (_match, prefix) =>
            `${prefix}${dynamicModelValue(safe, options?.effort)}`,
        );
    return withHarnesstDynamicWiring(
      withHarnesstGatewayWiring(withModelProviderWiring(next)),
    );
  }
  if (DEFINE_AGENT_OPEN.test(source)) {
    const next = source.replace(
      DEFINE_AGENT_OPEN,
      (match) =>
        `${match}\n  model: ${dynamicModelValue(safe, options?.effort)},\n  modelContextWindowTokens: ${tokens},`,
    );
    return withHarnesstDynamicWiring(
      withHarnesstGatewayWiring(withModelProviderWiring(next)),
    );
  }
  return scaffoldAgentModule(safe, {
    contextWindowTokens: tokens,
    effort: options?.effort,
  });
}

/** A minimal valid `agent.ts` for a new agent. */
export function scaffoldAgentModule(
  model: string,
  options?: { contextWindowTokens?: number | null; effort?: string | null },
): string {
  const safe = model.replace(/['"`\\]/g, "");
  const tokens = contextWindow(options);
  return `${CRYPTO_IMPORT}${ANTHROPIC_IMPORT}${OPENAI_IMPORT}${OPENROUTER_IMPORT}${AI_IMPORT}import { defineAgent, defineDynamic } from 'eve';\n\n${OPENROUTER_FACTORY}${HARNESST_GATEWAY_FACTORY}\n${HARNESST_MODEL_HELPER}\nexport default defineAgent({\n  model: ${dynamicModelValue(safe, options?.effort)},\n  modelContextWindowTokens: ${tokens},\n});\n`;
}

/**
 * True when a declared eve range GUARANTEES >= 0.22.0 (`defineDynamic`'s first release).
 * Absent specs pass — a team member's package.json may inherit eve from the repo root, and a
 * repo without eve anywhere was never going to build. URL-ish specs (git/file/github forks)
 * pass — they're deliberate user overrides harnesst must not clobber (D3). Floating specs
 * ("latest", "*", dist-tags, floorless ranges) FAIL even though npm would resolve them to a
 * modern eve today: agent images build behind a Docker layer cache keyed on package.json
 * bytes, so a floating spec stays frozen at whatever version the first build installed
 * (a prod repo's "latest" was stuck at 0.20.0). Rewriting to EVE_MIN_VERSION both guarantees
 * the API and changes the bytes, which busts the stale install layer.
 */
function eveSupportsDefineDynamic(spec: string | undefined): boolean {
  if (typeof spec !== "string") return true;
  const s = spec.trim();
  if (s.includes(":") || s.includes("/")) return true;
  const floor = s.match(
    /^(?:>=|[~^=v])?\s*(\d+)(?:\.(\d+))?(?:\.\d+)?(?:[-.].*)?$/,
  );
  if (!floor) return false;
  return Number(floor[1]) > 0 || Number(floor[2] ?? 0) >= 22;
}

export function ensureModelProviderDependencies(
  packageJson: string | null,
): string {
  const base = packageJson
    ? (JSON.parse(packageJson) as Record<string, unknown>)
    : {
        private: true,
        type: "module",
        scripts: { dev: "eve dev", build: "eve build" },
      };
  const current =
    base.dependencies && typeof base.dependencies === "object"
      ? (base.dependencies as Record<string, string>)
      : {};
  const providersOk =
    current[ANTHROPIC_PROVIDER_PACKAGE] === ANTHROPIC_PROVIDER_VERSION &&
    current[OPENAI_PROVIDER_PACKAGE] === OPENAI_PROVIDER_VERSION &&
    current[OPENROUTER_PROVIDER_PACKAGE] === OPENROUTER_PROVIDER_VERSION;
  const legacyProviderPresent =
    current[LEGACY_OPENROUTER_PROVIDER_PACKAGE] !== undefined;
  // The OpenAI-compatible provider tracks AI SDK v7's provider interfaces. Existing harnesst
  // scaffolds used zod ^3, so a model save must upgrade it or npm publish checks fail.
  const zodOk =
    typeof current[ZOD_PACKAGE] === "string" &&
    /\b4\b|4\./.test(current[ZOD_PACKAGE]);
  // The generated agent.ts imports `defineDynamic` from eve — a pin below 0.22 can't provide it.
  const eveOk = eveSupportsDefineDynamic(current[EVE_PACKAGE]);
  const aiOk =
    typeof current[AI_PACKAGE] === "string" &&
    /(?:^|\D)7(?:\D|$)/.test(current[AI_PACKAGE]);
  if (providersOk && !legacyProviderPresent && zodOk && eveOk && aiOk) {
    return packageJson ?? JSON.stringify(base, null, 2) + "\n";
  }
  const withoutLegacy = Object.fromEntries(
    Object.entries(current).filter(
      ([name]) => name !== LEGACY_OPENROUTER_PROVIDER_PACKAGE,
    ),
  );
  const dependencies = Object.fromEntries(
    Object.entries({
      ...withoutLegacy,
      [ANTHROPIC_PROVIDER_PACKAGE]: ANTHROPIC_PROVIDER_VERSION,
      [OPENAI_PROVIDER_PACKAGE]: OPENAI_PROVIDER_VERSION,
      [OPENROUTER_PROVIDER_PACKAGE]: OPENROUTER_PROVIDER_VERSION,
      ...(aiOk ? {} : { [AI_PACKAGE]: AI_VERSION }),
      ...(zodOk ? {} : { [ZOD_PACKAGE]: ZOD_VERSION }),
      ...(eveOk ? {} : { [EVE_PACKAGE]: EVE_MIN_VERSION }),
    }).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({ ...base, dependencies }, null, 2) + "\n";
}

/** @deprecated Use `ensureModelProviderDependencies`; retained for existing draft callers. */
export const ensureOpenRouterDependency = ensureModelProviderDependencies;
