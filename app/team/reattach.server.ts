/**
 * Delegation reattach (issue #267). When the relay's reply stream to a delegated peer dies, the
 * peer does NOT stop: the container keeps running the turn, opens PRs, and can ask the operator a
 * question minutes later. Before this, harnesst treated the severed stream as the turn failing —
 * the delegation was finalized `failed`, the run was marked `failed`, and any later
 * `input.requested` reached no surface at all.
 *
 * So a stream loss with a known session handle is a HAND-OFF, not a failure. The relay adopts the
 * peer session into an agent-opened FOH row (the §9b machinery) and enqueues this job, which polls
 * the peer's durable event log until the turn actually settles, then does the bookkeeping the
 * severed relay could not: file `input.requested`s into the inbox, settle the FOH session, finalize
 * the delegation, and re-finalize the run with its TRUE outcome.
 *
 * Shape copied from the deployment drain watcher (`~/deploy/drain.server`): one bounded tick per
 * job, a deadline carried in the payload so every re-enqueue shares one ceiling anchored at the
 * hand-off, and a `waiting` result that re-enqueues its own successor and counts as job success.
 * That also buys restart survival for free — the worker's boot recovery requeues `running` jobs.
 *
 * Each tick re-reads the peer's stream FROM INDEX 0 rather than from the saved cursor. A delegated
 * peer session is created fresh per ask and holds exactly one turn, so index 0 is that turn's whole
 * log: the settling tick therefore sees the complete reply, step list and token usage, and the run
 * row is re-finalized with a real transcript instead of whatever tail happened to be in flight.
 * Re-reading is safe by construction — the event cache is keyed on (session, streamIndex) and
 * `openInboxQuestion` dedupes on requestId.
 */
