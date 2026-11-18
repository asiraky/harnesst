/**
 * Record a Playground turn into the runs store so the Observe pillar (Runs tab) has something
 * to show for managed/local instances that don't push OTel telemetry. This is the only
 * telemetry PRODUCER in the app: harnesst already consumes eve's event stream on every playground
 * turn (see agent/talk.server.ts), so we fold that same stream into `ingestRun` directly — no
 * HTTP, no ingest token (that path is for BYO instances).
 *
 * Two calls per turn:
 *   - `recordTurnStart` when the turn's id is first known → a `running` row (in-flight runs
 *     show up live in the Runs tab).
 *   - `recordTurnFinish` when it settles → an idempotent upsert (same externalRunId) carrying
 *     the completed status, summed tokens, wall-clock, and the full step list.
 *
 * Recording must NEVER break the user-facing stream — callers wrap these in try/catch. The
 * pure `turnToSteps` mapper is exported separately so the shape is unit-testable without a DB.
 */
import type { TurnResult } from "~/agent/talk.server";
import { tokensForBytes, utf8Bytes } from "~/lib/token-estimate";
import { capField, capString } from "~/observability/capture.server";
import { chooseRunModel, type RunModel } from "~/observability/run-model";
import { resolveRunModel } from "~/observability/run-model.server";
import {
  linkChildRuns,
  parentCallForChild,
  parentCallName,
} from "~/observability/subagent-link.server";
import type { SubagentCall } from "~/observability/turn-usage";
import {
  ingestRun,
  ingestRunStart,
  type IngestPayload,
  type IngestStep,
} from "~/observability/store.server";

/**
 * eve turn ids (turn_0, turn_1, …) are only unique per session, and runs are unique per
 * (project, externalRunId) — so scope the id with the session.
 */
