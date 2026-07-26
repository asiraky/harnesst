/**
 * Per-conversation model directive — the transport between the Playground's model selector and
 * a deployed agent's dynamic-model resolver.
 *
 * Eve's session API has no per-turn model field, so the selection travels as one
 * machine-readable HTML-comment line prepended to the SENT message (via `messagePrefix` in
 * `streamTurnResponse`):
 *
 *   <!-- harnesst:model anthropic/claude-sonnet-5 ctx=200000 -->
 *
 * The deployed agent's `step.started` resolver (emitted by `~/eve/agentModule`) parses the same
 * line to pick the model, and harnesst strips it from every display surface. Because the directive
 * is part of the durable `message.received` event, it doubles as the per-turn model record when
 * a transcript is replayed.
 *
 * Attribution: once an agent's `model:` is wrapped in `defineDynamic`, eve reports
 * `session.started → runtime.modelId` as `dynamic:<fallback id>` (verified against vercel/eve
 * `execution/node-step.ts`). `effectiveModelId` folds that prefix and the directive together so
 * both the live path (`~/agent/talk.server`) and replay (`~/playground/sessions.server`) show
 * the model that actually served the turn.
 */

import { parseProviderModelReference } from "~/models/provider-reference";
import type { ReasoningEffort } from "~/models/reasoning";

/** Eve prefixes `runtime.modelId` with this when the agent's model is a `defineDynamic`. */
export const DYNAMIC_MODEL_ID_PREFIX = "dynamic:";

export interface ModelDirective {
  /** Connection-qualified model reference (legacy bare OpenRouter ids remain parseable). */
  id: string;
  /** Context window of that model when known from its provider catalog. */
  contextWindowTokens?: number;
  /** Provider-independent reasoning effort, when explicitly selected. */
  effort?: ReasoningEffort;
}

/** Must stay in sync with HARNESST_MODEL_HELPER in `~/eve/agentModule` (the agent-side parser). */
const DIRECTIVE_RE =
  /^<!--\s*harnesst:model\s+(\S+?)(?:\s+ctx=(\d+))?(?:\s+effort=(none|minimal|low|medium|high|xhigh))?\s*-->(?:\n<!--\s*harnesst:sig\s+([a-f0-9]{64})\s*-->)?/;
const DIRECTIVE_LINE_RE =
  /^<!--\s*harnesst:model[^>]*-->(?:\n<!--\s*harnesst:sig\s+[a-f0-9]{64}\s*-->)?[ \t]*\n*/;

function normalizedDirective(directive: ModelDirective): {
  id: string;
  contextWindowTokens?: number;
  effort?: ReasoningEffort;
} {
  // The id lands inside an HTML comment and a regex — keep it to safe id characters.
  const id = directive.id.replace(/[^\w./:@-]/g, "");
  const ctx = directive.contextWindowTokens;
  const contextWindowTokens =
    typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0
      ? Math.round(ctx)
      : undefined;
  return { id, contextWindowTokens, effort: directive.effort };
}

/** Canonical bytes signed by harnesst and independently reconstructed in generated agent code. */
export function modelDirectiveSignaturePayload(
  directive: ModelDirective,
  body: string,
): string {
  const normalized = normalizedDirective(directive);
  const legacy = `${normalized.id}\n${normalized.contextWindowTokens ?? ""}\n`;
  // Preserve the original payload exactly when effort is absent. This lets new control planes
  // verify directives signed before effort was added, and old deployed agents verify new
  // directives that do not select an effort.
  return normalized.effort
    ? `${legacy}${normalized.effort}\n${body}`
    : `${legacy}${body}`;
}

/** The one-line directive to prepend to the sent message. */
export function buildModelDirective(
  directive: ModelDirective,
  signature?: string,
): string {
  const normalized = normalizedDirective(directive);
  const window = normalized.contextWindowTokens
    ? ` ctx=${normalized.contextWindowTokens}`
    : "";
  const effort = normalized.effort ? ` effort=${normalized.effort}` : "";
  const signed = signature ? `\n<!-- harnesst:sig ${signature} -->` : "";
  return `<!-- harnesst:model ${normalized.id}${window}${effort} -->${signed}`;
}

/** Parse the directive off the front of a sent message, or null when absent/malformed. */
export function parseModelDirective(text: string): ModelDirective | null {
  const match = text.match(DIRECTIVE_RE);
  if (!match) return null;
  return {
    id: match[1],
    contextWindowTokens: match[2] ? Number(match[2]) : undefined,
    effort: match[3] as ReasoningEffort | undefined,
  };
}

/** Remove the directive line (and the blank line after it) from a message for display. */
export function stripModelDirective(text: string): string {
  return text.replace(DIRECTIVE_LINE_RE, "");
}

/**
 * Eve reports a dynamic fallback as `<runtime provider>/<upstream model>`. harnesst names direct
 * provider instances with their connection id, preserving the qualified reference. OpenAI's
 * SDK appends its API flavor (`.responses`) to that provider name, so normalize it away. The
 * older OpenRouter scaffold and the Codex gateway add one wrapper segment which is also removed.
 */
function normalizeDynamicRuntimeId(runtimeId: string): string {
  const openai = runtimeId.match(
    /^openai\/([a-z]{12})\.(?:chat|responses)\/(.+)$/,
  );
  if (openai) return `openai/${openai[1]}/${openai[2]}`;

  // `@ai-sdk/openai-compatible` appends its API flavor to the configured provider name.
  const exactOpenRouter = runtimeId.match(
    /^openrouter\/([a-z]{12})\.(?:chat|completion)\/(.+)$/,
  );
  if (exactOpenRouter) {
    return `openrouter/${exactOpenRouter[1]}/${exactOpenRouter[2]}`;
  }
  const compatibleWrapper = runtimeId.match(
    /^(openrouter|harnesst)\.(?:chat|completion)\/(.+)$/,
  );
  if (compatibleWrapper) return compatibleWrapper[2];

  // Retain compatibility with runtime ids produced before the AI SDK provider-flavor suffix.
  if (parseProviderModelReference(runtimeId)) return runtimeId;
  if (runtimeId.startsWith("harnesst/")) return runtimeId.slice("harnesst/".length);
  if (runtimeId.startsWith("openrouter/")) {
    return runtimeId.slice("openrouter/".length);
  }
  return runtimeId;
}

/** Split eve's reported runtime id into the displayable base id + the dynamic-model flag. */
export function runtimeModelBase(runtimeModelId: string): {
  id: string;
  dynamic: boolean;
} {
  const dynamic = runtimeModelId.startsWith(DYNAMIC_MODEL_ID_PREFIX);
  if (!dynamic) return { id: runtimeModelId, dynamic };
  const id = normalizeDynamicRuntimeId(
    runtimeModelId.slice(DYNAMIC_MODEL_ID_PREFIX.length),
  );
  return { id, dynamic };
}

/**
 * The model that actually served a turn, from eve's reported runtime id + the sent message.
 * Static agents report a plain id (directives had no effect — ignore them); dynamic agents
 * report `dynamic:<fallback>`, overridden per turn by the message's directive.
 */
export function effectiveModelId(
  runtimeModelId: string,
  sentMessage: string,
): string {
  const base = runtimeModelBase(runtimeModelId);
  if (!base.dynamic) return base.id;
  return parseModelDirective(sentMessage)?.id ?? base.id;
}
