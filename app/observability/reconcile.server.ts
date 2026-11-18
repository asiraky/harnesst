/**
 * Channel-run reconciler (issue #119) — the pull side of run observability.
 *
 * Only playground/assistant turns are recorded in-process (harnesst drains their eve stream live).
 * Cron (`schedule`), Discord, and other-channel turns fire INSIDE the managed instance and never
 * notify the control plane, so they leave no `runs`/`run_steps` — the observability gap. There is
 * no instance→control-plane step-reporting path and eve is never patched, so this is a PULL:
 * a periodic loop discovers non-`http` sessions on every live managed instance (via the world
 * DB's `workflow.workflow_runs` + eve's `$eve.*` attributes — the sanctioned harnesst-side surface),
 * drains eve's durable replay stream, folds it into per-turn results (session-turns.server.ts),
 * and ingests them through the same `recordTurnStart`/`recordTurnFinish` chokepoint the playground
 * uses. Hung cron turns become visible `status=running` rows — the desired #118 outcome, not a bug.
 *
 * Deps-injectable (like `drainDeployment`): a `ReconcileDeps` interface with a `getRuntime()` +
 * drizzle + real-fetch default factory, so the orchestration unit-tests with fakes and no I/O.
 */
import { and, eq, isNotNull, like, lt, ne, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  deployments,
  environments,
  runReconcileCursors,
  runs,
} from "~/db/schema";
import type { RawEveEvent } from "~/agent/talk.server";
import type { SubagentInvocation } from "~/observability/turn-usage";
import {
  externalRunId,
  recordTurnFinish,
  recordTurnStart,
  type TurnIds,
} from "~/observability/record.server";
import {
  channelForTrigger,
  foldSessionEvents,
  type IndexedEveEvent,
} from "~/observability/session-turns.server";
import { getRuntime } from "~/seams/index.server";
import type { WorldSessionSummary } from "~/seams/types";

/** How far back to look for sessions on each sweep (a session older than this is left alone). */
export const RECONCILE_BACKFILL_MS = Number(
  process.env.HARNESST_RECONCILE_BACKFILL_MS || 7 * 24 * 60 * 60 * 1000,
);
/** Sweep interval. */
export const RECONCILE_INTERVAL_MS = Number(
  process.env.HARNESST_RECONCILE_INTERVAL_MS || 60_000,
);
/** Cap on how many sessions one deployment drains per tick (oldest first) — bounds a big backfill. */
const MAX_SESSIONS_PER_TICK = 25;
/** Discord correlation window: a placeholder within this of a turn's start is a time-match. */
const DISCORD_MATCH_WINDOW_MS = 15 * 60 * 1000;

/* ── stream reading (NDJSON tail) ── */

/** Short pre-headers budget: eve HANGS forever on an unknown session id instead of 404ing. */
const CONNECT_TIMEOUT_MS = 3_000;
/** Idle-read budget: a replay streams fast, then the live tail goes quiet — stop when it does. */
const IDLE_TIMEOUT_MS = 2_000;
/** Backstops so a pathological/huge session can never wedge the sweep. */
const MAX_EVENTS = 10_000;
const HARD_READ_MS = 60_000;

function parseEveLine(raw: string): RawEveEvent | null {
  const line = raw.replace(/^data:\s*/, "").trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      data?: unknown;
      meta?: { at?: string };
    };
    if (typeof parsed.type !== "string") return null;
    return {
      type: parsed.type,
      data:
        parsed.data && typeof parsed.data === "object"
          ? (parsed.data as Record<string, unknown>)
          : {},
      meta: parsed.meta,
    };
  } catch {
    return null;
  }
}

/**
 * Stream a session's durable stream from `startIndex`, handing each event (labelled with its
 * absolute stream position) to `onEvent`; `onEvent` returning true stops the read. Unlike the
 * playground tail reader this does NOT stop at the first waiting/failed marker (a replay carries
 * many turns); it reads until the stream goes idle, ends, or reports `session.completed`, with a
 * hard time cap as a backstop. `complete` is false when the cap or `onEvent` cut the read short,
 * so the caller knows it may not have seen the end.
 */
