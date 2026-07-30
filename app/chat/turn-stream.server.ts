/**
 * Shared streaming-turn machinery for harnesst's durable chat surfaces (playground + assistant).
 *
 * Both surfaces drive an eve turn over `streamTurn`, re-emit it to the browser as NDJSON, and —
 * critically — keep draining Eve to the terminal `done` even if the client disconnects, then
 * persist the session cursor and record the run. That disconnect-safe drain is identical for
 * both, so it lives here once. Each surface just resolves a `Target` + a `playgroundSessions`
 * row (the table is generic) and calls `streamTurnResponse`; the only difference is the
 * observability `channel`.
 */
import {
  streamTurn,
  type TurnResult,
  type TurnStep,
} from "~/agent/talk.server";
import type { Target } from "~/chat/playground.server";
import { normalizeTurnError } from "~/chat/stream-error";
import type { ChatStep } from "~/chat/types";
import {
  externalRunId,
  recordTurnFinish,
  recordTurnStart,
} from "~/observability/record.server";
import { channelDeliveryFor, channelLabelFor } from "~/foh/channel-resume";
import { settleFohTurn } from "~/foh/needs-you";
import { mintDelegationToken } from "~/team/token.server";
import {
  openInboxQuestion,
  recordInboxFinished,
  resolveInboxForSession,
} from "~/foh/inbox.server";
import { finalizeDelegationOnResume } from "~/team/resume.server";
import {
  clearSessionPendingInput,
  markSessionPendingInput,
  savePlaygroundEvents,
  savePlaygroundSessionCursor,
  savePlaygroundSessionProgress,
  unbindPlaygroundSessionForReseed,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import type { RawEveEvent } from "~/agent/talk.server";
import {
  recordSyncFailure,
  syncConversationCheckout,
} from "~/assistant/checkout-sync.server";

/** Eve turns can run for hours; fail only after this much silence on the event stream. */
export const TURN_IDLE_TIMEOUT_MS = 5 * 60_000;

const activeTurnControllers = new Map<string, AbortController>();

export function cancelActiveTurn(playgroundSessionId: string): boolean {
  const controller = activeTurnControllers.get(playgroundSessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Whether a turn for this session is actively streaming in THIS process (its drain is alive and
 * persisting progress). Reconnect uses this to tell a genuinely-live session apart from one stuck
 * `running` because its drain died with the harnesst process (restart/redeploy mid-turn) — only the
 * latter needs a status reconcile from Eve.
 */
export function hasActiveTurn(playgroundSessionId: string): boolean {
  return activeTurnControllers.has(playgroundSessionId);
}

/** Lean step projection sent to the browser (full actions go only to the recorder). */
export function toChatStep(step: TurnStep): ChatStep {
  return {
    type: step.type,
    name: step.name ?? null,
    durationMs: step.durationMs ?? null,
    tokensIn: step.tokensIn ?? null,
    tokensOut: step.tokensOut ?? null,
    isError: step.isError,
    code: step.code ?? null,
    message: step.message ?? null,
    details: step.details ?? null,
    toolName: step.toolName ?? null,
    summary: step.summary ?? null,
  };
}

export function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

/**
 * How this turn is delivered (WS1). `http` for every ordinary session — the unchanged
 * `/eve/v1/session/:id` path — and `channel` for a session eve homed on a channel.
 *
 * There is no third option for a channel-homed row, and that is the whole point of the union:
 * eve resolves a channel-homed session's continuation token ONLY through the channel that owns
 * it, so the HTTP session route answers 500 "the target session was not found via continuation
 * token". Returning null here (as this once did when the bearer could not be minted) does not
 * degrade gracefully — it aims the turn straight at the known-broken route and reports the eve
 * 500 as if the agent had misbehaved. A row we cannot build a delivery for FAILS the turn with
 * a message that names the real cause.
 */
type ChannelDeliveryResolution =
  | { kind: "http" }
  | { kind: "channel"; via: NonNullable<ReturnType<typeof channelDeliveryFor>> }
  | { kind: "unavailable"; error: string };

function resolveChannelDelivery(
  session: PlaygroundSession,
  target: Target,
): ChannelDeliveryResolution {
  if (!session.resumeVia) return { kind: "http" };
  let bearer: string;
  try {
    // Minted for the deployment resolved for THIS turn, never the one recorded at park time: a
    // redeploy rotates the container's baked HARNESST_TEAM_TOKEN, and a stale token would 401.
    bearer = mintDelegationToken(target.deploymentId);
  } catch (error) {
    console.error("[foh] could not mint the channel-answer bearer:", error);
    return {
      kind: "unavailable",
      error:
        "This conversation lives on the agent's own channel thread and harnesst could not mint the credential needed to reach it — the server is missing HARNESST_SECRETS_KEY. Nothing was sent.",
    };
  }
  const via = channelDeliveryFor(session, bearer);
  if (!via) {
    return {
      kind: "unavailable",
      error:
        "This conversation lives on the agent's own channel thread, but the resume descriptor stored for it is not one harnesst can deliver to. Nothing was sent.",
    };
  }
  return { kind: "channel", via };
}

/**
 * Run one streaming turn against `target`, persisting into `session` (a playgroundSessions row,
 * already flipped to `running` by the caller), and return the NDJSON Response. The consume loop
 * is detached from the response lifecycle: it drains Eve to `done`, saves the cursor, and records
 * the run regardless of whether the client is still reading.
 */
export function streamTurnResponse(input: {
  projectId: string;
  target: Target;
  session: PlaygroundSession;
  message: string;
  /** Observability channel — "playground" | "assistant" | "foh". */
  channel: string;
  /** Recompute the session title on the first turn (null once titled). */
  title: string | null;
  /**
   * System context prepended to what's SENT to the agent this turn (e.g. the assistant's checkout
   * path + a base-advanced note) but NOT recorded/echoed as the user's message. Optional.
   */
  messagePrefix?: string | null;
  /**
   * Request-correlated HITL answers (FOH answer path): forwarded to eve as `inputResponses`
   * on the continuation send, so only the clicked request resolves — never the whole
   * pending batch. Recording/display still use `message`.
   */
  inputResponses?: ReadonlyArray<{
    requestId: string;
    optionId?: string;
    text?: string;
  }> | null;
  /**
   * Per-turn fencing token (issue #221 finding 5): the FOH route's atomic claim id. When set,
   * the drain's progress/cursor saves carry it so a superseded drain (another request claimed
   * the session over a stale `running`) writes zero rows. Builder callers omit it — their
   * behavior is byte-identical to before.
   */
  claimId?: string | null;
}): Response {
  const {
    projectId,
    target,
    session: activeSession,
    message,
    channel,
    title,
  } = input;
  // What eve actually receives (prefixed with system context); recording/display use plain `message`.
  const sentMessage = input.messagePrefix
    ? `${input.messagePrefix}\n\n${message}`
    : message;
  const tag = `[${channel}]`;
  // Needs-you writes happen only for FOH conversations (D4) — the builder surfaces must be
  // byte-for-byte unaffected by this chokepoint.
  const isFoh = activeSession.surface === "foh";
  // Named when this session is homed on a channel — a transient failure there is not retryable
  // from harnesst, so the error we render must not offer a button that only leads to a refusal.
  const channelLabel = activeSession.resumeVia
    ? channelLabelFor(activeSession.resumeVia.channel)
    : null;
  const startedAt = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let clientGone = false;
      const send = (event: Record<string, unknown>) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          clientGone = true;
        }
      };

      void (async () => {
        let sessionId: string | null = activeSession.externalSessionId;
        let continuationToken: string | null = activeSession.continuationToken;
        let streamIndex = activeSession.streamIndex;
        let savedSessionId: string | null = activeSession.externalSessionId;
        let savedStreamIndex = activeSession.streamIndex;
        let lastProgressSavedAt = 0;
        let progressSave: Promise<void> = Promise.resolve();
        // Durable transcript cache: buffer raw events and flush in batches on the same ~1s cadence
        // as the cursor save, so reconnect reads the transcript from harnesst's DB instead of replaying
        // Eve from index 0 (and a crash mid-turn still leaves a durable partial transcript).
        //
        // Invariant: the persisted cursor must never advance past events that aren't durably in
        // `playground_events` — the loader treats the cache as the transcript's source of truth,
        // and the next turn drains Eve from the cursor, so an event the cursor skips is lost for
        // good. Hence a failed batch is re-queued for the next flush (retry is a safe no-op via
        // the PK + ON CONFLICT DO NOTHING), and every cursor save caps itself at
        // `persistedEventIndex`, the highest index a batch insert has actually confirmed.
        const pendingEvents: Array<{ streamIndex: number } & RawEveEvent> = [];
        let persistedEventIndex = activeSession.streamIndex;
        let eventSave: Promise<void> = Promise.resolve();
        const flushEvents = () => {
          if (pendingEvents.length === 0) return;
          const batch = pendingEvents.splice(0, pendingEvents.length);
          eventSave = eventSave.then(async () => {
            try {
              // `batch` indices are eve-space (the cursor scheme); the reseed offset is applied
              // at the persist boundary so cursor bookkeeping below stays eve-space (#71).
              await savePlaygroundEvents(
                activeSession.id,
                batch,
                activeSession.cacheIndexOffset,
              );
              persistedEventIndex = Math.max(
                persistedEventIndex,
                batch[batch.length - 1].streamIndex,
              );
            } catch (e) {
              // Put the batch back so a later flush retries it; the cursor cap (above) keeps the
              // not-yet-persisted indices replayable from Eve in the meantime.
              pendingEvents.unshift(...batch);
              console.error(`${tag} persist transcript events failed`, e);
            }
          });
        };
        let recorded = false;
        let startRecording: Promise<void> = Promise.resolve();
        let result: TurnResult | null = null;
        const turnController = new AbortController();
        activeTurnControllers.set(activeSession.id, turnController);

        const queueProgressSave = (force = false) => {
          if (!sessionId) return;
          const nextStreamIndex = Math.max(
            streamIndex,
            activeSession.streamIndex,
          );
          const now = Date.now();
          const sessionChanged = sessionId !== savedSessionId;
          const advanced = nextStreamIndex > savedStreamIndex;
          if (
            !force &&
            !sessionChanged &&
            (!advanced || now - lastProgressSavedAt < 1_000)
          ) {
            return;
          }
          const externalSessionId = sessionId;
          const nextContinuationToken = continuationToken;
          savedSessionId = externalSessionId;
          savedStreamIndex = nextStreamIndex;
          lastProgressSavedAt = now;
          flushEvents();
          // Order matters: the cursor save runs after the event batch it covers has settled, and
          // caps at `persistedEventIndex` so a failed batch (re-queued above) is never skipped
          // over. `savedStreamIndex` stays optimistic — a retried batch that later lands lets the
          // next save catch the cursor up.
          const coveringEventSave = eventSave;
          progressSave = progressSave
            .catch(() => {})
            .then(() => coveringEventSave)
            .then(() =>
              savePlaygroundSessionProgress({
                id: activeSession.id,
                target,
                externalSessionId,
                continuationToken: nextContinuationToken,
                streamIndex: Math.min(nextStreamIndex, persistedEventIndex),
                title,
                claimId: input.claimId ?? undefined,
              }).catch((e) =>
                console.error(`${tag} persist session progress failed`, e),
              ),
            );
        };

        try {
          // Channel-homed rows (WS1) deliver through the channel that owns the eve session, and
          // NEVER fall back to the HTTP session route when that cannot be arranged.
          const delivery = resolveChannelDelivery(activeSession, target);
          if (delivery.kind === "unavailable") {
            result = {
              ok: false,
              sessionId,
              continuationToken,
              streamIndex,
              reply: null,
              replyIsStructured: false,
              inputRequests: [],
              modelId: null,
              turnId: null,
              steps: [],
              messages: [],
              error: delivery.error,
              // "Nothing was sent" (see the messages above) — the agent was never contacted,
              // so the finally below must not settle this as a failed turn.
              notDelivered: true,
            };
            send({
              type: "done",
              ok: false,
              playgroundSessionId: activeSession.id,
              reply: null,
              structured: false,
              inputRequests: [],
              error: delivery.error,
              errorDetail: null,
              errorRetryable: false,
              modelId: null,
              version: target.version,
            });
            // `finally` still runs, and its `notDelivered` branch leaves the row untouched.
            return;
          }
          for await (const event of streamTurn({
            baseUrl: target.url,
            message: sentMessage,
            inputResponses: input.inputResponses,
            sessionId,
            continuationToken: activeSession.continuationToken,
            deliverVia: delivery.kind === "channel" ? delivery.via : null,
            streamIndex: activeSession.streamIndex,
            signal: turnController.signal,
            timeoutMs: TURN_IDLE_TIMEOUT_MS,
          })) {
            switch (event.kind) {
              case "session":
                sessionId = event.sessionId;
                continuationToken = event.continuationToken;
                queueProgressSave(true);
                send({
                  type: "session",
                  playgroundSessionId: activeSession.id,
                });
                break;
              case "progress":
                sessionId = event.sessionId;
                continuationToken = event.continuationToken;
                streamIndex = event.streamIndex;
                pendingEvents.push({
                  streamIndex: event.streamIndex,
                  ...event.rawEvent,
                });
                queueProgressSave();
                break;
              case "turn":
                queueProgressSave(true);
                if (!recorded && sessionId) {
                  recorded = true;
                  const runId = externalRunId(sessionId, event.turnId);
                  startRecording = recordTurnStart({
                    projectId,
                    deploymentId: target.deploymentId,
                    releaseId: target.releaseId,
                    externalRunId: runId,
                    externalSessionId: sessionId,
                    userMessage: message,
                    channel,
                  })
                    .then(() => undefined)
                    .catch((e) =>
                      console.error(`${tag} recordTurnStart failed`, e),
                    );
                }
                break;
              case "model":
                send({ type: "model", modelId: event.modelId });
                break;
              case "thinking":
                send({ type: "thinking" });
                break;
              case "action":
                send({
                  type: "action",
                  toolName: event.toolName,
                  summary: event.summary ?? null,
                });
                break;
              case "text":
                send({ type: "text", text: event.text });
                break;
              case "step":
                send({ type: "step", step: toChatStep(event.step) });
                break;
              case "input":
                send({ type: "input", requests: event.requests });
                // FOH needs-you chokepoint #1 (D4): record the park durably, so it exists
                // even with no client connected. `openInboxQuestion` dedupes on requestId
                // (the loader-side reconcile can observe the same eve request). Wrapped so
                // inbox bookkeeping can never break the drain; it touches neither the
                // cursor nor `streamIndex`. The park claim reports whether it won its
                // stop-wins guard — when stop got there first, filing inbox items for the
                // stopped session would resurrect it into the inbox (issue #221 finding 4).
                if (isFoh) {
                  try {
                    const parked = await markSessionPendingInput(
                      activeSession.id,
                    );
                    if (parked) {
                      for (const request of event.requests) {
                        await openInboxQuestion({
                          projectId,
                          sessionId: activeSession.id,
                          agentId: activeSession.agentId,
                          userId: activeSession.createdBy,
                          delegationId: activeSession.delegationId,
                          request,
                        });
                      }
                    }
                  } catch (e) {
                    console.error(`${tag} foh needs-you park failed`, e);
                  }
                }
                break;
              case "done": {
                result = event.result;
                const normalizedError = normalizeTurnError(event.result.error, {
                  channelLabel,
                });
                if (normalizedError?.retryable) {
                  console.warn(
                    `${tag} transient provider stream error (shown to user as retryable):`,
                    event.result.error,
                  );
                }
                send({
                  type: "done",
                  ok: event.result.ok,
                  playgroundSessionId: activeSession.id,
                  reply: event.result.reply,
                  structured: event.result.replyIsStructured,
                  inputRequests: event.result.inputRequests,
                  error: normalizedError?.message ?? null,
                  errorDetail: normalizedError?.detail ?? null,
                  errorRetryable: normalizedError?.retryable ?? false,
                  modelId: event.result.modelId,
                  version: target.version,
                });
                break;
              }
            }
          }
        } catch (error) {
          result = {
            ok: false,
            sessionId,
            continuationToken,
            streamIndex,
            reply: null,
            replyIsStructured: false,
            inputRequests: [],
            modelId: null,
            turnId: null,
            steps: [],
            messages: [],
            error: `The turn stream failed: ${(error as Error).message}`,
          };
          const normalizedError = normalizeTurnError(result.error, {
            channelLabel,
          });
          if (normalizedError?.retryable) {
            console.warn(
              `${tag} transient provider stream error (shown to user as retryable):`,
              result.error,
            );
          }
          send({
            type: "done",
            ok: false,
            reply: null,
            structured: false,
            inputRequests: [],
            error: normalizedError?.message ?? null,
            errorDetail: normalizedError?.detail ?? null,
            errorRetryable: normalizedError?.retryable ?? false,
            modelId: null,
            version: target.version,
          });
        } finally {
          if (activeTurnControllers.get(activeSession.id) === turnController) {
            activeTurnControllers.delete(activeSession.id);
          }
          flushEvents();
          await eventSave;
          if (pendingEvents.length > 0) {
            // A batch insert failed mid-turn and was re-queued — this is the drain's last chance
            // to land it before exiting, so retry once more.
            flushEvents();
            await eventSave;
          }
          await progressSave;
          if (result) {
            const settled: TurnResult = result;
            // Issue #282: a `notDelivered` result means the send was refused BEFORE the agent
            // was contacted — failing to send is not a failed turn. Eve is exactly where it was
            // (a channel-homed row is by definition parked at `session.waiting`), so the row
            // must not be settled: no `failed` status, no cursor/handle movement, no needs-you
            // clear, no inbox resolve, no delegation finalize, no run recording. The only write
            // is restoring the status the pre-turn claim flipped to `running` — leaving that
            // would strand the row "running" with nothing draining it. `waiting` is the truthful
            // pre-turn state; everything else on the row is passed back unchanged.
            const notDelivered = settled.notDelivered === true;
            try {
              if (notDelivered) {
                await savePlaygroundSessionCursor({
                  id: activeSession.id,
                  target,
                  externalSessionId: activeSession.externalSessionId,
                  continuationToken: activeSession.continuationToken,
                  streamIndex: activeSession.streamIndex,
                  status: "waiting",
                  claimId: input.claimId ?? undefined,
                });
              } else {
                await savePlaygroundSessionCursor({
                  id: activeSession.id,
                  target,
                  externalSessionId:
                    settled.sessionId ?? activeSession.externalSessionId,
                  continuationToken:
                    settled.continuationToken ?? activeSession.continuationToken,
                  // Capped at what's durably cached (see the invariant above): if the final event
                  // batch never landed, leaving the cursor behind means the missing events are
                  // re-read from Eve later (the next turn's drain, or the loader's reconcile for a
                  // failed session) and cached then — instead of being skipped forever.
                  streamIndex: Math.min(
                    Math.max(settled.streamIndex, activeSession.streamIndex),
                    persistedEventIndex,
                  ),
                  title,
                  status: settled.ok ? "waiting" : "failed",
                  claimId: input.claimId ?? undefined,
                });
              }
            } catch (e) {
              console.error(`${tag} persist session cursor failed`, e);
            }
            // WS1 recovery. The channel route told us the eve session this row resumes into is
            // gone — the container was replaced. The descriptor can never resolve again, so
            // unbind it here (and ONLY here: a GitHub outage or a bad token must leave the row
            // bound so a retry still works). The next message on this conversation then takes
            // the ordinary #71 reseed path — a fresh eve session seeded from the durable
            // transcript — instead of failing with the same message forever.
            if (activeSession.resumeVia && settled.resumeExpired) {
              try {
                await unbindPlaygroundSessionForReseed(activeSession);
              } catch (e) {
                console.error(`${tag} channel resume unbind failed`, e);
              }
            }
            // FOH needs-you chokepoint #1, terminal half (D4/D13): a parked turn keeps its
            // pending flag and inbox items; a completed turn clears them and files the
            // `finished` item; a failed turn clears them (the session itself shows
            // done-with-error). Exception-swallowed like every other post-turn write.
            // A refused send (`notDelivered`) is none of these: eve still holds the pending
            // question, so the park state and any delegation stay exactly as they were.
            if (isFoh && !notDelivered) {
              const decision = settleFohTurn(settled);
              try {
                if (decision.clearPending) {
                  await clearSessionPendingInput(activeSession.id);
                }
                if (decision.resolveAsks) {
                  await resolveInboxForSession(activeSession.id);
                }
                if (decision.recordFinished) {
                  await recordInboxFinished({
                    projectId,
                    sessionId: activeSession.id,
                    agentId: activeSession.agentId,
                    userId: activeSession.createdBy,
                    // A finish summary, not the full reply — the inbox row is a pointer.
                    prompt: settled.reply ? settled.reply.slice(0, 500) : null,
                  });
                }
              } catch (e) {
                console.error(`${tag} foh inbox settle failed`, e);
              }
              // Delegation wake-on-answer (§5): this session was opened by the relay for a
              // parked delegation — a completed/failed resume settles the `waiting` row (a
              // re-park keeps it waiting; the chokepoint above filed the fresh inbox item).
              // Separate try so an inbox hiccup can never strand the delegation, and vice
              // versa.
              if (activeSession.delegationId) {
                try {
                  await finalizeDelegationOnResume({
                    delegationId: activeSession.delegationId,
                    outcome: decision.outcome,
                    error: settled.error,
                  });
                } catch (e) {
                  console.error(`${tag} foh delegation finalize failed`, e);
                }
              }
            }
            // (`turnId` is always null on a `notDelivered` result — there was no turn to
            // record; the guard keeps that invariant explicit.)
            if (settled.sessionId && settled.turnId && !notDelivered) {
              try {
                await startRecording;
                await recordTurnFinish({
                  projectId,
                  deploymentId: target.deploymentId,
                  releaseId: target.releaseId,
                  externalRunId: externalRunId(
                    settled.sessionId,
                    settled.turnId,
                  ),
                  externalSessionId: settled.sessionId,
                  result: settled,
                  userMessage: message,
                  channel,
                  startedAt,
                  wallClockMs: Date.now() - startedAt.getTime(),
                });
              } catch (e) {
                console.error(`${tag} recordTurnFinish failed`, e);
              }
            }
            // Assistant coding-agent sync: after the turn settles, stage the conversation
            // checkout's changes as drafts and mirror them to its durability branch. Runs
            // regardless of turn success — a failed turn may still have edited files; the sync
            // hashes the tree and no-ops when nothing changed. The outcome is emitted to a
            // still-attached client (`sync` event) and failures are recorded on the checkout
            // row — a swallowed failure here left users believing changes were saved while
            // nothing ever reached the staging area.
            if (channel === "assistant" && target.deploymentId) {
              try {
                const sync = await syncConversationCheckout({
                  projectId,
                  conversationId: activeSession.id,
                  deploymentId: target.deploymentId,
                });
                if (sync.kind === "synced") {
                  send({
                    type: "sync",
                    synced: true,
                    stagedCount: sync.stagedCount,
                    error: null,
                  });
                } else if (sync.kind === "failed") {
                  console.error(
                    `${tag} assistant checkout sync failed: ${sync.reason}`,
                  );
                  send({
                    type: "sync",
                    synced: false,
                    stagedCount: 0,
                    error: sync.reason ?? "the checkout sync failed",
                  });
                }
              } catch (e) {
                console.error(`${tag} assistant checkout sync failed`, e);
                await recordSyncFailure({
                  conversationId: activeSession.id,
                  projectId,
                  reason: e instanceof Error ? e.message : String(e),
                });
                send({
                  type: "sync",
                  synced: false,
                  stagedCount: 0,
                  error:
                    e instanceof Error ? e.message : "the checkout sync failed",
                });
              }
            }
          }
          try {
            controller.close();
          } catch {
            // already closed / errored — fine
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
