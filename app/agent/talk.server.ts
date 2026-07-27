/**
 * Talk to a deployed eve instance over its HTTP session API (contract verified live 2026-07-03
 * against a running instance):
 *
 *   First turn:  POST /eve/v1/session              {message}
 *                → 202 + x-eve-session-id + {sessionId, continuationToken}
 *   Follow-ups:  POST /eve/v1/session/:sessionId   {message, continuationToken}
 *                → same session, context retained (the token stays valid for the session)
 *   Events:      GET  /eve/v1/session/:id/stream   — NDJSON {type, data, meta.at}:
 *                session.started (runtime.modelId) → turn.started → message.received →
 *                step.started → actions.requested → action.result → message.appended
 *                (messageSoFar) → message.completed (data.message = full reply) →
 *                step.completed (data.usage tokens) → turn.completed → session.waiting
 *
 * IMPORTANT: the stream REPLAYS the session's whole history on connect, so a follow-up turn
 * must attribute events to OUR turn (matched by message text + a post-time timestamp guard)
 * rather than settling on the first replayed turn.completed.
 *
 * The turn is consumed as a live async generator (`streamTurn`): it yields incremental
 * `TalkEvent`s — model, thinking, tool actions, cumulative reply text, completed steps — and
 * ALWAYS ends with a `done` event carrying the settled `TurnResult`. `sendTurn` is a thin
 * wrapper that drains the generator and returns that result, so callers that only want the
 * final transcript keep the same shape and semantics they always had.
 */

import type { ChatInputOption, ChatInputRequest } from "~/chat/types";
import { effectiveModelId } from "~/models/model-directive";

/** One action (tool call) inside a step, correlated request → result. */
export interface TurnAction {
  toolName: string;
  summary?: string;
  /** Process exit code when the tool's output carried one (bash-style tools). */
  exitCode?: number;
  isError?: boolean;
  /** Raw tool input as eve sent it (`actions.requested`), e.g. `{command}` for bash. */
  input?: unknown;
  /** Raw tool output as eve returned it (`action.result`), full result payload. */
  output?: unknown;
}

export interface TurnStep {
  type: string;
  name?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  isError: boolean;
  code?: string;
  message?: string;
  details?: string;
  /** Primary tool of the step's actions (additive). */
  toolName?: string;
  /** Compacted summary of the primary action (command, skill, path) (additive). */
  summary?: string;
  /** Every tool call made during the step, request correlated to result (additive). */
  actions?: TurnAction[];
}

export interface TurnResult {
  ok: boolean;
  sessionId: string | null;
  continuationToken: string | null;
  /** Count of durable Eve stream events consumed for this session. */
  streamIndex: number;
  /** Assistant reply text (or prettified structured output). A turn can carry several
   * assistant messages interleaved with tool steps — this is all of them, joined. */
  reply: string | null;
  /** True when the reply parsed as JSON — the UI renders it as code. */
  replyIsStructured: boolean;
  /** Pending input requests — questions or tool approvals (input.requested events). */
  inputRequests: ChatInputRequest[];
  /** Model that served the turn (from session.started runtime metadata). */
  modelId: string | null;
  /** eve's per-session turn id (turn_0, turn_1, …); the run's external id component. */
  turnId: string | null;
  steps: TurnStep[];
  /**
   * Assistant messages in completion order, each tagged with how many tool/model steps had
   * completed before it — lets the transcript interleave message bubbles between tool steps
   * in true order (a turn can emit several messages around its tool activity). `reply` is
   * these joined; this preserves the ordering `reply` loses.
   */
  messages: { afterStepIndex: number; text: string }[];
  error: string | null;
}

/** The raw Eve durable-stream event (type + data + meta), as parsed from an NDJSON line. */
export interface RawEveEvent {
  type: string;
  data: Record<string, unknown>;
  meta?: { at?: string };
}

/**
 * Live events yielded while a turn runs. Every stream ends with exactly one `done`, on every
 * path (success, failure, timeout, unreachable agent) — consumers can rely on it.
 */
