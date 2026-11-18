/**
 * Usage, compaction and subagent facts read off eve's session stream (issue #417). Shared by the
 * live fold (`~/agent/talk.server`) and the replay fold (`./session-turns.server`) so both record
 * the same fields. Pure.
 *
 * What eve (0.29.5) actually puts on the stream, checked against its protocol types and emitters:
 *   - `step.completed.data.usage`: `inputTokens`, `outputTokens`, `cacheReadTokens`,
 *     `cacheWriteTokens`, `costUsd`. `costUsd` comes only from Vercel AI Gateway metadata.
 *     `providerMetadata` is cut down to `gateway.generationId`, so no provider's reasoning token
 *     count reaches the stream.
 *   - `compaction.requested` / `compaction.completed`: `modelId`, `sequence`, and on the request
 *     `usageInputTokens`, the context size that triggered it.
 *   - A subagent runs as its own child session; that session's `session.started` carries
 *     `invocation: { kind: "subagent", name, parentCallId, parentSessionId, parentTurnId }`.
 */
import { normalizeRuntimeModelId } from "~/models/model-directive";

export interface StepUsage {
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** The usage fields of one `step.completed`; each is absent when eve did not report it. */
export function readStepUsage(usage: unknown): StepUsage {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  const out: StepUsage = {};
  const tokensIn = count(u.inputTokens);
  const tokensOut = count(u.outputTokens);
  const cacheReadTokens = count(u.cacheReadTokens);
  const cacheWriteTokens = count(u.cacheWriteTokens);
  const costUsd = count(u.costUsd);
  if (tokensIn !== undefined) out.tokensIn = tokensIn;
  if (tokensOut !== undefined) out.tokensOut = tokensOut;
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  if (costUsd !== undefined) out.costUsd = costUsd;
  return out;
}

/**
 * eve's turn number and step index off a step event, each only when eve sent it: they join a step
 * to its gateway call-log row, so a guessed value would join the wrong row.
 */
export function stepKeyOf(data: Record<string, unknown>): {
  sequence?: number;
  stepIndex?: number;
} {
  const out: { sequence?: number; stepIndex?: number } = {};
  if (typeof data.sequence === "number") out.sequence = data.sequence;
  if (typeof data.stepIndex === "number") out.stepIndex = data.stepIndex;
  return out;
}

/** One compaction pass inside a turn. */
export interface TurnCompaction {
  /** How many model steps of the turn had completed when it was requested. */
  afterStepIndex: number;
  /** ISO time of `compaction.requested`. */
  at: string;
  sequence: number | null;
  /** The context size that triggered it; null when eve could not count it. */
  usageInputTokens: number | null;
  /** The model that wrote the checkpoint, in harnesst's reference form. */
  modelId: string | null;
  /** `compaction.completed` arrived. */
  completed: boolean;
}

/**
 * Fold one `compaction.requested` / `compaction.completed` into the turn's list. A completion
 * settles the latest open request of the same sequence.
 */
export function applyCompactionEvent(
  compactions: TurnCompaction[],
  type: string,
  data: Record<string, unknown>,
  at: Date,
  afterStepIndex: number,
): void {
  const sequence = typeof data.sequence === "number" ? data.sequence : null;
  const modelId =
    typeof data.modelId === "string" && data.modelId
      ? normalizeRuntimeModelId(data.modelId)
      : null;
  if (type === "compaction.requested") {
    compactions.push({
      afterStepIndex,
      at: at.toISOString(),
      sequence,
      usageInputTokens: count(data.usageInputTokens) ?? null,
      modelId,
      completed: false,
    });
    return;
  }
  if (type !== "compaction.completed") return;
  for (let i = compactions.length - 1; i >= 0; i--) {
    const open = compactions[i];
    if (open.completed || open.sequence !== sequence) continue;
    open.completed = true;
    open.modelId ??= modelId;
    return;
  }
  // The request fell outside what was read (a resumed drain): the pass still happened.
  compactions.push({
    afterStepIndex,
    at: at.toISOString(),
    sequence,
    usageInputTokens: null,
    modelId,
    completed: true,
  });
}

/** The parent call a subagent child session was started for. */
export interface SubagentInvocation {
  name: string;
  parentCallId: string;
  parentSessionId: string | null;
  parentTurnId: string | null;
}

/** The subagent linkage on a `session.started`, or null for a top-level session. */
export function readSubagentInvocation(
  data: Record<string, unknown>,
): SubagentInvocation | null {
  const invocation = data.invocation;
  if (!invocation || typeof invocation !== "object") return null;
  const i = invocation as Record<string, unknown>;
  if (i.kind !== "subagent") return null;
  if (typeof i.name !== "string" || typeof i.parentCallId !== "string")
    return null;
  return {
    name: i.name,
    parentCallId: i.parentCallId,
    parentSessionId:
      typeof i.parentSessionId === "string" ? i.parentSessionId : null,
    parentTurnId: typeof i.parentTurnId === "string" ? i.parentTurnId : null,
  };
}
