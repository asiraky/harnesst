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
import { and, eq, isNotNull, like, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  deployments,
  environments,
  runReconcileCursors,
  runs,
} from "~/db/schema";
import type { RawEveEvent } from "~/agent/talk.server";
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
  process.env.EDEN_RECONCILE_BACKFILL_MS || 7 * 24 * 60 * 60 * 1000,
);
/** Sweep interval. */
export const RECONCILE_INTERVAL_MS = Number(
  process.env.EDEN_RECONCILE_INTERVAL_MS || 60_000,
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
 * Read a session's durable stream from `startIndex`, labelling each event with its absolute
 * stream position. Unlike the playground tail reader this does NOT stop at the first
 * waiting/failed marker (a replay carries many turns); it reads until the stream goes idle, ends,
 * or reports `session.completed`, with hard event/time caps as backstops.
 */
async function readSessionEvents(
  baseUrl: string,
  sessionId: string,
  startIndex: number,
): Promise<IndexedEveEvent[]> {
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
  const events: IndexedEveEvent[] = [];
  const deadline = Date.now() + HARD_READ_MS;
  let buf = "";
  let position = 0;
  let stop = false;
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
    while (!stop && events.length < MAX_EVENTS && Date.now() < deadline) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await read();
      } catch (error) {
        if ((error as Error).message === "idle") break;
        throw error;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const event = parseEveLine(raw);
        if (!event) continue;
        position += 1;
        // 1-based labelling matches streamTurn: first event at startIndex gets startIndex+1.
        events.push({ ...event, streamIndex: startIndex + position });
        if (event.type === "session.completed") {
          stop = true;
          break;
        }
        if (events.length >= MAX_EVENTS) break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return events;
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

export interface ReconcileDeps {
  listTargets(): Promise<ReconcileTarget[]>;
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
    async listWorldSessions(worldKey, since) {
      const target = getRuntime().deployTarget;
      if (!target.listWorldSessions) return null;
      return target.listWorldSessions(worldKey, { since });
    },
    readSessionEvents,
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

/** Reconcile every non-http session on one live deployment. Best-effort per session. */
export async function reconcileDeploymentSessions(
  target: ReconcileTarget,
  deps: ReconcileDeps,
): Promise<void> {
  const since = new Date(Date.now() - RECONCILE_BACKFILL_MS);
  const sessions = await deps.listWorldSessions(target.worldKey, since);
  if (!sessions || sessions.length === 0) return;

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
      state: { modelId: fold.modelId },
      lastActivityAt: new Date(session.updatedAt),
    });
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
  console.log(`[reconcile] reconciler started (interval ${RECONCILE_INTERVAL_MS}ms)`);
  return { stop: () => clearInterval(interval) };
}

let running = false;
const globalForReconciler = globalThis as unknown as {
  __edenRunReconciler?: { stop: () => void };
};

/** Start the reconciler once per process; safe to call from any server module. */
export function ensureReconcilerStarted(): void {
  if (process.env.EDEN_DISABLE_RECONCILER === "1") return;
  globalForReconciler.__edenRunReconciler ??= startReconciler();
}
