/**
 * Push-side run ingest (WS2) — the control-plane half of `agent/hooks/harnesst-runs.ts`.
 *
 * The reconciler (reconcile.server.ts) PULLS: it reads an environment's Workflow world database
 * to discover channel-homed sessions, then drains eve's replay stream. A production run on
 * 2026-07-26/27 established that the world databases are permanently empty — the deployed eve
 * 0.22.6 has no Postgres workflow backend, so `WORKFLOW_POSTGRES_URL` is dead config and session
 * state lives on the container filesystem. On top of that, only ONE of four deploy targets even
 * implements `listWorldSessions`. The pull has therefore never written a single row for any
 * channel, and could not have for nomad/vercel/container deployments in any case.
 *
 * This module is the same ingest reached the other way round: the container reports its own turn
 * (agent-level `eve/hooks`, every channel, every deploy target) and harnesst folds it here. The
 * fold and the write are DELIBERATELY the existing ones —
 *
 *   foldSessionEvents  (pure, already unit-tested, already handles every event type)
 *   recordTurnStart / recordTurnFinish → ingestRunStart / ingestRun
 *
 * — so push and pull converge on the same rows rather than racing. Idempotency needs no new
 * table and no cursor: `runs_external_uq (project_id, external_run_id)` makes the upsert unique,
 * `ingestRunWith` replaces a run's steps wholesale, and its `setWhere` guard means a re-sent
 * `running` report can never resurrect a row a completion already made terminal. That is why the
 * hook re-sends the WHOLE turn on every flush instead of a tail.
 *
 * Deps are injected (the `runAsk`/`parkChannelQuestion` shape) so the whole decision path
 * unit-tests with zero I/O.
 */
import type { DataStore } from "~/data/ports";
import {
  externalRunId,
  recordTurnFinish,
  recordTurnStart,
} from "~/observability/record.server";
import {
  channelForTrigger,
  foldSessionEvents,
  type IndexedEveEvent,
} from "~/observability/session-turns.server";
import { getRuntime } from "~/seams/index.server";

/** Refuse absurd payloads before they reach the fold. Mirrors the hook's own caps, with slack. */
export const MAX_PUSHED_EVENTS = 2_500;
/** Cap on the raw request body. The hook trims itself to ~1MB; this is the hard ceiling. */
export const MAX_PUSHED_BODY_BYTES = 4 * 1024 * 1024;

/** One raw stream event as the hook forwarded it. */
export interface PushedEvent {
  type: string;
  data: Record<string, unknown>;
  meta?: { at?: string };
}

export interface PushedTurn {
  /** eve's session id (`ctx.session.id`). */
  sessionId: string;
  /** eve's turn id (`ctx.session.turn.id`) — which turn of `events` to record. */
  turnId: string;
  turnSequence?: number | null;
  /** `ctx.channel.kind` — namespaced (`channel:github`) for every authored channel. */
  channelKind?: string | null;
  modelId?: string | null;
  agentName?: string | null;
  final?: boolean;
  truncated?: boolean;
  events: PushedEvent[];
}

export interface PushIngestDeps {
  store: DataStore;
  recordStart: typeof recordTurnStart;
  recordFinish: typeof recordTurnFinish;
}

export function defaultPushIngestDeps(): PushIngestDeps {
  return {
    store: getRuntime().data,
    recordStart: recordTurnStart,
    recordFinish: recordTurnFinish,
  };
}

export type PushIngestResult =
  | { ok: true; recorded: boolean; reason?: string }
  | { ok: false; error: string };

function deny(error: string): PushIngestResult {
  return { ok: false, error };
}

/** Validate one inbound event. Anything unrecognisable is dropped, never fatal. */
export function normalizePushedEvents(value: unknown): PushedEvent[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_PUSHED_EVENTS) return null;
  const out: PushedEvent[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.type !== "string" || !entry.type) continue;
    const data =
      typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : {};
    const meta =
      typeof entry.meta === "object" && entry.meta !== null && !Array.isArray(entry.meta)
        ? (entry.meta as { at?: unknown })
        : null;
    out.push({
      type: entry.type,
      data,
      meta: meta && typeof meta.at === "string" ? { at: meta.at } : undefined,
    });
  }
  return out;
}