export type TalkEvent =
  | { kind: "session"; sessionId: string; continuationToken: string | null }
  | {
      kind: "progress";
      sessionId: string;
      continuationToken: string | null;
      streamIndex: number;
      /** The raw event at this `streamIndex`, for the durable transcript cache. */
      rawEvent: RawEveEvent;
    }
  | { kind: "turn"; turnId: string }
  | { kind: "model"; modelId: string }
  | { kind: "thinking" }
  | { kind: "action"; toolName: string; summary?: string }
  | { kind: "text"; text: string }
  | { kind: "step"; step: TurnStep }
  | { kind: "input"; requests: ChatInputRequest[] }
  | { kind: "done"; result: TurnResult };

/** Pull a human-readable text out of an unknown event payload, if one exists. */
function textOf(obj: unknown): string | null {
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  for (const key of [
    "text",
    "content",
    "message",
    "output",
    "result",
    "reply",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "object" && v !== null) {
      const nested = textOf(v);
      if (nested) return nested;
    }
  }
  return null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compactText(value: string, max = 2_000): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function detailsOf(value: unknown): string | null {
  if (typeof value === "string")
    return value.trim() ? compactText(value.trim()) : null;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
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
    text: [
      message,
      code ? `Code: ${code}` : null,
      details ? `Details: ${details}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * A one-line summary of a tool call's input: the command, skill, or file it acts on, falling
 * back to the first string value. Compacted so an activity line stays readable.
 */
function summarizeActionInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const preferred =
    o.command ?? o.skill ?? o.path ?? o.file_path ?? firstStringValue(o);
  if (typeof preferred !== "string") return undefined;
  const trimmed = preferred.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}

function firstStringValue(obj: Record<string, unknown>): string | undefined {
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/**
 * The pending requests of an `input.requested` event — ask_question calls (free text or
 * multiple choice via `options`) and tool approvals (`display: "confirmation"`). Each
 * request carries `prompt` and `requestId`; `options`/`allowFreeform` shape the answer UI.
 */
export function inputRequestsOf(
  data: Record<string, unknown>,
): ChatInputRequest[] {
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const out: ChatInputRequest[] = [];
  for (const raw of requests) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const action = r.action as Record<string, unknown> | undefined;
    const input = action?.input as Record<string, unknown> | undefined;
    const prompt =
      stringField(r, "prompt") ?? (input ? stringField(input, "prompt") : null);
    const requestId =
      stringField(r, "requestId") ??
      (action ? stringField(action, "callId") : null);
    if (!prompt || !requestId) continue;
    const display = stringField(r, "display");
    const rawOptions = Array.isArray(r.options)
      ? r.options
      : input && Array.isArray(input.options)
        ? input.options
        : [];
    const options: ChatInputOption[] = [];
    for (const rawOption of rawOptions) {
      if (typeof rawOption === "string") {
        if (rawOption.trim()) options.push({ id: rawOption, label: rawOption });
        continue;
      }
      if (typeof rawOption !== "object" || rawOption === null) continue;
      const o = rawOption as Record<string, unknown>;
      const label = stringField(o, "label") ?? stringField(o, "id");
      if (!label) continue;
      options.push({
        id: stringField(o, "id") ?? label,
        label,
        description: stringField(o, "description"),
        style: styleOf(stringField(o, "style")),
      });
    }
    out.push({
      requestId,
      prompt,
      display:
        display === "confirmation" || display === "select" || display === "text"
          ? display
          : null,
      allowFreeform:
        typeof r.allowFreeform === "boolean"
          ? r.allowFreeform
          : input && typeof input.allowFreeform === "boolean"
            ? input.allowFreeform
            : null,
      options: options.length > 0 ? options : undefined,
    });
  }
  return out;
}

function styleOf(value: string | null): ChatInputOption["style"] {
  return value === "danger" || value === "primary" || value === "default"
    ? value
    : null;
}

/** Detect + prettify a JSON reply (structured output) so the UI can render it as code. */
function normalizeReply(reply: string | null): {
  reply: string | null;
  replyIsStructured: boolean;
} {
  if (!reply) return { reply, replyIsStructured: false };
  const t = reply.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return {
        reply: JSON.stringify(JSON.parse(t), null, 2),
        replyIsStructured: true,
      };
    } catch {
      // plain prose that happens to start with a brace — leave as-is
    }
  }
  return { reply, replyIsStructured: false };
}

/**
 * Send one message and stream the turn as it runs. Yields incremental events and ALWAYS ends
 * with a single `done` carrying the settled result — even when the agent is unreachable or the
 * turn times out (default 90s). See the file header for the eve contract and replay caveat.
 */
export async function* streamTurn(input: {
  baseUrl: string;
  message: string;
  /**
   * Request-correlated HITL answers, forwarded verbatim as eve's `inputResponses`. Only
   * meaningful on a follow-up send (eve resolves them against the session the continuation
   * token names); with responses present eve skips its batch-wide text resolution, so the
   * message rides along as ordinary input instead of answering every pending request.
   */
  inputResponses?: ReadonlyArray<{
    requestId: string;
    optionId?: string;
    text?: string;
  }> | null;
  /** Both present → follow-up turn on the existing session (context retained). */
  sessionId?: string | null;
  continuationToken?: string | null;
  /**
   * Channel-homed delivery (WS1). When set, the follow-up POST goes to the agent's own
   * channel-registered answer route instead of `/eve/v1/session/:id`. This is not an
   * optimization: eve owns a channel session through the channel that homed it, so delivering
   * `inputResponses` anywhere else fails with "the target session was not found via
   * continuation token" (observed as a 500 in production). Built in one place —
   * `~/foh/channel-resume` — so no surface above here learns which channels exist.
   *
   * Everything after delivery is unchanged: the resumed session is the SAME eve session, read
   * from the same `/eve/v1/session/:id/stream` at the same cursor.
   */
  deliverVia?: {
    routePath: string;
    /** Continuation token with the channel namespace stripped — eve's `send()` re-adds it. */
    rawToken: string;
    state: Record<string, unknown>;
    /** The instance's own HARNESST_TEAM_TOKEN; the channel route is otherwise unauthenticated. */
    bearer: string;
  } | null;
  /** Remote event cursor from the last consumed session stream event. */
  streamIndex?: number | null;
  /** Abort the local stream consumer, e.g. when the user presses Stop. */
  signal?: AbortSignal | null;
  /**
   * Idle timeout, not an absolute wall-clock timeout. Long-running turns may be active for
   * hours as long as Eve keeps producing events.
   */
  timeoutMs?: number;
}): AsyncGenerator<TalkEvent> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 90_000;
  // Events older than this are history replay, not our turn (same-box clocks; generous skew).
  const postedAt = Date.now() - 30_000;
  const isFollowUp = !!(input.sessionId && input.continuationToken);
  let streamIndex = Math.max(0, input.streamIndex ?? 0);

  const fail = (
    error: string,
    ids?: {
      sessionId?: string | null;
      continuationToken?: string | null;
    },
  ): TalkEvent => ({
    kind: "done",
    result: {
      ok: false,
      sessionId: ids?.sessionId ?? null,
      continuationToken: ids?.continuationToken ?? null,
      streamIndex,
      reply: null,
      replyIsStructured: false,
      inputRequests: [],
      modelId: null,
      turnId: null,
      steps: [],
      messages: [],
      error,
    },
  });

  const throwIfAborted = () => {
    if (input.signal?.aborted) {
      throw new Error("Turn was stopped.");
    }
  };

  const readWithIdleTimeout = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) => {
    throwIfAborted();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => {
            reject(
              new Error(
                `Timed out after ${Math.round(timeoutMs / 1000)}s with no Eve stream events.`,
              ),
            );
          }, timeoutMs);
          if (input.signal) {
            abortHandler = () => reject(new Error("Turn was stopped."));
            input.signal.addEventListener("abort", abortHandler, { once: true });
          }
        }),
      ]);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (input.signal && abortHandler) {
        input.signal.removeEventListener("abort", abortHandler);
      }
    }
  };

  // 1. Start a session with the message — or continue the existing one.
  let sessionId: string | null = null;
  let continuationToken: string | null = null;
  try {
    throwIfAborted();
    // A channel-homed session resumes through its own channel route; a first turn NEVER does
    // (there is no session to resume, and the answer route would have nothing to deliver into).
    const via = isFollowUp ? (input.deliverVia ?? null) : null;
    const res = via
      ? await fetch(`${base}${via.routePath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${via.bearer}`,
          },
          body: JSON.stringify({
            continuationToken: via.rawToken,
            state: via.state,
            inputResponses: input.inputResponses ?? [],
            ...(input.message ? { message: input.message } : {}),
          }),
          signal: AbortSignal.timeout(15_000),
        })
      : await fetch(
          isFollowUp
            ? `${base}/eve/v1/session/${input.sessionId}`
            : `${base}/eve/v1/session`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message: input.message,
              ...(isFollowUp ? { continuationToken: input.continuationToken } : {}),
              ...(isFollowUp && input.inputResponses && input.inputResponses.length > 0
                ? { inputResponses: input.inputResponses }
                : {}),
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
    if (!res.ok && res.status !== 202) {
      // A channel route answers 409 when the token names no live session — the container was
      // redeployed and the eve session died with it (findings C/D). Say so in words a human can
      // act on rather than leaking a bare status.
      if (via && res.status === 409) {
        yield fail(
          "This conversation is homed on the agent's GitHub thread, and the agent has been redeployed since the question was asked — its session no longer exists, so the answer could not be delivered.",
        );
        return;
      }
      yield fail(
        via
          ? `Agent returned ${res.status} ${res.statusText} for POST ${via.routePath}.`
          : `Agent returned ${res.status} ${res.statusText} for POST /eve/v1/session.`,
      );
      return;
    }
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    sessionId =
      res.headers.get("x-eve-session-id") ??
      (typeof body.sessionId === "string" ? body.sessionId : null);
    // Follow-up responses omit the token — it stays valid for the whole session.
    continuationToken =
      typeof body.continuationToken === "string"
        ? body.continuationToken
        : (input.continuationToken ?? null);
  } catch (error) {
    yield fail(`Couldn't reach the agent: ${(error as Error).message}`);
    return;
  }
  if (!sessionId) {
    yield fail("The agent accepted the message but returned no session id.", {
      continuationToken,
    });
    return;
  }
  yield { kind: "session", sessionId, continuationToken };

  // 2. Read the event stream until the turn settles.
  const steps: TurnStep[] = [];
  // A turn can interleave several assistant messages with tool steps — keep them all, each
  // tagged with the step count at completion time so the transcript can reconstruct order.
  const messages: { afterStepIndex: number; text: string }[] = [];
  const completedMessages: string[] = [];
  const inputRequests: ChatInputRequest[] = [];
  let lastTextSent: string | null = null;
  let reply: string | null = null;
  let error: string | null = null;
  let lastStepFailure: string | null = null;
  let modelId: string | null = null;
  let ourTurnId: string | null = null;
  let turnAnnounced = false;
  try {
    const streamUrl = new URL(`${base}/eve/v1/session/${sessionId}/stream`);
    if (streamIndex > 0)
      streamUrl.searchParams.set("startIndex", String(streamIndex));
    const res = await fetch(streamUrl, {
      signal: input.signal ?? undefined,
    });
    if (!res.ok || !res.body) {
      throw new Error(`stream returned ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let settled = false;
    // step.started timestamps by sequence, to compute durations at step.completed.
    // NOTE: eve's stepIndex stays 0 for the whole turn; `sequence` is the real per-step
    // counter — key on it (falling back to stepIndex on older instances).
    const stepStarts = new Map<number, number>();
    // Tool calls per sequence, correlated request → result by callId (attached to the step).
    const actionsBySeq = new Map<number, TurnAction[]>();
    const actionByCallId = new Map<string, TurnAction>();

    while (!settled) {
      const { done, value } = await readWithIdleTimeout(reader);
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // NDJSON events, one per line: {"type": "...", "data": {...}, "meta": {"at": ISO}}.
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/^data:\s*/, "").trim();
        if (!line) continue;
        let evt: {
          type?: string;
          data?: Record<string, unknown>;
          meta?: { at?: string };
        };
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // not a JSON line — skip
        }
        streamIndex += 1;
        const type = String(evt.type ?? "");
        const data = evt.data ?? {};
        yield {
          kind: "progress",
          sessionId,
          continuationToken,
          streamIndex,
          rawEvent: { type, data, meta: evt.meta },
        };
        const at = evt.meta?.at ? Date.parse(evt.meta.at) : Date.now();
        const stepIndex =
          typeof data.stepIndex === "number" ? data.stepIndex : 0;
        const sequence =
          typeof data.sequence === "number" ? data.sequence : stepIndex;
        const turnId = typeof data.turnId === "string" ? data.turnId : null;
        const ours = ourTurnId !== null && turnId === ourTurnId;

        switch (type) {
          case "session.started": {
            const runtime = data.runtime as Record<string, unknown> | undefined;
            if (runtime && typeof runtime.modelId === "string") {
              // Dynamic-model agents report `dynamic:<fallback id>` — resolve to the model that
              // actually serves this turn (the sent message's directive, else the fallback).
              modelId = effectiveModelId(runtime.modelId, input.message);
              yield { kind: "model", modelId };
            }
            break;
          }
          case "message.received":
            // Our turn = the (latest) received message matching what we just sent, at a
            // timestamp after we posted — replayed history is older and is skipped.
            if (data.message === input.message && at >= postedAt) {
              ourTurnId = turnId;
              if (ourTurnId !== null && !turnAnnounced) {
                turnAnnounced = true;
                yield { kind: "turn", turnId: ourTurnId };
              }
            }
            break;
          case "step.started":
            if (ours) {
              stepStarts.set(sequence, at);
              yield { kind: "thinking" };
            }
            break;
          case "actions.requested": {
            if (!ours) break;
            const list = Array.isArray(data.actions) ? data.actions : [];
            const seqActions = actionsBySeq.get(sequence) ?? [];
            for (const rawAction of list) {
              if (typeof rawAction !== "object" || rawAction === null) continue;
              const a = rawAction as Record<string, unknown>;
              const toolName =
                typeof a.toolName === "string" ? a.toolName : "tool";
              const summary = summarizeActionInput(a.input);
              // Keep the FULL input (not just the one-line summary) so the transcript can
              // render the real command/args; caps + redaction are applied at persist time.
              const record: TurnAction = { toolName, summary, input: a.input };
              seqActions.push(record);
              if (typeof a.callId === "string")
                actionByCallId.set(a.callId, record);
              yield { kind: "action", toolName, summary };
            }
            actionsBySeq.set(sequence, seqActions);
            break;
          }
          case "action.result": {
            if (!ours) break;
            const result = data.result as Record<string, unknown> | undefined;
            const callId =
              result && typeof result.callId === "string"
                ? result.callId
                : null;
            const record = callId ? actionByCallId.get(callId) : undefined;
            if (record) {
              const output = result?.output;
              // Keep the FULL output for the transcript (capped/redacted at persist time).
              if (output !== undefined) record.output = output;
              if (
                output &&
                typeof output === "object" &&
                typeof (output as Record<string, unknown>).exitCode === "number"
              ) {
                record.exitCode = (output as Record<string, unknown>)
                  .exitCode as number;
              }
              record.isError =
                data.status === "failed" ||
                (record.exitCode != null && record.exitCode !== 0);
            }
            break;
          }
          case "message.appended":
            // messageSoFar is cumulative for the CURRENT message only — prefix the turn's
            // earlier completed messages so the live text never loses them.
            if (ours && typeof data.messageSoFar === "string") {
              const text = [...completedMessages, data.messageSoFar].join(
                "\n\n",
              );
              if (text !== lastTextSent) {
                lastTextSent = text;
                yield { kind: "text", text };
              }
            }
            break;
          case "step.completed":
          case "step.failed": {
            if (!ours) break;
            const usage = data.usage as Record<string, unknown> | undefined;
            const started = stepStarts.get(sequence);
            const failure =
              type === "step.failed"
                ? failureOf(data, "The agent step failed.")
                : null;
            if (failure) lastStepFailure = failure.text;
            const actions = actionsBySeq.get(sequence);
            const primary = actions?.[0];
            const step: TurnStep = {
              type,
              name: stringField(data, "name") ?? undefined,
              durationMs:
                started != null ? Math.max(0, at - started) : undefined,
              tokensIn:
                usage && typeof usage.inputTokens === "number"
                  ? usage.inputTokens
                  : undefined,
              tokensOut:
                usage && typeof usage.outputTokens === "number"
                  ? usage.outputTokens
                  : undefined,
              isError: type === "step.failed",
              code: failure?.code,
              message: failure?.message,
              details: failure?.details,
              toolName: primary?.toolName,
              summary: primary?.summary,
              actions: actions && actions.length > 0 ? actions : undefined,
            };
            steps.push(step);
            yield { kind: "step", step };
            break;
          }
          case "message.completed": {
            // One settled assistant message (there can be several per turn, interleaved
            // with tool steps) — the turn's reply is all of them joined.
            if (!ours) break;
            const message =
              typeof data.message === "string" ? data.message : textOf(data);
            if (message) {
              completedMessages.push(message);
              // Tag with the number of steps completed so far, so a downstream mapper can
              // interleave this message between the tool steps that surround it.
              messages.push({ afterStepIndex: steps.length, text: message });
              reply = completedMessages.join("\n\n");
              if (reply !== lastTextSent) {
                lastTextSent = reply;
                yield { kind: "text", text: reply };
              }
            }
            break;
          }
          case "input.requested":
            // The agent asked the user something (ask_question / tool approval). Surface
            // it — the turn then parks and the session waits for the user's answer.
            if (ours) {
              const requests = inputRequestsOf(data);
              if (requests.length > 0) {
                inputRequests.push(...requests);
                yield { kind: "input", requests };
              }
            }
            break;
          case "turn.failed":
          case "session.failed":
            if (ours || type === "session.failed") {
              const failure = failureOf(
                data,
                "The turn failed (no detail in the event).",
              );
              error =
                failure.code || failure.details || lastStepFailure === null
                  ? failure.text
                  : lastStepFailure.includes(failure.message)
                    ? lastStepFailure
                    : `${failure.text}\nStep: ${lastStepFailure}`;
              settled = true;
            }
            break;
          case "turn.completed":
            if (ours) settled = true;
            break;
          case "session.waiting":
            // Only trust a waiting marker once our turn produced a reply (or asked a
            // question) — earlier ones are history replay from previous turns.
            if (
              ourTurnId !== null &&
              (reply !== null || error !== null || inputRequests.length > 0)
            )
              settled = true;
            if (
              ourTurnId !== null &&
              reply === null &&
              inputRequests.length === 0 &&
              lastStepFailure !== null
            ) {
              error = lastStepFailure;
              settled = true;
            }
            break;
        }
      }
    }
    reader.cancel().catch(() => {});
    const asked = inputRequests.length > 0;
    if (
      reply === null &&
      !asked &&
      error === null &&
      lastStepFailure !== null
    ) {
      error = lastStepFailure;
    }
    if (!settled && reply === null && !asked && error === null) {
      error = `The Eve stream ended before the turn completed.`;
    }
  } catch (streamError) {
    error = `Couldn't read the reply stream: ${(streamError as Error).message}`;
  }

  const normalized = normalizeReply(reply);
  yield {
    kind: "done",
    result: {
      ok: error === null,
      sessionId,
      continuationToken,
      streamIndex,
      reply: normalized.reply,
      replyIsStructured: normalized.replyIsStructured,
      inputRequests,
      modelId,
      turnId: ourTurnId,
      steps,
      messages,
      error,
    },
  };
}

/** Send one message and wait for the turn to settle (or `timeoutMs`). */
export async function sendTurn(input: {
  baseUrl: string;
  message: string;
  /** Both present → follow-up turn on the existing session (context retained). */
  sessionId?: string | null;
  continuationToken?: string | null;
  streamIndex?: number | null;
  timeoutMs?: number;
}): Promise<TurnResult> {
  let result: TurnResult | null = null;
  for await (const event of streamTurn(input)) {
    if (event.kind === "done") result = event.result;
  }
  // `streamTurn` always ends with a `done` event, so this is never null.
  return result as TurnResult;
}