import type { TurnResult } from "~/agent/talk.server";
import { resumeTurnStream } from "~/agent/talk.server";
import type { Target } from "~/chat/playground.server";
import type { DataStore } from "~/data/ports";
import {
  openInboxQuestion,
  recordInboxFinished,
  resolveInboxForSession,
} from "~/foh/inbox.server";
import type { FohTurnOutcome } from "~/foh/needs-you";
import { settleFohTurn } from "~/foh/needs-you";
import { enqueue } from "~/jobs/queue.server";
import { externalRunId, recordTurnFinish } from "~/observability/record.server";
import { getRunIdByExternal } from "~/observability/store.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
import {
  clearSessionPendingInput,
  listFohSessionsByIds,
  markSessionPendingInput,
  savePlaygroundSessionCursor,
  settleAbandonedPlaygroundSession,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

/**
 * Hard ceiling on how long harnesst keeps chasing a severed turn. Generous — the whole point is
 * that a delegated turn legitimately outlives the relay's own budget — but finite, so no row can
 * dangle forever waiting on a container that will never answer.
 */
export const DELEGATION_REATTACH_CEILING_MS = Number(
  process.env.HARNESST_DELEGATION_REATTACH_CEILING_MS || 30 * 60 * 1000,
);

/** Gap between polls. */
export const DELEGATION_REATTACH_POLL_MS = Number(
  process.env.HARNESST_DELEGATION_REATTACH_POLL_MS || 30 * 1000,
);

/**
 * Per-tick idle budget. Deliberately short: the worker runs jobs SERIALLY (concurrency 1), so a
 * tick that sat on an open stream for minutes would block deploys and publishes behind it.
 */
const REATTACH_SLICE_IDLE_MS = 15_000;

/**
 * Pre-headers budget for the slice. Eve answers "nothing new" by sending nothing at all — not even
 * response headers — so a connect with no budget would hang the whole tick.
 */
const REATTACH_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Hard wall-clock cap on one slice. The idle budget above only bounds SILENCE; a turn chattering
 * every few seconds would hold the slice open indefinitely and starve every other job.
 */
const REATTACH_SLICE_MAX_MS = 60_000;

/** Everything a tick needs that is not already on the adopted session row. */
export interface ReattachPayload {
  /** The agent-opened FOH session that adopted the peer's eve handles. */
  sessionId: string;
  delegationId: string;
  projectId: string;
  /** The turn harnesst was watching when the stream dropped; null adopts the first turn seen. */
  turnId: string | null;
  /** The prefixed message the relay sent — leads the run transcript, as on the live path. */
  userMessage: string;
  /** Linked-trace run metadata (`{ delegationId, fromAgentId, fromAgentName }`). */
  metadata: Record<string, unknown>;
  /** When the peer turn started (ISO), for the run's wall clock. */
  startedAt: string;
  /** Ceiling anchored at hand-off (ISO); shared by every re-enqueue. */
  deadlineAt: string;
}

export interface ReattachDeps {
  store: DataStore;
  resume: typeof resumeTurnStream;
  loadSession: (id: string) => Promise<PlaygroundSession | null>;
  saveCursor: typeof savePlaygroundSessionCursor;
  failSession: typeof settleAbandonedPlaygroundSession;
  markPending: typeof markSessionPendingInput;
  clearPending: typeof clearSessionPendingInput;
  openQuestion: typeof openInboxQuestion;
  resolveAsks: typeof resolveInboxForSession;
  recordFinished: typeof recordInboxFinished;
  recordFinish: typeof recordTurnFinish;
  resolveRunId: (
    projectId: string,
    externalRunId: string,
  ) => Promise<string | null>;
  enqueueJob: typeof enqueue;
  now: () => Date;
}

export function defaultReattachDeps(): ReattachDeps {
  return {
    store: getRuntime().data,
    resume: resumeTurnStream,
    loadSession: async (id) => (await listFohSessionsByIds([id]))[0] ?? null,
    saveCursor: savePlaygroundSessionCursor,
    failSession: settleAbandonedPlaygroundSession,
    markPending: markSessionPendingInput,
    clearPending: clearSessionPendingInput,
    openQuestion: openInboxQuestion,
    resolveAsks: resolveInboxForSession,
    recordFinished: recordInboxFinished,
    recordFinish: recordTurnFinish,
    resolveRunId: getRunIdByExternal,
    enqueueJob: enqueue,
    now: () => new Date(),
  };
}

export type ReattachResult =
  /** The turn settled; delegation, session and run are finalized with its real outcome. */
  | { status: "settled"; outcome: FohTurnOutcome }
  /** Still running under the ceiling — the successor poll is enqueued. */
  | { status: "waiting"; streamIndex: number }
  /** The ceiling passed with the turn still unsettled; the rows were settled honestly. */
  | { status: "expired" }
  /** Nothing to do — something else already settled this delegation or session. */
  | { status: "skipped"; reason: string };

/**
 * Enqueue the first poll for a handed-off delegation. Deliberately NOT best-effort: the hand-off
 * result tells the calling model that harnesst is watching the turn, and nothing else will ever
 * settle the delegation or the run. If this throws, the relay's hand-off branch catches it and
 * falls back to reporting the failure — an honest bad outcome beats two rows stuck `running`
 * forever behind a promise nobody kept.
 */
export async function scheduleDelegationReattach(
  store: DataStore,
  payload: ReattachPayload,
): Promise<void> {
  await enqueue(
    "reattach_delegation",
    { ...payload },
    {
      runAt: new Date(Date.now() + DELEGATION_REATTACH_POLL_MS),
      maxAttempts: 3,
    },
    store,
  );
}

/**
 * Rebuild the peer target from the session row's environment. The eve session lives in the
 * environment's world store, so any deployment still serving that environment can resume its
 * stream — prefer the live row; a `draining` container (redeploy mid-turn) still answers on
 * its url, so anything with a url is a usable fallback.
 */
async function peerTarget(
  store: DataStore,
  session: PlaygroundSession,
): Promise<Target | null> {
  if (!session.environmentId) return null;
  // listByEnvironment (not findById) — it is the query that carries the release join, and the
  // run recorder needs the releaseId/version the turn actually ran on.
  const rows = await store.deployments.listByEnvironment(session.environmentId);
  const deployment =
    rows.find((d) => d.status === "live" && d.url) ?? rows.find((d) => d.url);
  if (!deployment?.url) return null;
  const environment = await store.environments.findById(session.environmentId);
  return {
    deploymentId: deployment.id,
    environmentId: session.environmentId,
    releaseId: deployment.releaseId,
    url: deployment.url,
    version: deployment.version,
    environmentName: environment?.name ?? "",
    gitSha: deployment.gitSha,
  };
}

/**
 * Read one bounded slice of the peer's stream. The events themselves need no persistence —
 * eve's durable stream is the transcript store — the slice only watches for the turn to settle.
 *
 * Bounded by WALL CLOCK, not just by the idle budget: a busy turn emitting an event every few
 * seconds would reset the idle timer forever, and with the worker at concurrency 1 that one turn
 * would block every deploy and publish behind it — and never reach the deadline check. Breaking out
 * of the generator runs its `finally`, which cancels the reader and closes the stream; the tick
 * then reports `waiting` exactly as if the slice had gone idle.
 */
async function drainSlice(
  session: PlaygroundSession,
  target: Target,
  payload: ReattachPayload,
  deps: ReattachDeps,
): Promise<TurnResult | null> {
  const externalSessionId = session.externalSessionId;
  if (!externalSessionId) return null;
  let result: TurnResult | null = null;
  const sliceEndsAt = deps.now().getTime() + REATTACH_SLICE_MAX_MS;
  for await (const event of deps.resume({
    baseUrl: target.url,
    sessionId: externalSessionId,
    continuationToken: session.continuationToken,
    turnId: payload.turnId,
    streamIndex: 0,
    timeoutMs: REATTACH_SLICE_IDLE_MS,
    connectTimeoutMs: REATTACH_CONNECT_TIMEOUT_MS,
  })) {
    if (event.kind === "done") {
      result = event.result;
    }
    if (deps.now().getTime() >= sliceEndsAt) break;
  }
  return result;
}

/**
 * One tick. Re-reads the rows first (scheduling is never proof the work is still wanted), drains a
 * bounded slice, and either re-enqueues, or performs the settlement bookkeeping the severed relay
 * owed: FOH park/settle, delegation finalize, and the run's true outcome.
 */
export async function reattachDelegation(
  payload: ReattachPayload,
  deps: ReattachDeps = defaultReattachDeps(),
): Promise<ReattachResult> {
  const { store } = deps;

  const delegation = await store.delegations.findById(payload.delegationId);
  if (!delegation) return { status: "skipped", reason: "delegation not found" };
  // Only a `running` row is ours: `waiting` means a human is already answering (the FOH drain owns
  // the settle from there), and completed/failed means something else already finished the job.
  if (delegation.status !== "running") {
    return { status: "skipped", reason: `delegation is ${delegation.status}` };
  }

  const session = await deps.loadSession(payload.sessionId);
  // The row we were watching is gone (the peer agent was removed from the roster, taking its
  // sessions with it) or was never usable. There is nothing left to reattach to — but the
  // delegation is still ours to close, and standing down here is what would leave it `running`
  // forever with no successor and no deadline.
  if (!session || !session.externalSessionId) {
    await store.delegations.finalize(payload.delegationId, {
      status: "failed",
      error:
        "The conversation harnesst was watching for this delegated turn is gone, so its outcome can't be recovered.",
    });
    return { status: "settled", outcome: "failed" };
  }

  // A human hit /stop on the adopted conversation — a deliberate end, not a lost turn, so there is
  // nothing left to drain. But the stop route settles only the session row and the inbox: it knows
  // nothing about delegations or runs. Without this, both would sit `running` forever — the run
  // unreadable, and the edge cap still counting a turn nobody is running.
  if (session.status === "stopped") {
    await settle(
      session,
      await peerTarget(store, session),
      payload,
      deps,
      null,
      "failed",
      {
        error:
          "The conversation was stopped, so the rest of the delegated turn wasn't recovered.",
      },
    );
    return { status: "settled", outcome: "failed" };
  }

  const target = await peerTarget(store, session);
  if (!target) {
    await settle(session, null, payload, deps, null, "failed", {
      error:
        "The teammate's deployment is gone, so the rest of its turn can't be recovered.",
    });
    return { status: "settled", outcome: "failed" };
  }

  const result = await drainSlice(session, target, payload, deps);

  // `streamLost` is the discriminator, not the error text: the slice ended without the turn
  // settling, which on this path means "still working", not "failed".
  if (result === null || result.streamLost) {
    const observed = Math.max(session.streamIndex, result?.streamIndex ?? 0);
    if (deps.now().getTime() < Date.parse(payload.deadlineAt)) {
      // Bump the row so `shouldSettleAbandonedSession` does not mistake a long silent tool call
      // for a session abandoned by a dead drain.
      await deps
        .saveCursor({
          id: session.id,
          target,
          externalSessionId: session.externalSessionId,
          continuationToken: session.continuationToken,
          streamIndex: observed,
          status: "running",
        })
        .catch((error) =>
          console.error("[team] reattach cursor save failed:", error),
        );
      // Unlike the initial schedule this THROWS on failure, so the worker retries the tick rather
      // than silently abandoning a turn nobody else is watching.
      await deps.enqueueJob(
        "reattach_delegation",
        // Carry forward a turn id the slice discovered: the stream can break before harnesst ever
        // sees `message.received`, and without this every successor re-adopts from scratch.
        { ...payload, turnId: payload.turnId ?? result?.turnId ?? null },
        {
          runAt: new Date(deps.now().getTime() + DELEGATION_REATTACH_POLL_MS),
          maxAttempts: 3,
        },
        store,
      );
      return { status: "waiting", streamIndex: observed };
    }
    await settle(session, target, payload, deps, result, "failed", {
      error: `The teammate's turn was still running ${Math.round(
        DELEGATION_REATTACH_CEILING_MS / 60_000,
      )} minutes after harnesst lost its reply stream, so harnesst stopped waiting for it.`,
    });
    return { status: "expired" };
  }

  const decision = settleFohTurn(result);
  await settle(session, target, payload, deps, result, decision.outcome, {});
  return { status: "settled", outcome: decision.outcome };
}

/**
 * Terminal bookkeeping for a reattached turn — the same writes the live FOH drain performs in its
 * `finally` (chokepoint #1's terminal half), plus the delegation and run finalize the relay would
 * have done had its stream survived.
 *
 * ORDER IS LOad-BEARING, because the only recovery available is "throw, and let the worker retry
 * the whole tick". A retry re-derives everything from the peer's durable log, but it is skipped
 * once the delegation is no longer `running` — so the delegation finalize has to come LAST among
 * the writes that must not be lost, and every one of those has to throw rather than log:
 *
 *   1. session row      — recoverable by the abandoned-session sweep; log and continue
 *   2. run finalize     — MUST throw: after the delegation closes, no retry can repair it
 *   3. needs-you flag   — setting it MUST throw (an inbox item with no park state is invisible);
 *                         clearing it is recoverable by the loader reconcile, so that one logs
 *   4. questions        — MUST throw; idempotent on requestId, so a retry cannot duplicate them
 *   5. delegation       — MUST throw, and last: closing it disarms every retry above
 *   6. finished notice  — after the point of no return precisely BECAUSE it has no dedupe key;
 *                         a retry would post a second one, so it must never be the reason for one
 */
async function settle(
  session: PlaygroundSession,
  target: Target | null,
  payload: ReattachPayload,
  deps: ReattachDeps,
  result: TurnResult | null,
  outcome: FohTurnOutcome,
  override: { error?: string },
): Promise<void> {
  const { store } = deps;
  const error = override.error ?? result?.error ?? null;
  const sessionId = result?.sessionId ?? session.externalSessionId;

  // 1. Session row. A settled turn moves the cursor to its true end; with no target or no result
  //    there is nothing to write except the row's status, which must stop claiming to be running.
  //    A row that /stop already settled is left alone — it is terminal and not ours to reopen.
  if (session.status === "stopped") {
    // nothing to write
  } else if (target && result) {
    try {
      await deps.saveCursor({
        id: session.id,
        target,
        externalSessionId: sessionId,
        continuationToken:
          result.continuationToken ?? session.continuationToken,
        streamIndex: Math.max(session.streamIndex, result.streamIndex),
        status: outcome === "failed" ? "failed" : "waiting",
      });
    } catch (e) {
      console.error("[team] reattach cursor settle failed:", e);
    }
  } else {
    try {
      await deps.failSession(session);
    } catch (e) {
      console.error("[team] reattach session settle failed:", e);
    }
  }

  // 2. The run's real outcome (defect 3). The relay deliberately left this row `running` rather
  //    than reporting a transport failure as an agent failure — this is where it settles. Runs
  //    before the inbox so the question item can point at the run the operator should read.
  let runId: string | null = null;
  // With no drained result — the conversation was stopped, or the ceiling passed with nothing new —
  // the run still has to stop claiming to be running, so it is finalized from what the payload
  // knows. An empty `steps` list never replaces a transcript (the ingest only rewrites steps when
  // it is given some), so this cannot erase what earlier ticks recorded.
  const runTurnId = result?.turnId ?? payload.turnId;
  if (target && sessionId && runTurnId) {
    const runExternalId = externalRunId(sessionId, runTurnId);
    const startedAt = new Date(payload.startedAt);
    const finished: TurnResult = result ?? {
      ok: false,
      sessionId,
      continuationToken: session.continuationToken,
      streamIndex: session.streamIndex,
      reply: null,
      replyIsStructured: false,
      inputRequests: [],
      modelId: null,
      turnId: runTurnId,
      steps: [],
      messages: [],
      error,
    };
    try {
      await deps.recordFinish({
        projectId: payload.projectId,
        deploymentId: target.deploymentId,
        releaseId: target.releaseId,
        externalRunId: runExternalId,
        externalSessionId: sessionId,
        result: override.error ? { ...finished, ok: false, error } : finished,
        userMessage: payload.userMessage,
        channel: "teammate",
        metadata: payload.metadata,
        startedAt,
        wallClockMs: Math.max(0, deps.now().getTime() - startedAt.getTime()),
      });
      runId = await deps.resolveRunId(payload.projectId, runExternalId);
    } catch (e) {
      console.error("[team] reattach run finalize failed:", e);
      throw e;
    }
  }

  // 3. FOH needs-you (D4/D13): a parked turn keeps its flag, a settled one clears it. `parked`
  //    is only honoured if the row still ACCEPTS the flag — a /stop that won the race between the
  //    status check and here returns false, and calling that "waiting for a human" would park the
  //    delegation on a conversation nobody can answer.
  let parked = false;
  if (outcome === "parked") {
    parked = await deps.markPending(session.id, deps.now());
  } else {
    // Best-effort, unlike the park flag: a stale needs-you flag is exactly what the FOH loader's
    // reconcile (chokepoint #2) exists to clean up, so losing this must not cost the delegation
    // finalize below its one shot.
    try {
      await deps.clearPending(session.id);
      await deps.resolveAsks(session.id, store);
    } catch (e) {
      console.error("[team] reattach needs-you clear failed:", e);
    }
  }

  // 4. The questions themselves — the point of the whole issue: the operator's question reaches the
  //    inbox even though nobody was watching the stream when it was asked.
  if (parked) {
    for (const request of result?.inputRequests ?? []) {
      await deps.openQuestion(
        {
          projectId: payload.projectId,
          sessionId: session.id,
          agentId: session.agentId,
          userId: null,
          delegationId: payload.delegationId,
          runId,
          request,
        },
        store,
      );
    }
  }

  // 5. Finalize the delegation — LAST of the must-not-lose writes, because it is what disarms the
  //    retry. `parked` becomes `waiting` — exactly the state §9b relay parking produces — so a
  //    human's answer settles it through the ordinary FOH resume path
  //    (`finalizeDelegationOnResume`), with no second mechanism.
  const status = parked
    ? ("waiting" as const)
    : outcome === "completed"
      ? ("completed" as const)
      : ("failed" as const);
  await store.delegations.finalize(payload.delegationId, {
    status,
    ...(status === "failed"
      ? {
          error:
            error ??
            "The delegated turn failed after harnesst lost its reply stream.",
        }
      : {}),
    externalSessionId: sessionId,
    runId,
  });

  // 6. The team-wide "finished" notice. Deliberately after the delegation closed: it has no dedupe
  //    key, so a retry would post a duplicate — and now no retry can reach it.
  if (status === "completed") {
    try {
      await deps.recordFinished(
        {
          projectId: payload.projectId,
          sessionId: session.id,
          agentId: session.agentId,
          userId: null,
          // A finish summary, not the full reply — the inbox row is a pointer.
          prompt: result?.reply ? result.reply.slice(0, 500) : null,
        },
        store,
      );
    } catch (e) {
      console.error("[team] reattach finished notice failed:", e);
    }
  }
}