/**
 * Record one pushed turn.
 *
 * `deploymentId` is the id the route's bearer authenticated and NOTHING else about the caller is
 * taken off the wire — environment, agent, project and release are re-derived server-side, the
 * same rule `runAsk` and `parkChannelQuestion` follow.
 *
 * A turn whose channel classifies to null (an `http`-homed playground/assistant/teammate turn,
 * or an unclassifiable empty kind) is a successful no-op, not an error: the agent must not retry
 * it, and harnesst already records those turns in-process. Double-writing them would fight the
 * terminal-state guard in `ingestRunWith`.
 */
export async function ingestPushedTurn(
  input: { deploymentId: string } & PushedTurn,
  deps: PushIngestDeps,
): Promise<PushIngestResult> {
  const { store } = deps;

  if (!input.sessionId) return deny("No eve session id was sent.");
  if (!input.turnId) return deny("No eve turn id was sent.");
  if (!Array.isArray(input.events)) return deny("No events were sent.");

  // Decide BEFORE any lookup: an http-homed turn is the overwhelming majority of traffic and
  // must cost the control plane nothing.
  const channel = channelForTrigger(input.channelKind ?? "");
  if (!channel) {
    return { ok: true, recorded: false, reason: "channel-not-recorded" };
  }

  const deployment = await store.deployments.findById(input.deploymentId);
  if (!deployment) return deny("Your deployment is no longer known to harnesst.");
  const environment = await store.environments.findById(deployment.environmentId);
  if (!environment) return deny("Your environment is no longer known to harnesst.");
  const agent = await store.agents.findById(environment.agentId);
  if (!agent) return deny("Your agent is no longer part of this repository.");
  const project = await store.projects.findById(agent.projectId);
  if (!project) return deny("This repository is no longer connected.");

  // The fold is cursor-aware (it exists to drain a replay incrementally); a push carries a whole
  // turn at once, so the indices are only positional and `nextStreamIndex` is discarded.
  const indexed: IndexedEveEvent[] = input.events.map((event, i) => ({
    type: event.type,
    data: event.data,
    meta: event.meta,
    streamIndex: i + 1,
  }));
  const fold = foldSessionEvents(indexed, { modelId: input.modelId ?? null });
  const turn = fold.turns.find((t) => t.turnId === input.turnId);
  if (!turn) {
    // The buffer did not actually contain the turn the hook claimed. Nothing to write, and
    // nothing the agent can fix by retrying.
    return { ok: true, recorded: false, reason: "turn-not-in-batch" };
  }

  const metadata: Record<string, unknown> = {
    eveSessionId: input.sessionId,
    eveTrigger: input.channelKind ?? null,
    source: "push",
  };
  if (input.agentName) metadata.eveAgentName = input.agentName;
  if (typeof input.turnSequence === "number") metadata.turnSequence = input.turnSequence;
  if (input.truncated) metadata.truncated = true;

  const ids = {
    projectId: project.id,
    deploymentId: deployment.id,
    releaseId: deployment.releaseId,
    externalRunId: externalRunId(input.sessionId, turn.turnId),
    externalSessionId: input.sessionId,
    userMessage: turn.userMessage,
    channel,
    metadata,
  };

  if (turn.settled) {
    const finishedAt = turn.finishedAt ?? turn.startedAt;
    await deps.recordFinish({
      projectId: ids.projectId,
      deploymentId: ids.deploymentId,
      releaseId: ids.releaseId,
      externalRunId: ids.externalRunId,
      externalSessionId: ids.externalSessionId,
      result: turn.result,
      userMessage: turn.userMessage,
      channel,
      metadata,
      startedAt: turn.startedAt,
      finishedAt,
      wallClockMs: Math.max(0, finishedAt.getTime() - turn.startedAt.getTime()),
    });
    return { ok: true, recorded: true };
  }

  // An in-flight turn becomes a visible `running` row within a second of the agent starting work
  // — the #118 outcome the pull design never delivered. `false` means the deployment gate closed
  // (the deployment is no longer live), which is a legitimate skip, not a failure.
  const started = await deps.recordStart(ids, turn.startedAt);
  return started
    ? { ok: true, recorded: true }
    : { ok: true, recorded: false, reason: "deployment-not-live" };
}
