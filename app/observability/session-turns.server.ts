/**
 * Pure event folding for the channel-run reconciler (issue #119).
 *
 * eve's durable session stream (GET /eve/v1/session/:id/stream) REPLAYS a session's whole history
 * as ordered NDJSON events. Playground turns are folded live, in-process, by `streamTurn`
 * (agent/talk.server.ts); cron/Discord/other-channel turns are not — nobody drains their stream.
 * This module folds a REPLAYED history (many turns, no live yields, no "ours" filtering) into
 * per-turn `TurnResult`s the existing `turnToSteps`/`recordTurnFinish` chokepoint can ingest.
 *
 * It mirrors `streamTurn`'s per-event handling exactly (step durations, token usage, action
 * correlation by callId, interleaved assistant messages, failure text) but GROUPED per
 * `data.turnId` and driven off a static array. Kept pure (no DB, no fetch) so the fold is
 * unit-testable and the reconciler owns all I/O. The cursor math (`nextStreamIndex`) lets the
 * reconciler drain incrementally: settled turns advance the cursor; the first unsettled turn
 * parks it so the next drain re-reads that turn from its start (idempotent re-ingest).
 */
import type { RawEveEvent, TurnAction, TurnStep, TurnResult } from "~/agent/talk.server";
import { inputRequestsOf } from "~/agent/talk.server";
import type { ChatInputRequest } from "~/chat/types";
import { effectiveModelId } from "~/models/model-directive";

/** A replayed durable-stream event with its absolute stream position (for cursor math). */
export interface IndexedEveEvent extends RawEveEvent {
  /** startIndex + 1 + position — matches streamTurn's 1-based streamIndex labelling. */
  streamIndex: number;
}

export interface FoldedTurn {
  turnId: string;
  /** streamIndex of this turn's first event — where the reconciler parks if the turn is unsettled. */
  firstEventStreamIndex: number;
  userMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  /** turn.completed | turn.failed (or a session.waiting/session.failed that settled it) was seen. */
  settled: boolean;
  /** Feedable to turnToSteps/recordTurnFinish. */
  result: TurnResult;
}

export interface FoldedSession {
  /** Raw runtime model id from session.started (or carried in from a prior drain). */
  modelId: string | null;
  turns: FoldedTurn[];
  /**
   * Cursor to persist: the end of consumed events when every turn settled, else one before the
   * earliest UNSETTLED turn's first event (so the next drain re-reads it from the top).
   */
  nextStreamIndex: number;
}

/* ── small helpers replicated from talk.server.ts (kept local so this module stays pure) ── */

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textOf(obj: unknown): string | null {
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  for (const key of ["text", "content", "message", "output", "result", "reply"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "object" && v !== null) {
      const nested = textOf(v);
      if (nested) return nested;
    }
  }
  return null;
}

function compactText(value: string, max = 2_000): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function detailsOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? compactText(value.trim()) : null;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return compactText(JSON.stringify(value, null, 2));
  } catch {
    return null;
  }
}

function failureOf(
  data: Record<string, unknown>,
  fallback: string,
): { message: string; code?: string; details?: string; text: string } {
  const message = stringField(data, "message") ?? textOf(data) ?? fallback;
  const code = stringField(data, "code") ?? undefined;
  const details = detailsOf(data.details) ?? undefined;
  return {
    message,
    code,
    details,
    text: [message, code ? `Code: ${code}` : null, details ? `Details: ${details}` : null]
      .filter(Boolean)
      .join("\n"),
  };
}

function firstStringValue(obj: Record<string, unknown>): string | undefined {
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function summarizeActionInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const preferred = o.command ?? o.skill ?? o.path ?? o.file_path ?? firstStringValue(o);
  if (typeof preferred !== "string") return undefined;
  const trimmed = preferred.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}

function normalizeReply(reply: string | null): {
  reply: string | null;
  replyIsStructured: boolean;
} {
  if (!reply) return { reply, replyIsStructured: false };
  const t = reply.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return { reply: JSON.stringify(JSON.parse(t), null, 2), replyIsStructured: true };
    } catch {
      // plain prose that happens to start with a brace — leave as-is
    }
  }
  return { reply, replyIsStructured: false };
}

/* ── channel classification ── */

/**
 * eve's `$eve.trigger` → harnesst run channel. `http` is playground/assistant/teammate traffic that
 * harnesst already records in-process, so it maps to null (the reconciler SKIPS it). `schedule` is
 * cron. Every other channel (discord, github, slack, …) passes through verbatim. An
 * empty/absent trigger can't be classified, so it is skipped too.
 */
export function channelForTrigger(trigger: string): string | null {
  const t = trigger.trim();
  if (!t || t === "http") return null;
  if (t === "schedule") return "cron";
  return t;
}

/* ── the fold ── */

