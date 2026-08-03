/**
 * The generated `harnesst/model.ts` workspace module — the single place a repo's agents (and
 * subagents) resolve their model, plus the matching `agent.ts` scaffold.
 *
 * The module exports ONE function, `harnesstAgentModel(agentName, subagentPath?)`, used verbatim
 * in every agent file: `model: harnesstAgentModel('<agent-name>')`. No agent file ever carries a
 * model string. Per step it resolves, in order:
 *
 *   1. the playground's signed per-conversation directive (model switching), else
 *   2. harnesst's workspace configuration (`GET <HARNESST_MODEL_GATEWAY_URL>/model-config`) — the
 *      target's explicit override when one exists, else the nearest ancestor's, else the
 *      workspace default model.
 *
 * A workspace with nothing configured produces a readable "set a model in Org settings"
 * error — by design, never a silent fallback. A declared subagent passes its PARENT agent's name
 * PLUS its own subagent path (issue #344), so it can carry its own selection; the inheritance
 * itself lives server-side, so a legacy module that passes only the parent name still resolves to
 * the parent's model. A configuration change in harnesst reaches running agents on their next
 * step with no code change and no redeploy.
 *
 * The module reuses the exact generated building blocks `setModel` injects into legacy
 * modules (`HARNESST_MODEL_HELPER`: the directive parser + the `harnesstModel` credential router), so
 * the two generations cannot drift on routing behavior.
 */
import {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  HARNESST_GATEWAY_FACTORY,
  HARNESST_MODEL_HELPER,
  OPENROUTER_FACTORY,
} from "~/eve/agentModule";
import { PLATFORM_ROOT, platformRootForAgentRoot, TEAM_ROOT } from "~/eve/parse";

const ORG_MODEL_MODULE_BASENAME = "model";
export const ORG_MODEL_MODULE_FILENAME = `${ORG_MODEL_MODULE_BASENAME}.ts`;

/**
 * The module path for an AGENT root, e.g. `agents/bob/agent` → `agents/bob/harnesst/model.ts`.
 *
 * It lives in the platform root, not the agent root (issue #254): eve claims every directory it
 * knows under `agent/` and errors on any it doesn't, so a shared module beside `agent.ts` is a
 * file eve tolerates only by accident. Beside the agent root it is ordinary package code that
 * eve's discovery never looks at — and it becomes platform-owned, so the editors refuse it and
 * nothing hand-edits the file every agent's model resolution depends on.
 */
export function orgModelModulePath(agentRoot: string): string {
  return `${platformRootForAgentRoot(agentRoot)}/${ORG_MODEL_MODULE_FILENAME}`;
}

/** The legacy in-agent-root location publish relocates away from (see `drafts.server.ts`). */
export const LEGACY_ORG_MODEL_MODULE_FILENAME = "harnesst-model.ts";

/** `agents/bob/agent` → `agents/bob/agent/harnesst-model.ts` — where pre-#254 repos keep it. */
export function legacyOrgModelModulePath(agentRoot: string): string {
  return `${agentRoot}/${LEGACY_ORG_MODEL_MODULE_FILENAME}`;
}

const ORG_MODEL_MODULE_PATH = new RegExp(
  `^(?:${TEAM_ROOT}/[A-Za-z0-9][\\w.-]*/)?${PLATFORM_ROOT}/${ORG_MODEL_MODULE_BASENAME}\\.ts$`,
);

/**
 * True for the generated model module itself (`harnesst/model.ts`,
 * `agents/<member>/harnesst/model.ts`).
 *
 * It is the one platform file no marketplace install owns — harnesst's own scaffold emits it —
 * so anything reasoning about platform-file provenance from the lock has to account for it
 * separately rather than reading it as an unknown intruder.
 */
export function isOrgModelModulePath(path: string): boolean {
  return ORG_MODEL_MODULE_PATH.test(path);
}

/**
 * The import specifier for the model module from a file `depth` directories below the AGENT
 * root. The module is the agent root's SIBLING, so every specifier first climbs out of the agent
 * root: the member's `agent.ts` (depth 0) imports `../harnesst/model.js`, a subagent's
 * `subagents/<name>/agent.ts` (depth 2) imports `../../../harnesst/model.js`. The arithmetic is
 * layout-independent — `agents/bob/agent/agent.ts` → `agents/bob/harnesst/model.ts` climbs
 * exactly as far as `agent/agent.ts` → `harnesst/model.ts`.
 */