async function streamSessionEvents(
  baseUrl: string,
  sessionId: string,
  startIndex: number,
  onEvent: (event: IndexedEveEvent) => boolean,
): Promise<{ complete: boolean }> {
  const base = baseUrl.replace(/\/+$/, "");
  const connectController = new AbortController();
  const connectTimer = setTimeout(() => connectController.abort(), CONNECT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `${base}/eve/v1/session/${sessionId}/stream?startIndex=${startIndex}`,
      { signal: connectController.signal },
    );
  } finally {
    clearTimeout(connectTimer);
  }
  if (!res.ok || !res.body) throw new Error(`Eve stream returned ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + HARD_READ_MS;
  let buf = "";
  let position = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const read = async () =>
    Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => reject(new Error("idle")), IDLE_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    });

  try {
    while (Date.now() < deadline) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await read();
      } catch (error) {
        if ((error as Error).message === "idle") return { complete: true };
        throw error;
      }
      if (chunk.done) return { complete: true };
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const event = parseEveLine(raw);
        if (!event) continue;
        position += 1;
        // 1-based labelling matches streamTurn: first event at startIndex gets startIndex+1.
        const indexed = { ...event, streamIndex: startIndex + position };
        if (onEvent(indexed)) return { complete: false };
        if (event.type === "session.completed") return { complete: true };
      }
    }
    return { complete: false };
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Read a session's stream from `startIndex` for the pull, capped at MAX_EVENTS. */
async function readSessionEvents(
  baseUrl: string,
  sessionId: string,
  startIndex: number,
): Promise<IndexedEveEvent[]> {
  const events: IndexedEveEvent[] = [];
  await streamSessionEvents(baseUrl, sessionId, startIndex, (event) => {
    events.push(event);
    return events.length >= MAX_EVENTS;
  });
  return events;
}

/** Caps for the stale-run sweep's read; the same shape as the run hook's own buffer caps. */
const SETTLE_KEEP_HEAD = 200;
const SETTLE_MAX_TAIL_BYTES = 1_000_000;

function eventBytes(event: IndexedEveEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

/**
 * Read a whole session in bounded memory: keep its first SETTLE_KEEP_HEAD events and as many of
 * its last events as fit in SETTLE_MAX_TAIL_BYTES, dropping the middle. That keeps what settling a
 * row needs (the opening message and the outcome) and is what the run hook pushes for a long turn
 * anyway. A long agent turn's stream runs to tens of megabytes; holding it whole is what took the
 * control plane down.
 */
export async function readSessionBounded(
  baseUrl: string,
  sessionId: string,
): Promise<{ events: IndexedEveEvent[]; complete: boolean }> {
  const head: IndexedEveEvent[] = [];
  const tail: { event: IndexedEveEvent; bytes: number }[] = [];
  let tailBytes = 0;
  const { complete } = await streamSessionEvents(baseUrl, sessionId, 0, (event) => {
    if (head.length < SETTLE_KEEP_HEAD) {
      head.push(event);
      return false;
    }
    const bytes = eventBytes(event);
    tail.push({ event, bytes });
    tailBytes += bytes;
    while (tail.length > 1 && tailBytes > SETTLE_MAX_TAIL_BYTES) {
      tailBytes -= tail.shift()!.bytes;
    }
    return false;
  });
  return { events: [...head, ...tail.map((t) => t.event)], complete };
}

/* ── deps ── */

export interface ReconcileTarget {
  deploymentId: string;
  releaseId: string;
  url: string;
  /** The environment id — the world-DB key. */
  worldKey: string;
  projectId: string;
}

export interface ReconcileCursor {
  streamIndex: number;
  state: Record<string, unknown>;
  lastActivityAt: Date | null;
}

export interface DiscordPlaceholder {
  runId: string;
  externalRunId: string;
  /** metadata.input — the slash command's `message` option (may be absent). */
  input: string | null;
  startedAt: Date;
}

/** A `running` row reported by push that may have been left behind by a session eve failed. */
export interface StaleRun {
  runId: string;
  externalRunId: string;
  channel: string;
  metadata: Record<string, unknown>;
  startedAt: Date;
}

export interface ReconcileDeps {
  listTargets(): Promise<ReconcileTarget[]>;
  /** `running` non-http rows on this deployment that started before `startedBefore`, oldest first. */
  listStaleRuns(
    projectId: string,
    deploymentId: string,
    startedBefore: Date,
  ): Promise<StaleRun[]>;
  /** null when the target has no world access (nomad/vercel) — the deployment is then skipped. */
  listWorldSessions(
    worldKey: string,
    since: Date,
  ): Promise<WorldSessionSummary[] | null>;
  readSessionEvents(
    baseUrl: string,
    sessionId: string,
    startIndex: number,
  ): Promise<IndexedEveEvent[]>;
  /** A whole session with its middle dropped; `complete` is false if the read was cut short. */
  readSessionBounded(
    baseUrl: string,
    sessionId: string,
  ): Promise<{ events: IndexedEveEvent[]; complete: boolean }>;
  getCursor(
    projectId: string,
    externalSessionId: string,
  ): Promise<ReconcileCursor | null>;
  saveCursor(
    projectId: string,
    externalSessionId: string,
    cursor: ReconcileCursor,
  ): Promise<void>;
  listDiscordPlaceholders(
    projectId: string,
    deploymentId: string,
  ): Promise<DiscordPlaceholder[]>;
  recordStart(ids: TurnIds, startedAt: Date): Promise<boolean>;
  recordFinish(input: Parameters<typeof recordTurnFinish>[0]): Promise<void>;
}

/** Default deps over the real runtime: drizzle for discovery/cursors, eve HTTP for streams. */
export function reconcileDeps(): ReconcileDeps {
  return {
    async listTargets() {
      const rows = await db
        .select({
          deploymentId: deployments.id,
          releaseId: deployments.releaseId,
          url: deployments.url,
          worldKey: deployments.environmentId,
          projectId: environments.projectId,
        })
        .from(deployments)
        .innerJoin(environments, eq(deployments.environmentId, environments.id))
        .where(and(eq(deployments.status, "live"), isNotNull(deployments.url)));
      return rows
        .filter((r): r is typeof r & { url: string } => !!r.url)
        .map((r) => ({
          deploymentId: r.deploymentId,
          releaseId: r.releaseId,
          url: r.url,
          worldKey: r.worldKey,
          projectId: r.projectId,
        }));
    },
    async listStaleRuns(projectId, deploymentId, startedBefore) {
      const rows = await db
        .select({
          runId: runs.id,
          externalRunId: runs.externalRunId,
          channel: runs.channel,
          metadata: runs.metadata,
          startedAt: runs.startedAt,
        })
        .from(runs)
        .where(
          and(
            eq(runs.projectId, projectId),
            eq(runs.deploymentId, deploymentId),
            eq(runs.status, "running"),
            isNotNull(runs.externalRunId),
            ne(runs.channel, "http"),
            lt(runs.startedAt, startedBefore),
          ),
        )
        .orderBy(runs.startedAt);
      return rows
        .filter(
          (r): r is typeof r & { externalRunId: string; channel: string } =>
            !!r.externalRunId && !!r.channel,
        )
        .map((r) => ({
          runId: r.runId,
          externalRunId: r.externalRunId,
          channel: r.channel,
          metadata: (r.metadata as Record<string, unknown> | null) ?? {},
          startedAt: r.startedAt,
        }));
    },
    async listWorldSessions(worldKey, since) {
      const target = getRuntime().deployTarget;
      if (!target.listWorldSessions) return null;
      return target.listWorldSessions(worldKey, { since });
    },
    readSessionEvents,
    readSessionBounded,
    async getCursor(projectId, externalSessionId) {
      const [row] = await db
        .select()
        .from(runReconcileCursors)
        .where(
          and(
            eq(runReconcileCursors.projectId, projectId),
            eq(runReconcileCursors.externalSessionId, externalSessionId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        streamIndex: row.streamIndex,
        state: row.state ?? {},
        lastActivityAt: row.lastActivityAt,
      };
    },
    async saveCursor(projectId, externalSessionId, cursor) {
      await db
        .insert(runReconcileCursors)
        .values({
          projectId,
          externalSessionId,
          streamIndex: cursor.streamIndex,
          state: cursor.state,
          lastActivityAt: cursor.lastActivityAt,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            runReconcileCursors.projectId,
            runReconcileCursors.externalSessionId,
          ],
          set: {
            streamIndex: cursor.streamIndex,
            state: cursor.state,
            lastActivityAt: cursor.lastActivityAt,
            updatedAt: new Date(),
          },
        });
    },
    async listDiscordPlaceholders(projectId, deploymentId) {
      const rows = await db
        .select({
          runId: runs.id,
          externalRunId: runs.externalRunId,
          metadata: runs.metadata,
          startedAt: runs.startedAt,
        })
        .from(runs)
        .where(
          and(
            eq(runs.projectId, projectId),
            eq(runs.deploymentId, deploymentId),
            eq(runs.channel, "discord"),
            eq(runs.status, "running"),
            like(runs.externalRunId, "discord:%"),
          ),
        );
      return rows
        .filter((r): r is typeof r & { externalRunId: string } => !!r.externalRunId)
        .map((r) => {
          const input = (r.metadata as Record<string, unknown> | null)?.input;
          return {
            runId: r.runId,
            externalRunId: r.externalRunId,
            input: typeof input === "string" ? input : null,
            startedAt: r.startedAt,
          };
        });
    },
    recordStart: (ids, startedAt) => recordTurnStart(ids, startedAt),
    recordFinish: (input) => recordTurnFinish(input),
  };
}

/* ── discord correlation ── */

/**
 * Claim the placeholder `running` row a Discord command left behind (relay.server.ts records one
 * per interaction, keyed `discord:<interactionId>` — eve's session id never reaches the relay, so
 * correlation is by message text + time). Prefer an exact `message` match, else the nearest start
 * within the window. Each placeholder is claimed at most once per tick.
 */
function claimDiscordPlaceholder(
  placeholders: DiscordPlaceholder[],
  claimed: Set<string>,
  userMessage: string | null,
  startedAt: Date,
): DiscordPlaceholder | null {
  const available = placeholders.filter((p) => !claimed.has(p.runId));
  if (available.length === 0) return null;

  const trimmed = userMessage?.trim() ?? null;
  if (trimmed) {
    const exact = available.find((p) => (p.input?.trim() ?? null) === trimmed);
    if (exact) {
      claimed.add(exact.runId);
      return exact;
    }
  }

  let best: DiscordPlaceholder | null = null;
  let bestDelta = Infinity;
  for (const p of available) {
    const delta = Math.abs(p.startedAt.getTime() - startedAt.getTime());
    if (delta <= DISCORD_MATCH_WINDOW_MS && delta < bestDelta) {
      best = p;
      bestDelta = delta;
    }
  }
  if (best) claimed.add(best.runId);
  return best;
}

/* ── the sweep ── */

/**
 * Deployments already warned about an empty/absent world. The sweep runs every 60s forever, so an
 * unconditional warn here would emit ~1,440 identical lines a day per deployment — which an
 * operator learns to filter, making it exactly as useful as the silence it replaced.
 */
const warnedDeployments = new Set<string>();

function warnOnce(deploymentId: string, message: string): void {
  if (warnedDeployments.has(deploymentId)) return;
  warnedDeployments.add(deploymentId);
  console.warn(message);
}

/** Test seam: forget which deployments have already warned. */
export function resetReconcileWarnings(): void {
  warnedDeployments.clear();
}

/** Reconcile every non-http session on one live deployment. Best-effort per session. */
export async function reconcileDeploymentSessions(
  target: ReconcileTarget,
  deps: ReconcileDeps,
): Promise<void> {
  const since = new Date(Date.now() - RECONCILE_BACKFILL_MS);
  const sessions = await deps.listWorldSessions(target.worldKey, since);
  if (!sessions || sessions.length === 0) {
    // This return used to be silent, and it is where every production tick has died: the world
    // databases are empty (deployed eve has no Postgres workflow backend) and three of four
    // deploy targets do not implement `listWorldSessions` at all. Distinguish the two — "this
    // target exposes no world" is a permanent architectural fact, "the world is empty" is a
    // maybe-transient one — and say it ONCE per deployment, not once per 60s tick.
    warnOnce(
      target.deploymentId,
      sessions === null
        ? `[reconcile] deployment ${target.deploymentId}: the active deploy target exposes no ` +
            "world-session listing, so pull-based run discovery can never see this deployment. " +
            "Runs are reported by push instead (the agent's baked run hook → POST /api/agent/runs)."
        : `[reconcile] deployment ${target.deploymentId}: world "${target.worldKey}" reports no ` +
            "sessions. If this deployment has actually run work, its world DB is not being " +
            "written (see the [worlds] warning) and runs arrive by push instead.",
    );
    return;
  }

  // Resolve each session's channel + cursor and drop http (already recorded) and no-activity ones.
  const pending: {
    session: WorldSessionSummary;
    channel: string;
    cursor: ReconcileCursor | null;
  }[] = [];
  for (const session of sessions) {
    const channel = channelForTrigger(session.trigger ?? "");
    if (!channel) continue;
    const cursor = await deps.getCursor(target.projectId, session.sessionId);
    if (
      cursor?.lastActivityAt &&
      new Date(session.updatedAt) <= cursor.lastActivityAt
    ) {
      continue; // no new activity since last drain
    }
    pending.push({ session, channel, cursor });
  }

  pending.sort(
    (a, b) =>
      Date.parse(a.session.createdAt) - Date.parse(b.session.createdAt),
  );

  // Discord placeholders are shared across this deployment's sessions for one tick.
  const claimedPlaceholders = new Set<string>();
  let discordPlaceholders: DiscordPlaceholder[] | null = null;
  const placeholdersFor = async (): Promise<DiscordPlaceholder[]> => {
    if (discordPlaceholders === null) {
      discordPlaceholders = await deps.listDiscordPlaceholders(
        target.projectId,
        target.deploymentId,
      );
    }
    return discordPlaceholders;
  };

  for (const { session, channel, cursor } of pending.slice(
    0,
    MAX_SESSIONS_PER_TICK,
  )) {
    const startIndex = cursor?.streamIndex ?? 0;
    const events = await deps.readSessionEvents(
      target.url,
      session.sessionId,
      startIndex,
    );
    if (events.length === 0) {
      // Nothing new to fold; just record that we looked, so the no-activity gate can short-circuit.
      await deps.saveCursor(target.projectId, session.sessionId, {
        streamIndex: startIndex,
        state: cursor?.state ?? {},
        lastActivityAt: new Date(session.updatedAt),
      });
      continue;
    }

    const fold = foldSessionEvents(events, {
      modelId: (cursor?.state?.modelId as string | undefined) ?? null,
      subagent: (cursor?.state?.subagent as SubagentInvocation | undefined) ?? null,
    });
    const firstDrain = cursor === null;

    for (let i = 0; i < fold.turns.length; i += 1) {
      const turn = fold.turns[i];
      let extRunId = externalRunId(session.sessionId, turn.turnId);

      // Discord: the session's first turn on its first drain may correspond to a placeholder
      // `running` row the relay recorded — settle THAT row in place (preserving its Discord
      // metadata) rather than creating a parallel run.
      if (channel === "discord" && firstDrain && i === 0) {
        const claim = claimDiscordPlaceholder(
          await placeholdersFor(),
          claimedPlaceholders,
          turn.userMessage,
          turn.startedAt,
        );
        if (claim) extRunId = claim.externalRunId;
      }

      const ids: TurnIds = {
        projectId: target.projectId,
        deploymentId: target.deploymentId,
        releaseId: target.releaseId,
        externalRunId: extRunId,
        externalSessionId: session.sessionId,
        userMessage: turn.userMessage,
        channel,
        metadata: { eveSessionId: session.sessionId, eveTrigger: session.trigger },
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
          metadata: ids.metadata,
          startedAt: turn.startedAt,
          finishedAt,
          wallClockMs: Math.max(
            0,
            finishedAt.getTime() - turn.startedAt.getTime(),
          ),
        });
      } else {
        // A visible `running` row — the #118 win. `false` means the deployment gate closed; skip.
        await deps.recordStart(ids, turn.startedAt);
      }
    }

    await deps.saveCursor(target.projectId, session.sessionId, {
      // Never move the cursor backwards (a partial re-read must not lose settled progress).
      streamIndex: Math.max(startIndex, fold.nextStreamIndex),
      state: { modelId: fold.modelId, subagent: fold.subagent },
      lastActivityAt: new Date(session.updatedAt),
    });
  }
}

/* ── settling runs eve failed without telling the run hook ── */

/** A pushed `running` row younger than this is left to the hook. */
export const STALE_RUN_AFTER_MS = 10 * 60 * 1000;
/** How often one stale row's session is re-read while it stays unsettled. */
export const STALE_RUN_RECHECK_MS = 10 * 60 * 1000;
/** A turn whose stream has been silent this long is not coming back. */
export const ABANDONED_TURN_MS = 6 * 60 * 60 * 1000;
/** A row whose session cannot be read at all is given up on after this long. */
export const UNREADABLE_SESSION_MS = 24 * 60 * 60 * 1000;
/** Bounds the stream reads one deployment does per tick. */
const MAX_STALE_CHECKS_PER_TICK = 5;

/** runId -> when its session was last read. Process-local; a restart just re-reads once. */
const staleChecks = new Map<string, number>();

export function resetStaleRunChecks(): void {
  staleChecks.clear();
}

function splitExternalRunId(id: string): { sessionId: string; turnId: string } | null {
  const at = id.lastIndexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  return { sessionId: id.slice(0, at), turnId: id.slice(at + 1) };
}

/** Latest event time in a stream, or `fallback` when none carries one. */
function lastEventAt(events: IndexedEveEvent[], fallback: number): number {
  let latest = fallback;
  for (const e of events) {
    const at = e.meta?.at ? Date.parse(e.meta.at) : NaN;
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}

/** Why an unsettled row should be failed now, or null to leave it and look again later. */
function giveUpReason(
  run: StaleRun,
  events: IndexedEveEvent[] | null,
  hasTurn: boolean,
  now: number,
): string | null {
  const age = now - run.startedAt.getTime();
  if (events === null) {
    return age >= UNREADABLE_SESSION_MS
      ? "harnesst could not read this session from the agent for a day, so it marked the turn failed."
      : null;
  }
  if (!hasTurn) {
    return age >= UNREADABLE_SESSION_MS
      ? "The agent has no record of this turn, so harnesst marked it failed."
      : null;
  }
  return now - lastEventAt(events, run.startedAt.getTime()) >= ABANDONED_TURN_MS
    ? "The turn reported nothing for 6 hours (the agent probably restarted mid-turn), so harnesst marked it failed."
    : null;
}

/** The stream (or a stand-in opening when it has no turn) with a `turn.failed` appended. */
function withFailure(
  run: StaleRun,
  turnId: string,
  events: IndexedEveEvent[] | null,
  hasTurn: boolean,
  reason: string,
  now: number,
): IndexedEveEvent[] {
  const base: IndexedEveEvent[] =
    hasTurn && events
      ? events
      : [
          {
            type: "message.received",
            data: { turnId, message: String(run.metadata.input ?? "") },
            meta: { at: run.startedAt.toISOString() },
            streamIndex: 1,
          },
        ];
  const failedAt = hasTurn && events ? lastEventAt(events, run.startedAt.getTime()) : now;
  return [
    ...base,
    {
      type: "turn.failed",
      data: { turnId, message: reason },
      meta: { at: new Date(failedAt).toISOString() },
      streamIndex: base.length + 1,
    },
  ];
}

/**
 * Settle `running` rows the run hook can never settle.
 *
 * When eve's session workflow throws (a model call that fails after its retries, say), eve runs
 * `emitTerminalSessionFailureStep`. That step tells the channel adapter and writes
 * `session.failed` to the session's durable stream, but it does not dispatch stream-event hooks,
 * so the run hook never sees the failure and the row stays `running` forever. The stream does
 * have it, so read the stream, fold it, and settle the row from what it says.
 *
 * Two more cases end the same way. A stream that holds the turn but has been silent for
 * ABANDONED_TURN_MS means the process died mid-turn (a container restart, say). A session that
 * cannot be read at all for UNREADABLE_SESSION_MS is gone. Both settle as failed with a message
 * that says so. Anything else (a live turn, a read error on a young row, a read that hit the event
 * cap) is left alone and checked again later.
 */
export async function settleStaleRuns(
  target: ReconcileTarget,
  deps: ReconcileDeps,
  now: number = Date.now(),
): Promise<void> {
  const stale = await deps.listStaleRuns(
    target.projectId,
    target.deploymentId,
    new Date(now - STALE_RUN_AFTER_MS),
  );
  let checked = 0;
  for (const run of stale) {
    if (checked >= MAX_STALE_CHECKS_PER_TICK) break;
    const last = staleChecks.get(run.runId);
    if (last !== undefined && now - last < STALE_RUN_RECHECK_MS) continue;
    const ids = splitExternalRunId(run.externalRunId);
    if (!ids) continue;
    checked += 1;
    staleChecks.set(run.runId, now);

    let events: IndexedEveEvent[] | null;
    try {
      const read = await deps.readSessionBounded(target.url, ids.sessionId);
      // Cut short: the read may have stopped before the turn's end (and before its latest event,
      // which the abandon check relies on), so don't guess.
      if (!read.complete) continue;
      events = read.events;
    } catch {
      events = null;
    }

    let turn = events
      ? foldSessionEvents(events).turns.find((t) => t.turnId === ids.turnId)
      : undefined;
    if (!turn?.settled) {
      const reason = giveUpReason(run, events, turn !== undefined, now);
      if (!reason) continue;
      turn = foldSessionEvents(
        withFailure(run, ids.turnId, events, turn !== undefined, reason, now),
      ).turns.find((t) => t.turnId === ids.turnId);
      if (!turn?.settled) continue;
    }

    const finishedAt = turn.finishedAt ?? turn.startedAt;
    await deps.recordFinish({
      projectId: target.projectId,
      deploymentId: target.deploymentId,
      releaseId: target.releaseId,
      externalRunId: run.externalRunId,
      externalSessionId: ids.sessionId,
      result: turn.result,
      userMessage: turn.userMessage,
      channel: run.channel,
      metadata: { ...run.metadata, settledBy: "stale-run-sweep" },
      startedAt: run.startedAt,
      finishedAt,
      wallClockMs: Math.max(0, finishedAt.getTime() - run.startedAt.getTime()),
    });
    staleChecks.delete(run.runId);
  }
}

/** One sweep across every live managed deployment. A bad instance warns and is skipped. */
export async function reconcileTick(
  deps: ReconcileDeps = reconcileDeps(),
): Promise<void> {
  let targets: ReconcileTarget[];
  try {
    targets = await deps.listTargets();
  } catch (error) {
    console.warn("[reconcile] failed to list targets", error);
    return;
  }
  for (const target of targets) {
    try {
      await reconcileDeploymentSessions(target, deps);
    } catch (error) {
      console.warn(
        `[reconcile] deployment ${target.deploymentId} sweep failed`,
        error,
      );
    }
    try {
      await settleStaleRuns(target, deps);
    } catch (error) {
      console.warn(
        `[reconcile] deployment ${target.deploymentId} stale-run sweep failed`,
        error,
      );
    }
  }
}

/* ── background loop (mirrors ensureWorkerStarted) ── */

function startReconciler(): { stop: () => void } {
  const interval = setInterval(async () => {
    if (running) return; // don't stack sweeps
    running = true;
    try {
      await reconcileTick();
    } catch (error) {
      console.warn("[reconcile] tick failed", error);
    } finally {
      running = false;
    }
  }, RECONCILE_INTERVAL_MS);
  interval.unref?.();
  // Run one sweep immediately so a fresh boot doesn't wait a full interval for the first records.
  void (async () => {
    running = true;
    try {
      await reconcileTick();
    } catch (error) {
      console.warn("[reconcile] initial tick failed", error);
    } finally {
      running = false;
    }
  })();
  // Name the deploy target and whether it can actually answer, so the one unconditional line the
  // subsystem emits tells an operator up front whether the pull is even wired — three of four
  // targets implement no `listWorldSessions`, and that used to be invisible.
  let targetName = "unknown";
  let canList = false;
  try {
    const target = getRuntime().deployTarget;
    targetName = target.name ?? "unknown";
    canList = typeof target.listWorldSessions === "function";
  } catch {
    // Runtime not resolvable at boot (tests, partial env) — the interval still starts.
  }
  console.log(
    `[reconcile] reconciler started (interval ${RECONCILE_INTERVAL_MS}ms, ` +
      `target ${targetName}, world-session listing ${canList ? "available" : "UNAVAILABLE — " +
        "pull-based run discovery is inoperative on this target; runs arrive by push"})`,
  );
  return { stop: () => clearInterval(interval) };
}

let running = false;
const globalForReconciler = globalThis as unknown as {
  __harnesstRunReconciler?: { stop: () => void };
};

/** Start the reconciler once per process; safe to call from any server module. */
export function ensureReconcilerStarted(): void {
  if (process.env.HARNESST_DISABLE_RECONCILER === "1") return;
  globalForReconciler.__harnesstRunReconciler ??= startReconciler();
}