interface TurnState {
  turnId: string;
  firstEventStreamIndex: number;
  userMessage: string | null;
  startedAt: Date | null;
  firstEventAt: Date;
  finishedAt: Date | null;
  settled: boolean;
  steps: TurnStep[];
  messages: { afterStepIndex: number; text: string }[];
  completedMessages: string[];
  inputRequests: ChatInputRequest[];
  reply: string | null;
  error: string | null;
  lastStepFailure: string | null;
  stepStarts: Map<number, number>;
  actionsBySeq: Map<number, TurnAction[]>;
  actionByCallId: Map<string, TurnAction>;
}

function newTurn(turnId: string, streamIndex: number, at: Date): TurnState {
  return {
    turnId,
    firstEventStreamIndex: streamIndex,
    userMessage: null,
    startedAt: null,
    firstEventAt: at,
    finishedAt: null,
    settled: false,
    steps: [],
    messages: [],
    completedMessages: [],
    inputRequests: [],
    reply: null,
    error: null,
    lastStepFailure: null,
    stepStarts: new Map(),
    actionsBySeq: new Map(),
    actionByCallId: new Map(),
  };
}

/**
 * Fold a session's replayed events into per-turn results. `opts.modelId` seeds the model when
 * the session.started event is behind the cursor (a resumed drain won't see it again).
 */