export function orgModelImportSpecifier(depth = 0): string {
  return `${"../".repeat(Math.max(depth, 0) + 1)}${PLATFORM_ROOT}/${ORG_MODEL_MODULE_BASENAME}.js`;
}

/**
 * Any relative specifier resolving to the legacy module — with or without an extension, from any
 * depth. Anchored on the quote so a mention inside a comment or a string of prose is left alone.
 */
const LEGACY_ORG_MODEL_IMPORT = new RegExp(
  `(['"])(?:\\.{1,2}/)+${LEGACY_ORG_MODEL_MODULE_FILENAME.replace(/\.ts$/, "")}(?:\\.[jt]s)?\\1`,
  "g",
);

/** The relocated module before #336 added NodeNext's required emitted-file extension. */
const EXTENSIONLESS_ORG_MODEL_IMPORT = new RegExp(
  `(['"])(?:\\.{1,2}/)+${PLATFORM_ROOT}/${ORG_MODEL_MODULE_BASENAME}\\1`,
  "g",
);

/**
 * Rewrite every legacy `harnesst-model` or extensionless relocated import in `source` to the
 * NodeNext-safe module specifier, for a file `depth` directories below the agent root. Returns
 * `source` unchanged when there is none — callers use identity to decide whether the file needs
 * restaging at all.
 */
export function rewriteOrgModelImports(source: string, depth: number): string {
  const specifier = orgModelImportSpecifier(depth);
  const replace = (_match: string, quote: string) => `${quote}${specifier}${quote}`;
  return source
    .replace(LEGACY_ORG_MODEL_IMPORT, replace)
    .replace(EXTENSIONLESS_ORG_MODEL_IMPORT, replace);
}

const MODULE_HEADER = `// harnesst/model.ts — generated by harnesst. The one place this repo's agents resolve their model.
//
// \`harnesstAgentModel('<agent-name>')\` resolves per step:
//   1. the playground's signed per-conversation directive (model switching), else
//   2. the workspace's configured model for that target from harnesst — its explicit override
//      when one exists, else the nearest ancestor's, else the workspace default model.
// Nothing configured is a readable error (set a model in harnesst's Org settings), never a silent
// fallback. A declared subagent passes its PARENT agent's name plus its own subagent path
// (\`harnesstAgentModel('<parent>', 'researcher/fact-checker')\`) so it can carry its own
// selection; passing only the parent name inherits the parent. Configuration changes in harnesst
// reach a running agent on its next step — no code change, no redeploy.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { defineDynamic } from 'eve';

`;