export function externalRunId(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

/** Build a capped assistant/user `message` step's data (`{role, text, truncated?}`). */
function messageData(
  role: "user" | "assistant",
  text: string,
): Record<string, unknown> {
  const { text: capped, truncated } = capString(text);
  return truncated
    ? { role, text: capped, truncated: true }
    : { role, text: capped };
}

/** A tool output's size in UTF-8 bytes as the model saw it: the text itself, else its JSON. */
export function outputBytes(output: unknown): number | null {
  if (output === undefined) return null;
  if (typeof output === "string") return utf8Bytes(output);
  try {
    const json = JSON.stringify(output);
    return json === undefined ? null : utf8Bytes(json);
  } catch {
    return null;
  }
}

/**
 * Build a `tool_call` step's data: full input/output (capped) + summary/exitCode markers, and the
 * output's size measured before the cap.
 */
function toolCall(action: {
  input?: unknown;
  output?: unknown;
  summary?: string;
  exitCode?: number;
  subagentCall?: SubagentCall;
}): {
  data: Record<string, unknown>;
  childSessionId?: string;
  resultBytes?: number;
  resultTokens?: number;
  resultCapped?: boolean;
} {
  const bytes = outputBytes(action.output);
  const input = capField(action.input);
  const output = capField(action.output);
  const data: Record<string, unknown> = {};
  if (action.input !== undefined) data.input = input.value;
  if (action.output !== undefined) data.output = output.value;
  if (action.summary != null) data.summary = action.summary;
  if (action.exitCode != null) data.exitCode = action.exitCode;
  if (input.truncated || output.truncated) data.truncated = true;
  const child = action.subagentCall?.childSessionId
    ? { childSessionId: action.subagentCall.childSessionId }
    : {};
  if (action.subagentCall?.name) data.subagentName = action.subagentCall.name;
  if (bytes === null) return { data, ...child };
  return {
    data,
    ...child,
    resultBytes: bytes,
    resultTokens: tokensForBytes(bytes),
    resultCapped: output.truncated,
  };
}

/**
 * Map a settled `TurnResult` into ordered ingest steps forming a readable narrative:
 *   - an optional leading `message` (role:user) carrying the triggering input,
 *   - for each agent step, one `model_call` then one `tool_call` per action (full I/O), with
 *   - assistant `message` steps interleaved at their true position (via `messages`), or the
 *     joined `reply` as a trailing assistant message when no ordering info exists (legacy).
 * A `compaction` step sits before the model call it made room for. Every model call carries eve's
 * session, turn and step (the join to the gateway call log) and, in a subagent's child session,
 * the subagent's name and the parent's call id. A tool call that started a subagent carries its
 * name and, when the stream said, the child session it ran in.
 * All rich fields are size-capped (see capture.server.ts); redaction happens at ingest. Pure
 * (no DB) so it can be unit-tested. Seq is monotonic from 1.
 *
 * `model` is the run's resolved model (`./run-model`); without one, the turn's own id is used
 * unless it is only the dynamic build-time fallback.
 */
export function turnToSteps(
  result: TurnResult,
  opts: {
    userMessage?: string | null;
    model?: RunModel;
    eveSessionId?: string | null;
  } = {},
): IngestStep[] {
  const steps: IngestStep[] = [];
  let seq = 1;
  const model = opts.model ?? chooseRunModel(result, null);
  const eveSessionId = result.sessionId ?? opts.eveSessionId ?? undefined;
  const turnId = result.turnId ?? undefined;
  const subagent = result.subagent
    ? {
        subagentName: result.subagent.name ?? undefined,
        parentCallId: result.subagent.parentCallId,
      }
    : {};

  if (opts.userMessage && opts.userMessage.trim()) {
    steps.push({
      seq: seq++,
      type: "message",
      data: messageData("user", opts.userMessage),
    });
  }

  // Assistant messages keyed by how many agent steps preceded them. Legacy results (no
  // `messages`) fall back to the joined reply pinned after the last step.
  const messages =
    result.messages && result.messages.length > 0
      ? result.messages
      : result.reply
        ? [{ afterStepIndex: result.steps.length, text: result.reply }]
        : [];
  const emitMessagesAt = (stepCount: number) => {
    for (const m of messages) {
      if (m.afterStepIndex === stepCount) {
        steps.push({
          seq: seq++,
          type: "message",
          data: messageData("assistant", m.text),
        });
      }
    }
  };

  const compactions = result.compactions ?? [];
  const emitCompactionsAt = (stepCount: number) => {
    for (const c of compactions) {
      if (c.afterStepIndex !== stepCount) continue;
      steps.push({
        seq: seq++,
        type: "compaction",
        model: c.modelId ?? undefined,
        startedAt: c.at,
        eveSessionId,
        turnId,
        data: {
          usageInputTokens: c.usageInputTokens,
          sequence: c.sequence,
          completed: c.completed,
        },
      });
    }
  };

  emitMessagesAt(0);
  emitCompactionsAt(0);
  result.steps.forEach((step, i) => {
    steps.push({
      seq: seq++,
      type: "model_call",
      model: model.modelId ?? undefined,
      contextWindow: model.contextWindowTokens ?? undefined,
      tokensInput: step.tokensIn,
      tokensOutput: step.tokensOut,
      tokensCacheRead: step.cacheReadTokens,
      tokensCacheWrite: step.cacheWriteTokens,
      costUsd: step.costUsd,
      eveSessionId,
      turnId,
      stepIndex: step.stepIndex,
      ...subagent,
      durationMs: step.durationMs,
      isError: step.isError,
      data: step.isError
        ? { message: step.message, code: step.code, details: step.details }
        : undefined,
    });
    for (const action of step.actions ?? []) {
      steps.push({
        seq: seq++,
        type: "tool_call",
        toolName: action.toolName,
        isError: action.isError,
        callId: action.callId,
        ...subagent,
        ...toolCall(action),
      });
    }
    emitMessagesAt(i + 1);
    emitCompactionsAt(i + 1);
  });

  return steps;
}

/** The subagent calls a turn made, each with the child session it started. */
export function subagentCallsOf(result: TurnResult): SubagentCall[] {
  return result.steps.flatMap((step) =>
    (step.actions ?? []).flatMap((a) => (a.subagentCall ? [a.subagentCall] : [])),
  );
}

/** The run channel eve's subagent sessions are recorded under. */
const SUBAGENT_CHANNEL = "subagent";

/**
 * Which lookup completes a turn's subagent link at record time, if any:
 *   - `name`: the child knows its parent call (the hook forwarded it) but not the subagent's
 *     name, which the parent's tool call carries;
 *   - `child`: a subagent-channel turn that knows no parent (an agent image built before the
 *     hook forwarded one) looks for the parent call that recorded its session.
 * Other turns are not subagent children, so they pay for no lookup.
 */
export function parentLookupFor(
  result: TurnResult,
  channel: string,
):
  | { kind: "name"; parentSessionId: string; parentCallId: string }
  | { kind: "child" }
  | null {
  const parent = result.subagent;
  if (parent) {
    return !parent.name && parent.parentSessionId
      ? {
          kind: "name",
          parentSessionId: parent.parentSessionId,
          parentCallId: parent.parentCallId,
        }
      : null;
  }
  return channel === SUBAGENT_CHANNEL ? { kind: "child" } : null;
}

export interface RunTotals {
  tokensInput?: number;
  tokensOutput?: number;
  tokensCachedInput?: number;
  costUsd?: number;
  compactionCount?: number;
  peakContextTokens?: number;
}

function add(total: number | undefined, value: number | undefined) {
  return value == null ? total : (total ?? 0) + value;
}

/**
 * A run's totals over its model calls. Each total is absent when no step reported its field, so
 * "unknown" never reads as zero. Input tokens include cached ones (the AI SDK's `inputTokens` is
 * the whole prompt), which makes the largest input the peak context. A subagent's calls belong
 * to its own child-session run, so they are not added here.
 */
export function runTotals(result: TurnResult): RunTotals {
  let tokensInput: number | undefined;
  let tokensOutput: number | undefined;
  let tokensCachedInput: number | undefined;
  let costUsd: number | undefined;
  let peakContextTokens: number | undefined;
  for (const step of result.steps) {
    tokensInput = add(tokensInput, step.tokensIn);
    tokensOutput = add(tokensOutput, step.tokensOut);
    tokensCachedInput = add(tokensCachedInput, step.cacheReadTokens);
    costUsd = add(costUsd, step.costUsd);
    if (step.tokensIn != null)
      peakContextTokens = Math.max(peakContextTokens ?? 0, step.tokensIn);
  }
  // Compactions fire when context fills, so their trigger size is a context reading too.
  for (const c of result.compactions ?? []) {
    if (c.usageInputTokens != null)
      peakContextTokens = Math.max(peakContextTokens ?? 0, c.usageInputTokens);
  }
  const totals: RunTotals = {};
  // Input and output are written together, as before: a run reporting one reports both.
  if (tokensInput != null || tokensOutput != null) {
    totals.tokensInput = tokensInput ?? 0;
    totals.tokensOutput = tokensOutput ?? 0;
  }
  if (tokensCachedInput != null) totals.tokensCachedInput = tokensCachedInput;
  if (costUsd != null) totals.costUsd = costUsd;
  // A pass that never completed is still on its step; only finished ones count.
  if (result.compactions)
    totals.compactionCount = result.compactions.filter((c) => c.completed).length;
  if (peakContextTokens != null) totals.peakContextTokens = peakContextTokens;
  return totals;
}

export interface TurnIds {
  projectId: string;
  deploymentId: string;
  releaseId: string;
  externalRunId: string;
  externalSessionId: string;
  /** Triggering user message — stored on run metadata so in-flight runs show their input. */
  userMessage?: string | null;
  /** Producer channel — "playground" (default) or "teammate" (delegation relay, D6). */
  channel?: string;
  /** Extra run metadata (e.g. the delegation's `{ delegationId, fromAgentId, fromAgentName }`). */
  metadata?: Record<string, unknown>;
}

/** Build a run's metadata: the triggering input plus any producer-supplied fields. */
function runMetadata(
  userMessage: string | null | undefined,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {
    ...(userMessage ? { input: capString(userMessage).text } : {}),
    ...(extra ?? {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Add a `running` row so the turn shows while in flight. False means the deployment gate closed
 * before insertion; Discord uses that signal to avoid forwarding work to a stale target.
 */
export async function recordTurnStart(
  ids: TurnIds,
  now: Date = new Date(),
): Promise<boolean> {
  const channel = ids.channel ?? "playground";
  const payload: IngestPayload = {
    externalRunId: ids.externalRunId,
    deploymentId: ids.deploymentId,
    releaseId: ids.releaseId,
    channel,
    status: "running",
    startedAt: now.toISOString(),
    metadata: runMetadata(ids.userMessage, ids.metadata),
    session: {
      externalSessionId: ids.externalSessionId,
      trigger: channel,
      channel,
    },
  };
  return ingestRunStart(ids.projectId, {
    ...payload,
    deploymentId: ids.deploymentId,
    status: "running",
  });
}

/** Settle a start that the producer knows was never accepted (for example, relay failure). */
export async function recordTurnFailure(
  input: TurnIds & {
    error: string;
    startedAt: Date;
    finishedAt?: Date;
  },
): Promise<void> {
  const finishedAt = input.finishedAt ?? new Date();
  const channel = input.channel ?? "playground";
  await ingestRun(input.projectId, {
    externalRunId: input.externalRunId,
    deploymentId: input.deploymentId,
    releaseId: input.releaseId,
    channel,
    status: "failed",
    error: input.error,
    wallClockMs: Math.max(0, finishedAt.getTime() - input.startedAt.getTime()),
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    metadata: runMetadata(input.userMessage, input.metadata),
    session: {
      externalSessionId: input.externalSessionId,
      trigger: channel,
      channel,
    },
  });
}

/** Upsert the settled run: status, tokens, wall-clock, and the full step list. */
export async function recordTurnFinish(input: {
  projectId: string;
  deploymentId: string;
  releaseId: string;
  externalRunId: string;
  externalSessionId: string;
  result: TurnResult;
  /** Triggering user message — leads the transcript and is kept on run metadata. */
  userMessage?: string | null;
  /** Producer channel — "playground" (default) or "teammate" (delegation relay, D6). */
  channel?: string;
  /** Extra run metadata (e.g. the delegation's `{ delegationId, fromAgentId, fromAgentName }`). */
  metadata?: Record<string, unknown>;
  startedAt: Date;
  wallClockMs: number;
  finishedAt?: Date;
}): Promise<void> {
  const finishedAt = input.finishedAt ?? new Date();
  const channel = input.channel ?? "playground";
  // Complete a subagent child's link to its parent call (`./subagent-link.server`).
  let result = input.result;
  const lookup = parentLookupFor(result, channel);
  if (lookup?.kind === "name") {
    const name = await parentCallName(
      input.projectId,
      lookup.parentSessionId,
      lookup.parentCallId,
    );
    if (name && result.subagent)
      result = { ...result, subagent: { ...result.subagent, name } };
  } else if (lookup?.kind === "child") {
    const found = await parentCallForChild(
      input.projectId,
      result.sessionId ?? input.externalSessionId,
      input.startedAt,
    );
    if (found) result = { ...result, subagent: found };
  }
  const model = await resolveRunModel({
    projectId: input.projectId,
    releaseId: input.releaseId,
    turn: result,
    subagentName: result.subagent?.name ?? null,
  });
  const payload: IngestPayload = {
    externalRunId: input.externalRunId,
    deploymentId: input.deploymentId,
    releaseId: input.releaseId,
    channel,
    status: result.ok ? "completed" : "failed",
    error: result.error ?? undefined,
    wallClockMs: input.wallClockMs,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    metadata: runMetadata(input.userMessage, input.metadata),
    session: {
      externalSessionId: input.externalSessionId,
      trigger: channel,
      channel,
    },
    ...runTotals(result),
    steps: turnToSteps(result, {
      userMessage: input.userMessage,
      model,
      eveSessionId: input.externalSessionId,
    }),
  };
  await ingestRun(input.projectId, payload);
  // A child recorded before this parent turn gets its link now.
  const calls = subagentCallsOf(result);
  if (calls.length > 0)
    await linkChildRuns(input.projectId, calls, input.startedAt);
}