export function foldSessionEvents(
  events: IndexedEveEvent[],
  opts: { modelId?: string | null } = {},
): FoldedSession {
  let modelId: string | null = opts.modelId ?? null;
  const order: string[] = [];
  const turns = new Map<string, TurnState>();
  let lastTurnId: string | null = null;

  const ensureTurn = (turnId: string, streamIndex: number, at: Date): TurnState => {
    let turn = turns.get(turnId);
    if (!turn) {
      turn = newTurn(turnId, streamIndex, at);
      turns.set(turnId, turn);
      order.push(turnId);
    }
    lastTurnId = turnId;
    return turn;
  };

  /** The turn a session-scoped event (waiting/failed) applies to: its own turnId, else the open one. */
  const openTurn = (turnId: string | null): TurnState | null => {
    const id = turnId ?? lastTurnId;
    return id ? (turns.get(id) ?? null) : null;
  };

  for (const evt of events) {
    const type = String(evt.type ?? "");
    const data = evt.data ?? {};
    const at = new Date(evt.meta?.at ? Date.parse(evt.meta.at) : Date.now());
    const atMs = at.getTime();
    const stepIndex = typeof data.stepIndex === "number" ? data.stepIndex : 0;
    const sequence = typeof data.sequence === "number" ? data.sequence : stepIndex;
    const turnId = typeof data.turnId === "string" ? data.turnId : null;

    switch (type) {
      case "session.started": {
        const runtime = data.runtime as Record<string, unknown> | undefined;
        if (runtime && typeof runtime.modelId === "string") modelId = runtime.modelId;
        break;
      }
      case "turn.started": {
        if (!turnId) break;
        const turn = ensureTurn(turnId, evt.streamIndex, at);
        if (turn.startedAt === null) turn.startedAt = at;
        break;
      }
      case "message.received": {
        if (!turnId) break;
        const turn = ensureTurn(turnId, evt.streamIndex, at);
        if (typeof data.message === "string") turn.userMessage = data.message;
        // message.received is the truest turn start; prefer it over a later fallback.
        turn.startedAt = at;
        break;
      }
      case "step.started": {
        if (!turnId) break;
        const turn = ensureTurn(turnId, evt.streamIndex, at);
        turn.stepStarts.set(sequence, atMs);
        break;
      }
      case "actions.requested": {
        if (!turnId) break;
        const turn = ensureTurn(turnId, evt.streamIndex, at);
        const list = Array.isArray(data.actions) ? data.actions : [];
        const seqActions = turn.actionsBySeq.get(sequence) ?? [];
        for (const rawAction of list) {
          if (typeof rawAction !== "object" || rawAction === null) continue;
          const a = rawAction as Record<string, unknown>;
          const toolName = typeof a.toolName === "string" ? a.toolName : "tool";
          const record: TurnAction = {
            toolName,
            summary: summarizeActionInput(a.input),
            input: a.input,
          };
          seqActions.push(record);
          if (typeof a.callId === "string") turn.actionByCallId.set(a.callId, record);
        }
        turn.actionsBySeq.set(sequence, seqActions);
        break;
      }
      case "action.result": {
        if (!turnId) break;
        const turn = ensureTurn(turnId, evt.streamIndex, at);
        const result = data.result as Record<string, unknown> | undefined;
        const callId = result && typeof result.callId === "string" ? result.callId : null;
        const record = callId ? turn.actionByCallId.get(callId) : undefined;
        if (record) {
          const output = result?.output;
          if (output !== undefined) record.output = output;
          if (
            output &&
            typeof output === "object" &&
            typeof (output as Record<string, unknown>).exitCode === "number"
          ) {
            record.exitCode = (output as Record<string, unknown>).exitCode as number;
          }
          record.isError =
            data.status === "failed" || (record.exitCode != null && record.exitCode !== 0);
        }
        break;
      }
      case "message.completed": {
        if (!turnId) break;
        const turn = ensureTurn(turnId, evt.streamIndex, at);
        const message = typeof data.message === "string" ? data.message : textOf(data);
        if (message) {
          turn.completedMessages.push(message);
          turn.messages.push({ afterStepIndex: turn.steps.length, text: message });
          turn.reply = turn.completedMessages.join("\n\n");
        }
        break;
      }
      case "step.completed":
      case "step.failed": {
        if (!turnId) break;
        const turn = ensureTurn(turnId, evt.streamIndex, at);
        const usage = data.usage as Record<string, unknown> | undefined;
        const started = turn.stepStarts.get(sequence);
        const failure = type === "step.failed" ? failureOf(data, "The agent step failed.") : null;
        if (failure) turn.lastStepFailure = failure.text;
        const actions = turn.actionsBySeq.get(sequence);
        const primary = actions?.[0];
        turn.steps.push({
          type,
          name: stringField(data, "name") ?? undefined,
          durationMs: started != null ? Math.max(0, atMs - started) : undefined,
          tokensIn:
            usage && typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
          tokensOut:
            usage && typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
          isError: type === "step.failed",
          code: failure?.code,
          message: failure?.message,
          details: failure?.details,
          toolName: primary?.toolName,
          summary: primary?.summary,
          actions: actions && actions.length > 0 ? actions : undefined,
        });
        break;
      }
      case "input.requested": {
        if (!turnId) break;
        const turn = ensureTurn(turnId, evt.streamIndex, at);
        const requests = inputRequestsOf(data);
        if (requests.length > 0) turn.inputRequests.push(...requests);
        break;
      }
      case "turn.completed": {
        const turn = openTurn(turnId);
        if (turn) {
          turn.settled = true;
          turn.finishedAt = at;
        }
        break;
      }
      case "turn.failed":
      case "session.failed": {
        const turn = openTurn(turnId);
        if (turn && !turn.settled) {
          const failure = failureOf(data, "The turn failed (no detail in the event).");
          turn.error =
            failure.code || failure.details || turn.lastStepFailure === null
              ? failure.text
              : turn.lastStepFailure.includes(failure.message)
                ? turn.lastStepFailure
                : `${failure.text}\nStep: ${turn.lastStepFailure}`;
          turn.settled = true;
          turn.finishedAt = at;
        }
        break;
      }
      case "session.waiting": {
        // Mirror streamTurn: a waiting marker settles the open turn once it produced a reply,
        // an error, or asked a question; a bare failure with no reply settles as that failure.
        const turn = openTurn(turnId);
        if (turn && !turn.settled) {
          if (
            turn.reply !== null ||
            turn.error !== null ||
            turn.inputRequests.length > 0
          ) {
            turn.settled = true;
            turn.finishedAt = at;
          } else if (turn.lastStepFailure !== null) {
            turn.error = turn.lastStepFailure;
            turn.settled = true;
            turn.finishedAt = at;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const folded: FoldedTurn[] = order.map((id) => {
    const turn = turns.get(id) as TurnState;
    // A turn that produced a step failure but never surfaced a turn/session settle keeps that
    // failure text so an eventually-settled row still explains itself (parity with streamTurn).
    if (turn.settled && turn.error === null && turn.reply === null && turn.lastStepFailure !== null) {
      turn.error = turn.lastStepFailure;
    }
    const startedAt = turn.startedAt ?? turn.firstEventAt;
    const turnModelId = modelId ? effectiveModelId(modelId, turn.userMessage ?? "") : null;
    const normalized = normalizeReply(turn.reply);
    const result: TurnResult = {
      ok: turn.settled && turn.error === null,
      sessionId: null,
      continuationToken: null,
      streamIndex: 0,
      reply: normalized.reply,
      replyIsStructured: normalized.replyIsStructured,
      inputRequests: turn.inputRequests,
      modelId: turnModelId,
      turnId: turn.turnId,
      steps: turn.steps,
      messages: turn.messages,
      // Unsettled turns are only ever ingested as `running`, never as a failure.
      error: turn.settled ? turn.error : null,
    };
    return {
      turnId: turn.turnId,
      firstEventStreamIndex: turn.firstEventStreamIndex,
      userMessage: turn.userMessage,
      startedAt,
      finishedAt: turn.finishedAt,
      settled: turn.settled,
      result,
    };
  });

  const nextStreamIndex = computeNextStreamIndex(events, folded);
  return { modelId, turns: folded, nextStreamIndex };
}

/**
 * Where to resume next drain. If every turn settled, advance to the end of what we consumed. If
 * any turn is unsettled, park one before the EARLIEST unsettled turn's first event so the next
 * drain re-reads it (and everything after) from the top — settled turns before it stay put.
 */
function computeNextStreamIndex(events: IndexedEveEvent[], turns: FoldedTurn[]): number {
  if (events.length === 0) return 0;
  const consumedEnd = events[events.length - 1].streamIndex;
  const unsettled = turns.filter((t) => !t.settled);
  if (unsettled.length === 0) return consumedEnd;
  const earliest = Math.min(...unsettled.map((t) => t.firstEventStreamIndex));
  return Math.max(0, earliest - 1);
}