const CONFIG_SECTION = `// ── Workspace model configuration (harnesst control plane) ────────────────────
type HarnesstReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
interface HarnesstModelConfig {
  model: string;
  effort: HarnesstReasoningEffort | null;
  contextWindowTokens: number | null;
}
// Cached briefly so a burst of steps doesn't hammer the control plane; a configuration change
// in harnesst still lands on a running agent within the TTL.
const HARNESST_MODEL_CONFIG_TTL_MS = 30_000;
const harnesstModelConfigCache = new Map<string, { at: number; config: HarnesstModelConfig }>();

async function harnesstConfiguredModel(
  agentName: string,
  subagentPath?: string,
): Promise<HarnesstModelConfig> {
  // The cache key is the TARGET, not the agent name: two subagents under one parent ask with the
  // same name and must not share each other's resolved model.
  const cacheKey = agentName + '#' + (subagentPath ?? '');
  const cached = harnesstModelConfigCache.get(cacheKey);
  if (cached && Date.now() - cached.at < HARNESST_MODEL_CONFIG_TTL_MS) return cached.config;
  const base = process.env.HARNESST_MODEL_GATEWAY_URL;
  const token = process.env.HARNESST_MODEL_GATEWAY_TOKEN;
  if (!base || !token) {
    throw new Error(
      'This build has no harnesst model coordinates (HARNESST_MODEL_GATEWAY_URL / HARNESST_MODEL_GATEWAY_TOKEN) — redeploy the agent from harnesst.',
    );
  }
  // The project id scopes the lookup to this repo, so a same-named agent in another repo in the
  // workspace cannot answer. Absent (older deploys) it resolves by name alone, as before.
  const projectId = process.env.HARNESST_PROJECT_ID;
  let url = base + '/model-config?agent=' + encodeURIComponent(agentName);
  if (subagentPath) url += '&subagent=' + encodeURIComponent(subagentPath);
  if (projectId) url += '&project=' + encodeURIComponent(projectId);
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      headers: { authorization: 'Bearer ' + token },
    });
  } catch (error) {
    throw new Error(
      'Could not reach harnesst to resolve the model for "' + agentName + '": ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const body = (await response.json().catch(() => null)) as {
    model?: string;
    effort?: HarnesstReasoningEffort | null;
    contextWindowTokens?: number | null;
    error?: { message?: string };
  } | null;
  if (!response.ok || !body || typeof body.model !== 'string') {
    throw new Error(
      body?.error?.message ?? 'harnesst model-config returned HTTP ' + response.status + '.',
    );
  }
  const config: HarnesstModelConfig = {
    model: body.model,
    effort: body.effort ?? null,
    contextWindowTokens: body.contextWindowTokens ?? null,
  };
  harnesstModelConfigCache.set(cacheKey, { at: Date.now(), config });
  return config;
}

/**
 * The model slot for the agent named \`agentName\`. A DECLARED SUBAGENT passes its parent agent's
 * name plus its own \`subagentPath\` (\`'researcher/fact-checker'\`, relative to the parent's agent
 * root): harnesst resolves that target's own selection when one is configured and otherwise
 * inherits the parent, so passing the parent name alone keeps a team on one model. The fallback
 * below is build-time metadata only; every served step resolves through the event handler.
 */
export function harnesstAgentModel(agentName: string, subagentPath?: string) {
  return defineDynamic({
    fallback: wrapLanguageModel({
      model: openrouter.chatModel('harnesst/unconfigured'),
      middleware: {
        specificationVersion: 'v4',
        transformParams: async () => {
          throw new Error(
            'The model for "' + agentName + '" resolves from harnesst\\'s workspace configuration at ' +
              'each step; this build-time fallback cannot serve requests. Set a model in ' +
              'harnesst\\'s Org settings.',
          );
        },
      },
    }),
    events: {
      'step.started': async (_event, ctx) => {
        const selected = harnesstSelectedModel(ctx.messages);
        if (selected) {
          return {
            model: harnesstModel(selected.id, selected.effort),
            modelContextWindowTokens: selected.contextWindowTokens,
          };
        }
        const configured = await harnesstConfiguredModel(agentName, subagentPath);
        return {
          model: harnesstModel(configured.model, configured.effort ?? undefined),
          modelContextWindowTokens: configured.contextWindowTokens ?? undefined,
        };
      },
    },
  });
}
`;

/** The complete generated `harnesst/model.ts` content. */
export function orgModelModuleSource(): string {
  return `${MODULE_HEADER}${OPENROUTER_FACTORY}${HARNESST_GATEWAY_FACTORY}\n${HARNESST_MODEL_HELPER}\n${CONFIG_SECTION}`;
}

/**
 * A fresh `agent.ts` for an agent named `agentName` — no model string anywhere; the workspace
 * configuration is the source of truth from day one.
 *
 * With `subagentPath` it scaffolds a DECLARED SUBAGENT's module instead: the resolver call carries
 * the parent's name plus the subagent's own path (so the subagent can hold its own selection and
 * otherwise inherits the parent), and the import climbs the two directories each `subagents/<x>/`
 * level adds — `agent/subagents/reader/agent.ts` is depth 2, `.../reader/subagents/skim/agent.ts`
 * is depth 4.
 */
export function scaffoldOrgModelAgentModule(
  agentName: string,
  opts?: { subagentPath?: string },
): string {
  const safe = (value: string) => value.replace(/['"`\\]/g, "");
  const segments = (opts?.subagentPath ?? "").split("/").filter(Boolean);
  const target = segments.length
    ? `'${safe(agentName)}', '${safe(segments.join("/"))}'`
    : `'${safe(agentName)}'`;
  return `import { defineAgent } from 'eve';

import { harnesstAgentModel } from '${orgModelImportSpecifier(2 * segments.length)}';

export default defineAgent({
  model: harnesstAgentModel(${target}),
  modelContextWindowTokens: ${DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS},
});
`;
}
