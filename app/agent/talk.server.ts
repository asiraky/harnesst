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
  /**
   * WS1: the turn failed because the CHANNEL-HOMED eve session this row resumes into no longer
   * exists (the container was redeployed and took its in-process session state with it). The
   * drain reads this to unbind the row so the next message reseeds a fresh session (#71) —
   * without it a redeploy dead-ends the conversation permanently. Absent on every other path.
   */
  resumeExpired?: boolean;
  /**
   * #267: the turn did not fail — HARNESST STOPPED WATCHING IT. The reply stream dropped, went
   * idle past the budget, or ended before a terminal event, while the container kept running the
   * turn to completion (that is by design; a turn legitimately runs 15+ minutes). The three
   * transport-class outcomes used to be indistinguishable from "the agent genuinely failed"
   * because they arrive as `ok: false` with free-text `error`, so callers could only tell them
   * apart by matching strings — and none did, which is how a succeeded delegation was reported
   * as unreachable.
   *
   * Set ONLY when the turn's outcome is genuinely unknown, never for a stop the user asked for
   * (there is nothing to reattach to) and never for an agent-side failure. `sessionId` +
   * `continuationToken` + `streamIndex` on the same result say exactly which session was
   * abandoned and where in its stream reading stopped, so a caller can resume from there —
   * see `resumeTurnStream` and `~/team/reattach.server`.
   */
  streamLost?: boolean;
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

/**
 * Read a channel answer route's failure body: `{ ok:false, code?, error? }`, with the message
 * capped and a non-JSON body accepted verbatim. `code` is what lets `streamTurn` tell "the
 * session this token names is gone" (recoverable, and the user is told exactly that) from every
 * other failure, which must NOT be reported as a redeploy.
 */
