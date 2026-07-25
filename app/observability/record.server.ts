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
import { capField, capString } from "~/observability/capture.server";
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

/** Build a `tool_call` step's data: full input/output (capped) + summary/exitCode markers. */
function toolData(action: {
  input?: unknown;
  output?: unknown;
  summary?: string;
  exitCode?: number;
}): Record<string, unknown> {
  const input = capField(action.input);
  const output = capField(action.output);
  const data: Record<string, unknown> = {};
  if (action.input !== undefined) data.input = input.value;
  if (action.output !== undefined) data.output = output.value;
  if (action.summary != null) data.summary = action.summary;
  if (action.exitCode != null) data.exitCode = action.exitCode;
  if (input.truncated || output.truncated) data.truncated = true;
  return data;
}

/**
 * Map a settled `TurnResult` into ordered ingest steps forming a readable narrative:
 *   - an optional leading `message` (role:user) carrying the triggering input,
 *   - for each agent step, one `model_call` then one `tool_call` per action (full I/O), with
 *   - assistant `message` steps interleaved at their true position (via `messages`), or the
 *     joined `reply` as a trailing assistant message when no ordering info exists (legacy).
 * All rich fields are size-capped (see capture.server.ts); redaction happens at ingest. Pure
 * (no DB) so it can be unit-tested. Seq is monotonic from 1.
 */
export function turnToSteps(
  result: TurnResult,
  opts: { userMessage?: string | null } = {},
): IngestStep[] {
  const steps: IngestStep[] = [];
  let seq = 1;

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

  emitMessagesAt(0);
  result.steps.forEach((step, i) => {
    steps.push({
      seq: seq++,
      type: "model_call",
      model: result.modelId ?? undefined,
      tokensInput: step.tokensIn,
      tokensOutput: step.tokensOut,
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
        data: toolData(action),
      });
    }
    emitMessagesAt(i + 1);
  });

  return steps;
}

/** Summed input/output tokens across all steps (undefined when nothing reported). */
function sumTokens(result: TurnResult): {
  tokensInput?: number;
  tokensOutput?: number;
} {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const step of result.steps) {
    if (step.tokensIn != null) {
      input += step.tokensIn;
      seen = true;
    }
    if (step.tokensOut != null) {
      output += step.tokensOut;
      seen = true;
    }
  }
  return seen ? { tokensInput: input, tokensOutput: output } : {};
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
  const payload: IngestPayload = {
    externalRunId: input.externalRunId,
    deploymentId: input.deploymentId,
    releaseId: input.releaseId,
    channel,
    status: input.result.ok ? "completed" : "failed",
    error: input.result.error ?? undefined,
    wallClockMs: input.wallClockMs,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    metadata: runMetadata(input.userMessage, input.metadata),
    session: {
      externalSessionId: input.externalSessionId,
      trigger: channel,
      channel,
    },
    ...sumTokens(input.result),
    steps: turnToSteps(input.result, { userMessage: input.userMessage }),
  };
  await ingestRun(input.projectId, payload);
}
