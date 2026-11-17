/**
 * The gateway call log record (issue #416): one row per upstream Codex call, assembled from what
 * the route knows before the call (who, which connection, what filled the context) and what the
 * upstream stream reported (first token, usage, failure). Pure, so the record a translated stream
 * produces is unit-testable without a network or a database.
 */
import { decodeJwtClaims } from "~/connections/codex.server";
import type { CallIdentity } from "./call-identity";
import type {
  ChatCompletionChunk,
  CodexUsage,
  SseRecord,
} from "./codex-translate";
import { CodexUpstreamError, readCodexUsage } from "./codex-translate";
import type { ContextComposition } from "./context-composition";

/** The ChatGPT plan a Codex access token was issued for (`pro`, `plus`, ...), or null. */
export function planTypeFromAccessToken(token: string): string | null {
  const auth = decodeJwtClaims(token)?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return null;
  const plan = (auth as Record<string, unknown>).chatgpt_plan_type;
  return typeof plan === "string" && plan ? plan : null;
}

/** The upstream's id for one request, from whichever header the response carries. */
export function upstreamRequestId(headers: Headers): string | null {
  return (
    headers.get("x-request-id") ??
    headers.get("openai-request-id") ??
    headers.get("x-oai-request-id") ??
    null
  );
}

const MAX_ERROR_MESSAGE = 2000;

function clip(text: string): string {
  return text.length > MAX_ERROR_MESSAGE
    ? `${text.slice(0, MAX_ERROR_MESSAGE)}…`
    : text;
}

/**
 * The error code and message from a non-OK upstream body: `{ error: { type|code, message } }`
 * (a 429 says `usage_limit_reached` here), `{ detail }`, or plain text.
 */
export function parseUpstreamError(text: string): {
  code: string | null;
  message: string | null;
} {
  const trimmed = text.trim();
  if (!trimmed) return { code: null, message: null };
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    const error =
      body.error && typeof body.error === "object"
        ? (body.error as Record<string, unknown>)
        : null;
    const code =
      (typeof error?.type === "string" && error.type) ||
      (typeof error?.code === "string" && error.code) ||
      (typeof body.code === "string" && body.code) ||
      null;
    const message =
      (typeof error?.message === "string" && error.message) ||
      (typeof body.detail === "string" && body.detail) ||
      (typeof body.message === "string" && body.message) ||
      trimmed;
    return { code, message: clip(message) };
  } catch {
    return { code: null, message: clip(trimmed) };
  }
}

export interface CallOutcome {
  ttftMs: number | null;
  finishReason: string | null;
  usage: CodexUsage | null;
  responseId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Watches one upstream stream. Call `observe` with each upstream record BEFORE translating it (a
 * failure event throws in the translator), then `emitted` with the chunks the translator produced
 * for it. `fail` records an error that ended the stream.
 */
export function createCallObserver(
  startedAt: number,
  now: () => number = Date.now,
) {
  const outcome: CallOutcome = {
    ttftMs: null,
    finishReason: null,
    usage: null,
    responseId: null,
    errorCode: null,
    errorMessage: null,
  };
  return {
    observe(record: SseRecord): void {
      if (record.data === "[DONE]") return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(record.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = (record.event ?? event.type ?? "") as string;
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") outcome.responseId = response.id;
      if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed"
      ) {
        const usage = readCodexUsage(response?.usage);
        if (usage) outcome.usage = usage;
      }
      if (type === "response.failed" || type === "error") {
        const error = (response?.error ?? event.error ?? event) as Record<
          string,
          unknown
        >;
        outcome.errorCode =
          (typeof error.code === "string" && error.code) ||
          (typeof error.type === "string" && error.type !== "error"
            ? error.type
            : null) ||
          outcome.errorCode;
      }
    },
    emitted(chunks: ChatCompletionChunk[]): void {
      for (const chunk of chunks) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) outcome.finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (
          outcome.ttftMs === null &&
          ((typeof delta.content === "string" && delta.content) ||
            delta.tool_calls)
        ) {
          outcome.ttftMs = Math.max(0, now() - startedAt);
        }
      }
    },
    fail(error: unknown, code?: string): void {
      outcome.errorMessage = clip(
        error instanceof Error ? error.message : String(error),
      );
      if (code) outcome.errorCode = code;
      else if (!(error instanceof CodexUpstreamError) && !outcome.errorCode)
        outcome.errorCode = "stream_error";
    },
    outcome(): CallOutcome {
      return { ...outcome };
    },
  };
}

/** What the route knows about a call before it goes upstream. */
export interface CallContext {
  orgId: string;
  /** `gateway` (an org token: agents, the assistant, the playground) or `eval` (a grant). */
  tokenKind: "gateway" | "eval";
  identity: CallIdentity;
  connectionId: string;
  accountId: string | null;
  planType: string | null;
  model: string;
  reasoningEffort: string | null;
  streamed: boolean;
  contextWindow: number | null;
  composition: ContextComposition;
}

/** One upstream attempt: when it started and what the response headers said. */
export interface CallAttempt {
  startedAt: number;
  httpStatus: number | null;
  upstreamRequestId: string | null;
}

export interface GatewayCallRow {
  orgId: string;
  projectId: string | null;
  tokenKind: string;
  agentName: string | null;
  subagentPath: string | null;
  sessionId: string | null;
  turnId: string | null;
  stepIndex: number | null;
  connectionId: string;
  accountId: string | null;
  planType: string | null;
  model: string;
  reasoningEffort: string | null;
  streamed: boolean;
  startedAt: Date;
  ttftMs: number | null;
  durationMs: number;
  httpStatus: number | null;
  finishReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  upstreamRequestId: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  contextWindow: number | null;
  composition: ContextComposition;
}

/** The row for one finished upstream call. `projectId` is the caller's claim, still unverified. */
export function buildGatewayCallRow(
  context: CallContext,
  attempt: CallAttempt,
  outcome: CallOutcome,
  endedAt: number,
): GatewayCallRow {
  return {
    orgId: context.orgId,
    projectId: context.identity.projectId,
    tokenKind: context.tokenKind,
    agentName: context.identity.agentName,
    subagentPath: context.identity.subagentPath,
    sessionId: context.identity.sessionId,
    turnId: context.identity.turnId,
    stepIndex: context.identity.stepIndex,
    connectionId: context.connectionId,
    accountId: context.accountId,
    planType: context.planType,
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    streamed: context.streamed,
    startedAt: new Date(attempt.startedAt),
    ttftMs: outcome.ttftMs,
    durationMs: Math.max(0, Math.round(endedAt - attempt.startedAt)),
    httpStatus: attempt.httpStatus,
    finishReason: outcome.finishReason,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
    upstreamRequestId: attempt.upstreamRequestId ?? outcome.responseId,
    inputTokens: outcome.usage?.inputTokens ?? null,
    cachedInputTokens: outcome.usage?.cachedInputTokens ?? null,
    outputTokens: outcome.usage?.outputTokens ?? null,
    reasoningTokens: outcome.usage?.reasoningTokens ?? null,
    contextWindow: context.contextWindow,
    composition: context.composition,
  };
}

export const NO_OUTCOME: CallOutcome = {
  ttftMs: null,
  finishReason: null,
  usage: null,
  responseId: null,
  errorCode: null,
  errorMessage: null,
};