async function readChannelFailure(
  res: Response,
): Promise<{ code: string | null; message: string | null }> {
  const text = await res.text().catch(() => "");
  const trimmed = text.trim();
  if (!trimmed) return { code: null, message: null };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const error = typeof parsed.error === "string" ? parsed.error.trim() : "";
    return {
      code: typeof parsed.code === "string" ? parsed.code : null,
      message: error ? error.slice(0, 500) : null,
    };
  } catch {
    return { code: null, message: trimmed.slice(0, 500) };
  }
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
      /** See `TurnResult.resumeExpired` — set ONLY when the channel session is provably gone. */
      resumeExpired?: boolean;
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
      ...(ids?.resumeExpired ? { resumeExpired: true } : {}),
    },
  });

  const throwIfAborted = () => {
    if (input.signal?.aborted) {
      throw new Error("Turn was stopped.");
    }
  };

  // 1. Start a session with the message — or continue the existing one.
  let sessionId: string | null = null;
  let continuationToken: string | null = null;
  // A channel-homed session resumes through its own channel route; a first turn NEVER does
  // (there is no session to resume, and the answer route would have nothing to deliver into).
  const via = isFollowUp ? (input.deliverVia ?? null) : null;

  // A channel resume is ONLY ever an answer to a pending request. eve 0.22.6's channel `send()`
  // throws on a failed `deliver()` only when `inputResponses` is non-empty; with an empty array
  // it silently falls back to `run()` and starts a BRAND-NEW session from the supplied `state` —
  // which, for the GitHub channel, means posting a comment on an `owner/repo/issue` taken from
  // state a container supplied at park time. So an ordinary follow-up on a channel-homed row is
  // refused here rather than gambling on eve's fallback. It cannot be sent down eve's HTTP
  // session route either: that route cannot resolve a channel-homed session's continuation
  // token at all (it 500s), which is the whole reason this delivery path exists.
  if (via && !(input.inputResponses && input.inputResponses.length > 0)) {
    yield fail(
      "This conversation lives on the agent's own channel thread, so harnesst can only send it an answer to a question it is waiting on — not a new message. Reply on the thread itself to say something else.",
      {
        sessionId: input.sessionId,
        continuationToken: input.continuationToken,
      },
    );
    return;
  }

  try {
    throwIfAborted();
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
              ...(isFollowUp
                ? { continuationToken: input.continuationToken }
                : {}),
              ...(isFollowUp &&
              input.inputResponses &&
              input.inputResponses.length > 0
                ? { inputResponses: input.inputResponses }
                : {}),
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
    if (!res.ok && res.status !== 202) {
      if (via) {
        const failure = await readChannelFailure(res);
        // 409 + `session_gone` is the ONE thing we can honestly name: the token resolves to no
        // live session, which on a channel means the container was replaced and took its
        // in-process session state with it. Every OTHER failure — a GitHub outage, an expired
        // installation token, a malformed state, a model error — used to be reported with the
        // same confident "the agent was redeployed" sentence, which was simply wrong. Those now
        // surface the route's own message, and the drain leaves the row bound so a retry can
        // still work.
        if (res.status === 409 && failure.code !== "send_failed") {
          yield fail(
            "This conversation is homed on the agent's own channel thread, and the agent has been redeployed since the question was asked — its session no longer exists, so the answer could not be delivered. Send another message to start a fresh conversation with the same history.",
            { resumeExpired: true },
          );
          return;
        }
        yield fail(
          `The agent could not deliver your answer through its ${via.routePath} route (HTTP ${res.status})${
            failure.message ? `: ${failure.message}` : "."
          }`,
        );
        return;
      }
      yield fail(
        `Agent returned ${res.status} ${res.statusText} for POST /eve/v1/session.`,
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
  yield* drainTurnStream({
    base,
    sessionId,
    continuationToken,
    startIndex: streamIndex,
    matchMessage: input.message,
    postedAt,
    initialTurnId: null,
    signal: input.signal,
    timeoutMs,
  });
}

/**
 * Consume an eve session's event stream for ONE turn, yielding it as `TalkEvent`s and always
 * ending with exactly one `done`. Shared by the two ways harnesst watches a turn:
 *
 *  - the LIVE path (`streamTurn`), which POSTed a message and identifies its turn by the echoed
 *    `message.received` at a post-time timestamp (the stream replays history on connect);
 *  - the REATTACH path (`resumeTurnStream`, #267), which posts nothing because the turn is
 *    already running — it knows the turn id harnesst was watching when the stream dropped, or
 *    adopts the first turn the stream shows past the cursor.
 */
async function* drainTurnStream(input: {
  /** Instance base url, trailing slashes already stripped. */
  base: string;
  sessionId: string;
  continuationToken: string | null;
  /** Cursor to open the stream at; the settled `streamIndex` continues from here. */
  startIndex: number;
  /**
   * Live path: the message text whose echo marks our turn. Null on the reattach path, where
   * nothing was sent and any turn seen past the cursor is the one being followed.
   */
  matchMessage: string | null;
  /** Live path: events older than this are replayed history, not our turn. */
  postedAt: number;
  /** Reattach path: the turn id harnesst already observed, when it observed one. */
  initialTurnId: string | null;
  signal?: AbortSignal | null;
  timeoutMs: number;
  /**
   * Pre-headers budget, reattach path only. Eve answers "nothing new" by saying NOTHING AT ALL —
   * a stream request positioned past the session's last event never sends so much as a response
   * header (see `tailBudgetsMs` in playground/sessions.server.ts). The live path always opens at
   * a cursor eve has events for, so it keeps its unbounded connect and its behavior is unchanged.
   */
  connectTimeoutMs?: number;
}): AsyncGenerator<TalkEvent> {
  const { base, sessionId, continuationToken, timeoutMs, postedAt } = input;
  let streamIndex = input.startIndex;
  // With no message to match, turn identity comes from the id we were given — or, when the
  // stream dropped before harnesst ever saw `message.received`, from the first turn past the
  // cursor. Nothing else sends to a delegated peer session, so that turn is ours.
  const adoptAnyTurn = input.matchMessage === null;
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
  let ourTurnId: string | null = input.initialTurnId;
  let turnAnnounced = false;
  // #267: set when the turn's outcome is unknown because the transport gave out — see
  // `TurnResult.streamLost`. A deliberate stop is never one of these.
  let streamLost = false;

  const readWithIdleTimeout = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) => {
    if (input.signal?.aborted) throw new Error("Turn was stopped.");
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
            input.signal.addEventListener("abort", abortHandler, {
              once: true,
            });
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

  // Held outside the try so the `finally` can always release it: when the idle race or the abort
  // wins, the pending `reader.read()` is still holding the HTTP response open. On the live path
  // that leaked one socket per lost turn; on the reattach path it would leak one per poll.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const streamUrl = new URL(`${base}/eve/v1/session/${sessionId}/stream`);
    if (streamIndex > 0)
      streamUrl.searchParams.set("startIndex", String(streamIndex));
    // The connect budget (reattach path) aborts only the pre-headers phase; it is cleared the
    // moment the response arrives, so the body reads stay governed by the idle race above.
    const connectController = new AbortController();
    const connectTimer =
      input.connectTimeoutMs != null
        ? setTimeout(() => connectController.abort(), input.connectTimeoutMs)
        : null;
    let res: Response;
    try {
      res = await fetch(streamUrl, {
        signal: connectTimer
          ? input.signal
            ? AbortSignal.any([input.signal, connectController.signal])
            : connectController.signal
          : (input.signal ?? undefined),
      });
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
    }
    if (!res.ok || !res.body) {
      throw new Error(`stream returned ${res.status}`);
    }
    reader = res.body.getReader();
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
        // Reattach with no known turn id: the first turn the stream shows past the cursor is the
        // one we lost. (On the live path `matchMessage` is set, so this never fires and turn
        // attribution stays exactly as it was.)
        if (adoptAnyTurn && ourTurnId === null && turnId !== null) {
          ourTurnId = turnId;
          turnAnnounced = true;
          yield { kind: "turn", turnId };
        }
        const ours = ourTurnId !== null && turnId === ourTurnId;

        switch (type) {
          case "session.started": {
            const runtime = data.runtime as Record<string, unknown> | undefined;
            if (runtime && typeof runtime.modelId === "string") {
              // Dynamic-model agents report `dynamic:<fallback id>` — resolve to the model that
              // actually serves this turn (the sent message's directive, else the fallback).
              modelId = effectiveModelId(
                runtime.modelId,
                input.matchMessage ?? "",
              );
              yield { kind: "model", modelId };
            }
            break;
          }
          case "message.received":
            // Our turn = the (latest) received message matching what we just sent, at a
            // timestamp after we posted — replayed history is older and is skipped.
            if (
              input.matchMessage !== null &&
              data.message === input.matchMessage &&
              at >= postedAt
            ) {
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
    const asked = inputRequests.length > 0;
    if (
      reply === null &&
      !asked &&
      error === null &&
      lastStepFailure !== null
    ) {
      error = lastStepFailure;
    }
    // Transport site 3: eve closed the stream without a terminal event for our turn. The container
    // is still running it — we simply stopped being told about it. Note this does NOT require an
    // empty reply: a turn can complete an assistant message and then keep working with tools, so a
    // partial reply plus no `turn.completed` is a lost stream, not a finished turn. (`asked` is
    // excluded: `input.requested` means the turn parked itself, which is a real settled outcome.)
    if (!settled && !asked && error === null) {
      error =
        reply === null
          ? `The Eve stream ended before the turn completed.`
          : `The Eve stream ended before the turn completed (the reply so far may be partial).`;
      streamLost = true;
    }
  } catch (streamError) {
    // Transport sites 1 and 2: the read threw (socket died) or the idle budget expired. Both
    // leave the turn running inside the container. A deliberate stop is neither: the caller
    // asked for the turn to end, so there is nothing to reattach to.
    error = `Couldn't read the reply stream: ${(streamError as Error).message}`;
    streamLost = input.signal?.aborted !== true;
  } finally {
    reader?.cancel().catch(() => {});
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
      ...(streamLost ? { streamLost: true } : {}),
    },
  };
}

/**
 * Follow a turn that is ALREADY RUNNING inside a container, from a cursor harnesst stopped
 * reading at (#267). Nothing is posted: the peer's session is mid-turn, and eve's durable stream
 * replays from `streamIndex` on connect, so a severed watcher can pick the turn back up exactly
 * where it left off.
 *
 * `timeoutMs` here is a POLL budget, not a turn budget — a caller drains one bounded slice, then
 * re-enqueues itself from the advanced cursor (see `~/team/reattach.server`). A slice that ends
 * without the turn settling comes back as `streamLost`, which is the signal to poll again rather
 * than a failure.
 */
export async function* resumeTurnStream(input: {
  baseUrl: string;
  sessionId: string;
  continuationToken?: string | null;
  /** The turn id harnesst was watching when the stream dropped; null adopts the next turn seen. */
  turnId?: string | null;
  /** Cursor to resume from — the abandoned `TurnResult.streamIndex`. */
  streamIndex?: number | null;
  signal?: AbortSignal | null;
  /** Per-slice idle budget. */
  timeoutMs?: number;
  /** Pre-headers budget; eve never answers a request positioned past the session's last event. */
  connectTimeoutMs?: number;
}): AsyncGenerator<TalkEvent> {
  yield* drainTurnStream({
    base: input.baseUrl.replace(/\/+$/, ""),
    sessionId: input.sessionId,
    continuationToken: input.continuationToken ?? null,
    startIndex: Math.max(0, input.streamIndex ?? 0),
    matchMessage: null,
    postedAt: 0,
    initialTurnId: input.turnId ?? null,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 15_000,
    connectTimeoutMs: input.connectTimeoutMs ?? 5_000,
  });
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
