import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  max,
  min,
  ne,
  or,
} from "drizzle-orm";

import { inputRequestsOf, type RawEveEvent } from "~/agent/talk.server";
import { normalizeTurnError } from "~/chat/stream-error";
import type { ChatEntry, ChatInputRequest, ChatStep } from "~/chat/types";
import { db } from "~/db/client.server";
import {
  conversationReads,
  playgroundEvents,
  playgroundSessions,
  type SessionResumeVia,
} from "~/db/schema";
import { channelLabelFor } from "~/foh/channel-resume";
import { openInboxQuestion, resolveInboxForSession } from "~/foh/inbox.server";
import { reconcileNeedsYouFromTail } from "~/foh/needs-you";
import { fohSessionStatus, sortSessionsForList } from "~/foh/status";
import type { FohSessionStatus } from "~/foh/status";
import {
  parseModelDirective,
  runtimeModelBase,
  stripModelDirective,
} from "~/models/model-directive";
import { stripSeedContext } from "~/playground/seed";
import { stripChannelContext } from "~/chat/channel-context";
import type { Target } from "~/chat/playground.server";
import type { ReasoningEffort } from "~/models/reasoning";

export type PlaygroundSession = typeof playgroundSessions.$inferSelect;

/** Which chat surface a query serves; determines the discriminator scope (D1). */
export type SessionSurface = "playground" | "assistant" | "foh";

/**
 * Exact-match surface isolation: every query sees only rows stamped with its own surface —
 * `foh` / `playground` / `assistant` are three disjoint conversation spaces (issue #221 PRD
 * gap 2). Historically the builder surfaces read `surface <> 'foh'` because migration 0015
 * stamped every pre-existing row 'playground' (its column default), including genuine
 * assistant conversations. Migration 0018 backfilled those — rows on kind-'assistant' agents
 * flipped to surface 'assistant' — so exact equality is now safe for all three surfaces.
 */
function surfaceScope(surface: SessionSurface) {
  return eq(playgroundSessions.surface, surface);
}

export interface PlaygroundSessionSummary {
  id: string;
  title: string;
  status: string;
  environmentId: string | null;
  /** Per-conversation model override; null = the deployed default model. */
  modelId: string | null;
  effort: ReasoningEffort | null;
  updatedAt: string;
  surface: string;
  pendingInputAt: string | null;
  /** D4 presentation status (working / needs_you / done / error). */
  fohStatus: FohSessionStatus;
  /** D3 unread flag; present only when the caller computed it for a viewer. */
  unread?: boolean;
}

export function summarizePlaygroundSession(
  session: PlaygroundSession,
  opts?: { unread?: boolean },
): PlaygroundSessionSummary {
  return {
    id: session.id,
    title: session.title ?? "New conversation",
    status: session.status,
    environmentId: session.environmentId,
    modelId: session.modelId,
    effort: session.effort as ReasoningEffort | null,
    updatedAt: session.updatedAt.toISOString(),
    surface: session.surface,
    pendingInputAt: session.pendingInputAt?.toISOString() ?? null,
    fohStatus: fohSessionStatus(session),
    ...(opts?.unread !== undefined ? { unread: opts.unread } : {}),
  };
}

export async function listPlaygroundSessions(input: {
  projectId: string;
  agentId: string;
  userId: string;
  surface?: SessionSurface;
}): Promise<PlaygroundSession[]> {
  return db
    .select()
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.agentId, input.agentId),
        eq(playgroundSessions.createdBy, input.userId),
        surfaceScope(input.surface ?? "playground"),
      ),
    )
    .orderBy(
      desc(playgroundSessions.updatedAt),
      desc(playgroundSessions.createdAt),
    );
}

export async function getPlaygroundSession(input: {
  id: string;
  projectId: string;
  agentId: string;
  userId: string;
  surface?: SessionSurface;
}): Promise<PlaygroundSession | null> {
  const [row] = await db
    .select()
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.agentId, input.agentId),
        eq(playgroundSessions.createdBy, input.userId),
        surfaceScope(input.surface ?? "playground"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * FOH middle-pane list (§6 roles): members see their own sessions plus agent-opened ones
 * (`created_by IS NULL`); admins/owners (`includeAll`) see every FOH session for the agent.
 * Rows carry the viewer's unread flag (D3) and come back needs-you first.
 */
export async function listFohSessionsForAgent(input: {
  projectId: string;
  agentId: string;
  viewerId: string;
  includeAll?: boolean;
}): Promise<Array<PlaygroundSession & { unread: boolean }>> {
  const rows = await db
    .select({
      session: playgroundSessions,
      lastReadAt: conversationReads.lastReadAt,
    })
    .from(playgroundSessions)
    .leftJoin(
      conversationReads,
      and(
        eq(conversationReads.sessionId, playgroundSessions.id),
        eq(conversationReads.userId, input.viewerId),
      ),
    )
    .where(
      and(
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.agentId, input.agentId),
        surfaceScope("foh"),
        input.includeAll
          ? undefined
          : or(
              eq(playgroundSessions.createdBy, input.viewerId),
              isNull(playgroundSessions.createdBy),
            ),
      ),
    );
  return sortSessionsForList(
    rows.map((row) => ({
      ...row.session,
      unread:
        row.session.lastEventAt != null &&
        (row.lastReadAt == null || row.session.lastEventAt > row.lastReadAt),
    })),
  );
}

/**
 * One FOH session under the viewer's scope — the same visibility rule as
 * `listFohSessionsForAgent` (members: own + agent-opened rows; admins/owners: all). The FOH
 * session view, stream, and stop routes all resolve their row through this.
 */
export async function getFohSessionForViewer(input: {
  id: string;
  projectId: string;
  /** Constrain to one agent (session view); omit where the route only knows the session. */
  agentId?: string;
  viewerId: string;
  includeAll?: boolean;
}): Promise<PlaygroundSession | null> {
  const [row] = await db
    .select()
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        eq(playgroundSessions.projectId, input.projectId),
        input.agentId ? eq(playgroundSessions.agentId, input.agentId) : undefined,
        surfaceScope("foh"),
        input.includeAll
          ? undefined
          : or(
              eq(playgroundSessions.createdBy, input.viewerId),
              isNull(playgroundSessions.createdBy),
            ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** FOH sessions by id — inbox flyout enrichment (titles + jump targets). FOH-scoped only. */
export async function listFohSessionsByIds(
  ids: string[],
): Promise<PlaygroundSession[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(playgroundSessions)
    .where(and(inArray(playgroundSessions.id, ids), surfaceScope("foh")));
}

/**
 * Which of the given agents have a FRESH `running` session on any surface — the active-turn
 * half of FOH presence. Freshness matters because a stale `running` row (drain died with the
 * process) would otherwise show a phantom active turn forever; the drain bumps `updatedAt`
 * about every second, so anything older than `staleMs` is not a live turn.
 */
export async function listAgentsWithFreshRunningSessions(
  agentIds: string[],
  staleMs: number,
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const cutoff = new Date(Date.now() - staleMs);
  const rows = await db
    .selectDistinct({ agentId: playgroundSessions.agentId })
    .from(playgroundSessions)
    .where(
      and(
        inArray(playgroundSessions.agentId, agentIds),
        eq(playgroundSessions.status, "running"),
        gt(playgroundSessions.updatedAt, cutoff),
      ),
    );
  return new Set(rows.map((row) => row.agentId));
}

export async function createPlaygroundSession(input: {
  projectId: string;
  agentId: string;
  /** Null for agent-opened sessions (D6) — pair with openedByAgentId. */
  userId: string | null;
  surface?: SessionSurface;
  environmentId?: string | null;
  deploymentId?: string | null;
  releaseId?: string | null;
  version?: string | null;
  title?: string | null;
  modelId?: string | null;
  effort?: ReasoningEffort | null;
  openedByAgentId?: string | null;
  delegationId?: string | null;
  /**
   * Relay parking (D6/D8): an agent-opened row adopts the parked peer's LIVE eve session at
   * creation — real handles, so the ordinary FOH continuation send resumes the peer. Human-
   * opened sessions never pass these (a fresh eve session is seeded by the first turn).
   */
  externalSessionId?: string | null;
  continuationToken?: string | null;
  /**
   * Channel-homed resume descriptor (see `SessionResumeVia`): set only when eve homed this
   * session on a channel, so the answer path must deliver through that channel's route.
   */
  resumeVia?: SessionResumeVia | null;
  streamIndex?: number;
  status?: "running" | "waiting" | "completed" | "failed";
  pendingInputAt?: Date | null;
  lastEventAt?: Date | null;
}): Promise<PlaygroundSession> {
  const [row] = await db
    .insert(playgroundSessions)
    .values({
      projectId: input.projectId,
      agentId: input.agentId,
      createdBy: input.userId,
      surface: input.surface ?? "playground",
      environmentId: input.environmentId ?? null,
      worldKey: input.environmentId ?? null,
      lastDeploymentId: input.deploymentId ?? null,
      lastReleaseId: input.releaseId ?? null,
      lastVersion: input.version ?? null,
      title: input.title ?? null,
      modelId: input.modelId ?? null,
      effort: input.effort ?? null,
      openedByAgentId: input.openedByAgentId ?? null,
      delegationId: input.delegationId ?? null,
      externalSessionId: input.externalSessionId ?? null,
      continuationToken: input.continuationToken ?? null,
      resumeVia: input.resumeVia ?? null,
      streamIndex: input.streamIndex ?? 0,
      status: input.status ?? "new",
      pendingInputAt: input.pendingInputAt ?? null,
      lastEventAt: input.lastEventAt ?? null,
    })
    .returning();
  return row;
}

/**
 * Outcome of `adoptChannelHomedSession`.
 *
 * `parkDeferred` is not a failure: the row exists and its resume handles are current, but a LIVE
 * FOH turn holds the session's claim, so the park did NOT flip `status`/`pendingInputAt` under
 * the claim holder. That is the legitimate interleaving — a human answers in FOH, the agent asks
 * a follow-up mid-turn, and the container parks while the drain is still streaming — and the
 * drain's own needs-you chokepoint marks the park a moment later from inside the turn it owns.
 */
export type AdoptChannelHomedSessionResult =
  | { ok: true; session: PlaygroundSession; parkDeferred: boolean }
  | { ok: false; reason: "session_not_owned" };

/**
 * Create-or-adopt the FOH session that fronts a CHANNEL-HOMED eve session (WS1 GitHub park).
 * Keyed on the `(project_id, external_session_id)` unique index, so a second question on the same
 * eve session — a multi-turn GitHub thread parks repeatedly — refreshes the row's resume
 * descriptor and park marks instead of opening a duplicate conversation. That upsert IS the park
 * endpoint's idempotency for the session half (inbox items carry their own, per requestId).
 *
 * `createdBy: null` is deliberate: nobody in harnesst started this work (a GitHub user did), and
 * the FOH visibility rule (`created_by = viewer OR created_by IS NULL`) makes null rows
 * team-wide — exactly right for a question anyone on the team may answer.
 *
 * Never clobbers on conflict: `title`/`streamIndex` keep their stored value when the caller
 * passes nothing, so adopting can't blank a title the drain already computed.
 *
 * TWO guards the caller cannot supply itself, because both are races the writer must lose:
 *
 *  - OWNERSHIP. The caller is a deployed container holding a delegation token, which proves which
 *    DEPLOYMENT is calling and nothing about the eve session named in its body. Any container in
 *    the project could otherwise name another agent's live `external_session_id` and overwrite
 *    its resume handles, redirecting that session's next human answer to an issue thread of the
 *    caller's choosing (`resumeVia.state` round-trips verbatim into `send()`). The `agent_id`
 *    predicate in `setWhere` makes the write land on nothing, and the read-back below turns that
 *    into an explicit refusal rather than a silent 200.
 *  - TURN FENCING. Every other writer of `status`/`pendingInputAt` goes through
 *    `claimPlaygroundSessionForTurn`. A park landing inside a live turn must not flip
 *    `running` → `waiting` under the claim holder, so the fenced upsert skips and the narrow
 *    fallback below refreshes ONLY the resume handles (which no turn owns).
 */
export async function adoptChannelHomedSession(input: {
  projectId: string;
  agentId: string;
  environmentId: string | null;
  deploymentId: string | null;
  releaseId: string | null;
  version: string | null;
  /** The eve session id the channel homed the work on. */
  externalSessionId: string;
  /** Namespaced token exactly as eve reported it — `resumeVia.rawToken` holds the stripped form. */
  continuationToken: string;
  resumeVia: SessionResumeVia;
  title?: string | null;
  streamIndex?: number | null;
  /** Claim staleness cutoff; callers pass TURN_IDLE_TIMEOUT_MS, as the turn claim does. */
  staleAfterMs: number;
  now: Date;
}): Promise<AdoptChannelHomedSessionResult> {
  const staleBefore = new Date(input.now.getTime() - input.staleAfterMs);
  const [row] = await db
    .insert(playgroundSessions)
    .values({
      projectId: input.projectId,
      agentId: input.agentId,
      createdBy: null,
      surface: "foh",
      environmentId: input.environmentId,
      worldKey: input.environmentId,
      lastDeploymentId: input.deploymentId,
      lastReleaseId: input.releaseId,
      lastVersion: input.version,
      title: input.title ?? null,
      externalSessionId: input.externalSessionId,
      continuationToken: input.continuationToken,
      resumeVia: input.resumeVia,
      streamIndex: input.streamIndex ?? 0,
      status: "waiting",
      pendingInputAt: input.now,
      lastEventAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        playgroundSessions.projectId,
        playgroundSessions.externalSessionId,
      ],
      set: {
        continuationToken: input.continuationToken,
        resumeVia: input.resumeVia,
        lastDeploymentId: input.deploymentId,
        lastReleaseId: input.releaseId,
        lastVersion: input.version,
        status: "waiting",
        pendingInputAt: input.now,
        lastEventAt: input.now,
        updatedAt: input.now,
        ...(input.title ? { title: input.title } : {}),
      },
      setWhere: and(
        eq(playgroundSessions.agentId, input.agentId),
        or(
          ne(playgroundSessions.status, "running"),
          lt(playgroundSessions.updatedAt, staleBefore),
        ),
      ),
    })
    .returning();
  if (row) return { ok: true, session: row, parkDeferred: false };

  // The upsert wrote nothing. Read the row back to say WHY — the two reasons need opposite
  // answers, and guessing either way is a bug (a silent 200 on a hijack, or a lost park).
  const [existing] = await db
    .select()
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.externalSessionId, input.externalSessionId),
      ),
    )
    .limit(1);
  if (!existing || existing.agentId !== input.agentId) {
    return { ok: false, reason: "session_not_owned" };
  }

  // A live turn holds the claim. Refresh only what the turn does not own — the resume handles —
  // and leave `status`/`pendingInputAt`/`turn_claim_id` to the claim holder.
  const [refreshed] = await db
    .update(playgroundSessions)
    .set({
      continuationToken: input.continuationToken,
      resumeVia: input.resumeVia,
    })
    .where(eq(playgroundSessions.id, existing.id))
    .returning();
  return { ok: true, session: refreshed ?? existing, parkDeferred: true };
}

/** Persist the conversation's model override (tenancy-guarded like getPlaygroundSession). */
export async function setPlaygroundSessionModel(input: {
  id: string;
  projectId: string;
  agentId: string;
  userId: string;
  modelId: string | null;
  effort?: ReasoningEffort | null;
  surface?: SessionSurface;
}): Promise<boolean> {
  const updated = await db
    .update(playgroundSessions)
    .set({
      modelId: input.modelId,
      effort: input.effort,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.agentId, input.agentId),
        eq(playgroundSessions.createdBy, input.userId),
        surfaceScope(input.surface ?? "playground"),
      ),
    )
    .returning({ id: playgroundSessions.id });
  return updated.length > 0;
}

/**
 * Park the session on a human question (needs-you, D4). Written only at the drain/reconcile/
 * relay chokepoints. Guarded `status <> 'stopped'`: a deliberately stopped session must not be
 * resurrected into the inbox by a late drain write. Returns whether the park claim WON (a row
 * was updated) — callers must skip their inbox inserts on false, or a stop that raced the park
 * would still file items for a stopped session (issue #221 finding 4).
 */
export async function markSessionPendingInput(
  sessionId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(playgroundSessions)
    .set({ pendingInputAt: at, updatedAt: new Date() })
    .where(
      and(
        eq(playgroundSessions.id, sessionId),
        ne(playgroundSessions.status, "stopped"),
      ),
    )
    .returning({ id: playgroundSessions.id });
  return updated.length > 0;
}

/** Clear the needs-you park (turn completed/failed, or a continuation send superseded it). */
export async function clearSessionPendingInput(
  sessionId: string,
): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({ pendingInputAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(playgroundSessions.id, sessionId),
        ne(playgroundSessions.status, "stopped"),
      ),
    );
}

export async function markPlaygroundSessionRunning(input: {
  id: string;
  target: Target;
  title?: string | null;
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      environmentId: input.target.environmentId,
      worldKey: input.target.environmentId,
      lastDeploymentId: input.target.deploymentId,
      lastReleaseId: input.target.releaseId,
      lastVersion: input.target.version,
      title: input.title ?? undefined,
      status: "running",
      updatedAt: new Date(),
    })
    .where(eq(playgroundSessions.id, input.id));
}

/**
 * Atomically claim the session for one turn (issue #221 finding 5): a compare-and-swap to
 * `running` carrying the caller's per-turn `claimId` as the fencing token. Everything
 * `markPlaygroundSessionRunning` sets is set here too. The claim wins when the session is not
 * `running`, OR its `running` is stale — no drain activity (`updatedAt` bump) for
 * `staleAfterMs`. The cutoff must match the drain's own idle-failure timeout
 * (TURN_IDLE_TIMEOUT_MS): the drain bumps `updatedAt` only when events arrive, and a silent
 * long tool call can go minutes without events — a shorter cutoff would let a second tab
 * steal a LIVE turn. Returns the claimed row, or null when another turn holds the session.
 */
export async function claimPlaygroundSessionForTurn(input: {
  id: string;
  target: Target;
  title?: string | null;
  claimId: string;
  /** Stale-takeover cutoff; callers pass TURN_IDLE_TIMEOUT_MS from ~/chat/turn-stream.server. */
  staleAfterMs: number;
}): Promise<PlaygroundSession | null> {
  const staleBefore = new Date(Date.now() - input.staleAfterMs);
  const [row] = await db
    .update(playgroundSessions)
    .set({
      environmentId: input.target.environmentId,
      worldKey: input.target.environmentId,
      lastDeploymentId: input.target.deploymentId,
      lastReleaseId: input.target.releaseId,
      lastVersion: input.target.version,
      title: input.title ?? undefined,
      status: "running",
      turnClaimId: input.claimId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        or(
          ne(playgroundSessions.status, "running"),
          lt(playgroundSessions.updatedAt, staleBefore),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export async function savePlaygroundSessionProgress(input: {
  id: string;
  target: Target;
  externalSessionId: string;
  continuationToken: string | null;
  streamIndex: number;
  title?: string | null;
  /** Fencing token (issue #221 finding 5): when set, only the claim-holding drain writes. */
  claimId?: string;
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      environmentId: input.target.environmentId,
      worldKey: input.target.environmentId,
      externalSessionId: input.externalSessionId,
      continuationToken: input.continuationToken,
      streamIndex: input.streamIndex,
      lastDeploymentId: input.target.deploymentId,
      lastReleaseId: input.target.releaseId,
      lastVersion: input.target.version,
      title: input.title ?? undefined,
      status: "running",
      lastEventAt: new Date(),
      updatedAt: new Date(),
    })
    // Stop wins races with the detached drain. Once the user has deliberately stopped a turn,
    // an already-queued progress save must not flip the row back to `running`. The claim fence
    // (when carried) makes a superseded drain's late writes hit zero rows the same way.
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        ne(playgroundSessions.status, "stopped"),
        input.claimId
          ? eq(playgroundSessions.turnClaimId, input.claimId)
          : undefined,
      ),
    );
}

export async function savePlaygroundSessionCursor(input: {
  id: string;
  target: Target;
  externalSessionId: string | null;
  continuationToken: string | null;
  streamIndex: number;
  title?: string | null;
  status: "running" | "waiting" | "completed" | "failed";
  /** Fencing token (issue #221 finding 5): when set, only the claim-holding drain writes. */
  claimId?: string;
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      environmentId: input.target.environmentId,
      worldKey: input.target.environmentId,
      externalSessionId: input.externalSessionId,
      continuationToken: input.continuationToken,
      streamIndex: input.streamIndex,
      lastDeploymentId: input.target.deploymentId,
      lastReleaseId: input.target.releaseId,
      lastVersion: input.target.version,
      title: input.title ?? undefined,
      status: input.status,
      lastEventAt: new Date(),
      updatedAt: new Date(),
    })
    // The drain can reach its final cursor save after /stop has settled the row. Preserve the
    // user's terminal `stopped` state instead of racing it back to `waiting` or `failed`.
    // The claim fence (when carried) no-ops a superseded drain's late terminal write too.
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        ne(playgroundSessions.status, "stopped"),
        input.claimId
          ? eq(playgroundSessions.turnClaimId, input.claimId)
          : undefined,
      ),
    );
}

/**
 * Append raw Eve stream events to the durable transcript cache. Called by the turn-stream drain as
 * events arrive, so the transcript survives client disconnect AND instance death. The (session,
 * streamIndex) PK makes this idempotent: a re-drained index (e.g. a retried turn) is a no-op, so
 * callers can flush optimistically without tracking exactly what's already stored.
 *
 * `indexOffset` shifts the passed (eve-space) indices into cache space. It is 0 normally and
 * `session.cacheIndexOffset` after a cross-redeploy reseed (#71): a fresh eve session re-indexes
 * from 1, so without the offset its events would collide with the preserved history on the PK and
 * silently vanish (ON CONFLICT DO NOTHING). The offset lands them after the preserved rows.
 */
export async function savePlaygroundEvents(
  sessionId: string,
  events: Array<{ streamIndex: number } & RawEveEvent>,
  indexOffset = 0,
): Promise<void> {
  if (events.length === 0) return;
  await db
    .insert(playgroundEvents)
    .values(
      events.map((e) => ({
        sessionId,
        streamIndex: e.streamIndex + indexOffset,
        type: e.type,
        data: e.data,
        meta: e.meta ?? null,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Unbind a session from its dead eve session so the next turn seeds a FRESH eve session on the
 * replacement deployment (#71). The cached transcript is untouched; `cacheIndexOffset` moves to
 * the top of the cache so the new session's events (indexed from 1 by the drain) append after
 * the preserved history instead of colliding with it on the (session, streamIndex) PK.
 *
 * `resume_via` clears with the handles it describes (WS1). The reseeded session is an ordinary
 * HTTP-homed eve session on the new deployment — leaving a channel descriptor behind would aim
 * the NEXT turn at a channel answer route holding a continuation token for a session that died
 * with the old container.
 */
export async function unbindPlaygroundSessionForReseed(
  session: PlaygroundSession,
): Promise<PlaygroundSession> {
  const offset = await cachedStreamIndex(session.id);
  const [row] = await db
    .update(playgroundSessions)
    .set({
      externalSessionId: null,
      continuationToken: null,
      resumeVia: null,
      streamIndex: 0,
      cacheIndexOffset: offset,
      updatedAt: new Date(),
    })
    .where(eq(playgroundSessions.id, session.id))
    .returning();
  return row;
}

/**
 * Highest streamIndex already in the transcript cache for a session (0 if none). Used by
 * `unbindPlaygroundSessionForReseed` (#71) to compute the reseed offset — the top of the preserved
 * history the fresh eve session's events must append after — and by the DB integration test to
 * assert what the cache covers.
 */
export async function cachedStreamIndex(sessionId: string): Promise<number> {
  const [row] = await db
    .select({ value: max(playgroundEvents.streamIndex) })
    .from(playgroundEvents)
    .where(eq(playgroundEvents.sessionId, sessionId));
  return row?.value ?? 0;
}

/**
 * Whether the transcript cache covers this session's history from its FIRST event. False for a
 * legacy session whose cursor advanced before the cache existed: its earliest cached row (if any)
 * starts past index 1, so everything before it is missing — merely "cache non-empty" is not
 * enough, or one new turn on a legacy session would permanently hide all pre-cache history.
 */
export async function playgroundCacheIsComplete(
  session: PlaygroundSession,
): Promise<boolean> {
  // No history consumed yet — nothing the cache could be missing.
  if (session.streamIndex <= 0) return true;
  const [row] = await db
    .select({ value: min(playgroundEvents.streamIndex) })
    .from(playgroundEvents)
    .where(eq(playgroundEvents.sessionId, session.id));
  // The drain assigns index 1 to a session's first event, so coverage-from-the-start means the
  // cache's lowest index is exactly 1 (contiguity above it is the drain's invariant).
  return row?.value === 1;
}

/**
 * One-time backfill for a legacy session (created before the transcript cache): replay every
 * event the cursor has consumed from Eve's durable log and persist it into `playground_events`,
 * making the cache complete from index 1. Idempotent — indices are positional (Eve's log starts
 * at our index 1) and the (session, streamIndex) PK turns re-inserted rows into no-ops — so
 * overlapping with rows the drain already cached is safe.
 */
export async function backfillPlaygroundEventsFromEve(input: {
  session: PlaygroundSession;
  target: Target;
  timeoutMs?: number;
}): Promise<void> {
  if (!input.session.externalSessionId || input.session.streamIndex <= 0) {
    return;
  }
  const events = await readEveSessionEvents({
    baseUrl: input.target.url,
    limit: input.session.streamIndex,
    sessionId: input.session.externalSessionId,
    timeoutMs: input.timeoutMs,
  });
  await savePlaygroundEvents(
    input.session.id,
    events.map((event, i) => ({ streamIndex: i + 1, ...event })),
    input.session.cacheIndexOffset,
  );
}

/**
 * Copy a CHANNEL-HOMED session's transcript into the cache at park time (WS1). Unlike the relay
 * park, nothing on harnesst's side ran the turn, so there is no cursor to bound the read:
 * `backfillPlaygroundEventsFromEve` needs `streamIndex > 0` and would no-op forever. Read the
 * tail from index 0 instead — it stops at the terminal event (`session.waiting`, which is what a
 * parked session emits) or on idle — then advance the cursor to what landed.
 *
 * Advancing the cursor is not cosmetic: the human's answer opens eve's stream at
 * `startIndex = streamIndex`, so leaving it at 0 would replay the whole GitHub conversation into
 * the browser as if it were part of the answering turn. Guarded `stream_index < events.length`
 * so a concurrent drain's larger cursor always wins.
 */
export async function backfillChannelHomedSessionTranscript(input: {
  session: PlaygroundSession;
  target: Target;
  timeoutMs?: number;
}): Promise<void> {
  if (!input.session.externalSessionId) return;
  // Already cached by an earlier park or a drain — the cursor is authoritative.
  if (input.session.streamIndex > 0) return;
  const { events } = await readEveSessionTail({
    baseUrl: input.target.url,
    sessionId: input.session.externalSessionId,
    startIndex: 0,
    timeoutMs: input.timeoutMs ?? 5_000,
  });
  if (events.length === 0) return;
  await savePlaygroundEvents(
    input.session.id,
    events.map((event, i) => ({ streamIndex: i + 1, ...event })),
    input.session.cacheIndexOffset,
  );
  await db
    .update(playgroundSessions)
    .set({ streamIndex: events.length, updatedAt: new Date() })
    .where(
      and(
        eq(playgroundSessions.id, input.session.id),
        lt(playgroundSessions.streamIndex, events.length),
      ),
    );
}

/**
 * Rebuild a session's transcript from harnesst's durable cache — no Eve replay. The cached rows are the
 * raw Eve events, so the same `projectEventsToEntries` used by the Eve-replay path reconstructs
 * identical `ChatEntry[]`.
 */
export async function loadPlaygroundEntriesFromCache(
  session: PlaygroundSession,
): Promise<ChatEntry[]> {
  const rows = await db
    .select({
      type: playgroundEvents.type,
      data: playgroundEvents.data,
      meta: playgroundEvents.meta,
    })
    .from(playgroundEvents)
    .where(eq(playgroundEvents.sessionId, session.id))
    .orderBy(playgroundEvents.streamIndex);
  if (rows.length === 0) return [];
  const events: EveStreamEvent[] = rows.map((r) => ({
    type: r.type,
    data: (r.data ?? {}) as Record<string, unknown>,
    meta: (r.meta ?? undefined) as { at?: string } | undefined,
  }));
  return projectEventsToEntries(events, session);
}

export async function markPlaygroundSessionStopped(input: {
  id: string;
  target?: Target | null;
  title?: string | null;
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      // A stopped session may outlive the deployment that owns its Eve session. In that case,
      // settle harnesst's row without assigning the replacement deployment as the owner: doing so
      // would make a later continuation send the old external session id to the wrong Eve.
      environmentId: input.target?.environmentId,
      worldKey: input.target?.environmentId,
      lastDeploymentId: input.target?.deploymentId,
      lastReleaseId: input.target?.releaseId,
      lastVersion: input.target?.version,
      title: input.title ?? undefined,
      // Distinct from "failed": a deliberate stop shouldn't get the timed-out
      // recovery hint in the replay, and shouldn't be reconciled back to "failed"
      // (the tsx loader only reconciles "running"/"failed" sessions).
      status: "stopped",
      // A stop moots any parked question, and the pending writers' stop-wins guards mean
      // nobody else can clear it once the row is `stopped` — so it must clear here (D4).
      pendingInputAt: null,
      lastEventAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(playgroundSessions.id, input.id));
}

/**
 * Settle a `running` session whose turn is unrecoverable (see ~/playground/settle.ts for when
 * that's provable). Flips it to `failed` so the UI stops treating it as busy; the transcript
 * keeps whatever the drain persisted before it died. Guarded on `status = 'running'` so a drain
 * elsewhere that settles concurrently isn't clobbered.
 */
export async function settleAbandonedPlaygroundSession(
  session: PlaygroundSession,
): Promise<PlaygroundSession> {
  const [row] = await db
    .update(playgroundSessions)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(playgroundSessions.id, session.id),
        eq(playgroundSessions.status, "running"),
      ),
    )
    .returning();
  return row ?? session;
}

export function titleFromMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed || "New conversation";
  return `${collapsed.slice(0, 79)}…`;
}

export async function loadPlaygroundEntriesFromEve(input: {
  session: PlaygroundSession;
  target: Target;
  timeoutMs?: number;
}): Promise<ChatEntry[]> {
  if (!input.session.externalSessionId || input.session.streamIndex <= 0) {
    return [];
  }
  const events = await readEveSessionEvents({
    baseUrl: input.target.url,
    limit: input.session.streamIndex,
    sessionId: input.session.externalSessionId,
    timeoutMs: input.timeoutMs,
  });
  return projectEventsToEntries(events, input.session);
}

export async function reconcilePlaygroundSessionFromEve(input: {
  session: PlaygroundSession;
  target: Target;
  timeoutMs?: number;
}): Promise<PlaygroundSession> {
  if (!input.session.externalSessionId) return input.session;
  const tail = await readEveSessionTail({
    baseUrl: input.target.url,
    sessionId: input.session.externalSessionId,
    startIndex: input.session.streamIndex,
    timeoutMs: input.timeoutMs ?? 1_500,
  });
  if (tail.events.length === 0) return input.session;

  // Persist the tail into the durable transcript cache BEFORE advancing the cursor. The cache is
  // the transcript's source of truth, and the next turn drains Eve starting at the advanced
  // cursor — so any event the cursor passes without being cached here would never be seen again
  // (the recovered final reply would silently vanish). Indices continue the drain's scheme
  // (cursor N ⇒ next event is N+1), so an overlapping drain or a re-reconcile is an idempotent
  // no-op via the (session, streamIndex) PK.
  await savePlaygroundEvents(
    input.session.id,
    tail.events.map((event, i) => ({
      streamIndex: input.session.streamIndex + 1 + i,
      ...event,
    })),
    input.session.cacheIndexOffset,
  );

  const nextStreamIndex = input.session.streamIndex + tail.events.length;
  const nextStatus =
    statusFromTail(tail.events) ?? sessionStatus(input.session.status);

  // FOH needs-you chokepoint #2 (D4): a drain that died with the process is recovered here.
  // The tail is scanned for unanswered `input.requested`s on its newest turn — `nextStatus`
  // alone can't tell parked from finished ('waiting' covers both). This runs BEFORE the
  // cursor save (issue #221 finding 4): every write here is idempotent (requestId
  // uniqueness; only-forward flag semantics), so a crash between them leaves the cursor
  // behind and the next reconcile re-reads the tail and repeats — whereas the old order left
  // an advanced cursor with the park lost forever. Exception-swallowed so inbox bookkeeping
  // never breaks a loader.
  let pendingInputAt = input.session.pendingInputAt;
  if (input.session.surface === "foh") {
    try {
      const decision = reconcileNeedsYouFromTail(tail.events);
      if (decision.action === "park") {
        const at = pendingInputAt ?? new Date();
        // The park claim reports whether it won its stop-wins guard; when stop got there
        // first, the inbox items must not be filed for the stopped session.
        const parked = await markSessionPendingInput(input.session.id, at);
        if (parked) {
          pendingInputAt = at;
          for (const data of decision.requestData) {
            for (const request of inputRequestsOf(data)) {
              await openInboxQuestion({
                projectId: input.session.projectId,
                sessionId: input.session.id,
                agentId: input.session.agentId,
                userId: input.session.createdBy,
                delegationId: input.session.delegationId,
                request,
              });
            }
          }
        }
      } else if (decision.action === "settle") {
        pendingInputAt = null;
        await clearSessionPendingInput(input.session.id);
        await resolveInboxForSession(input.session.id);
      }
    } catch (e) {
      console.error("[foh] reconcile needs-you failed", e);
    }
  }

  await savePlaygroundSessionCursor({
    id: input.session.id,
    target: input.target,
    externalSessionId: input.session.externalSessionId,
    continuationToken: input.session.continuationToken,
    streamIndex: nextStreamIndex,
    title: null,
    status: nextStatus,
  });

  return {
    ...input.session,
    pendingInputAt,
    environmentId: input.target.environmentId,
    worldKey: input.target.environmentId,
    lastDeploymentId: input.target.deploymentId,
    lastReleaseId: input.target.releaseId,
    lastVersion: input.target.version,
    streamIndex: nextStreamIndex,
    status: nextStatus,
    lastEventAt: new Date(),
    updatedAt: new Date(),
  };
}

interface EveStreamEvent {
  type: string;
  data: Record<string, unknown>;
  meta?: { at?: string };
}

/**
 * Eve answers a session-stream request's HEADERS immediately when it knows the session — but for
 * a session id it has never seen (e.g. a fresh instance asked about a pre-redeploy session) it
 * hangs the request forever instead of 404ing. These reads sit on the playground loader's
 * critical path, so give the pre-headers phase its own short budget: a healthy instance clears it
 * in milliseconds, and a hang costs ~3s instead of a 15s page load (#73).
 */
const EVE_STREAM_CONNECT_TIMEOUT_MS = 3_000;

async function readEveSessionEvents(input: {
  baseUrl: string;
  sessionId: string;
  limit: number;
  timeoutMs?: number;
}): Promise<EveStreamEvent[]> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? 15_000;
  const connectController = new AbortController();
  const connectTimer = setTimeout(
    () => connectController.abort(),
    Math.min(timeoutMs, EVE_STREAM_CONNECT_TIMEOUT_MS),
  );
  let res: Response;
  try {
    res = await fetch(
      `${base}/eve/v1/session/${input.sessionId}/stream?startIndex=0`,
      {
        signal: AbortSignal.any([
          AbortSignal.timeout(timeoutMs),
          connectController.signal,
        ]),
      },
    );
  } finally {
    // Headers arrived (or the fetch failed) — from here only the overall budget applies.
    clearTimeout(connectTimer);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Eve stream returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: EveStreamEvent[] = [];
  let buf = "";
  try {
    while (events.length < input.limit) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        if (events.length >= input.limit) break;
        const event = parseEveLine(raw);
        if (event) events.push(event);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return events;
}

async function readEveSessionTail(input: {
  baseUrl: string;
  sessionId: string;
  startIndex: number;
  timeoutMs: number;
}): Promise<{ events: EveStreamEvent[] }> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const fetchController = new AbortController();
  // Pre-headers budget only — the timer is cleared as soon as the response arrives, and the idle
  // race below bounds the body reads. See EVE_STREAM_CONNECT_TIMEOUT_MS for why this is short.
  const fetchTimer = setTimeout(
    () => fetchController.abort(),
    EVE_STREAM_CONNECT_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetch(
      `${base}/eve/v1/session/${input.sessionId}/stream?startIndex=${input.startIndex}`,
      { signal: fetchController.signal },
    );
  } finally {
    clearTimeout(fetchTimer);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Eve stream returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: EveStreamEvent[] = [];
  let buf = "";
  let terminal = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const read = async () =>
    Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () => reject(new Error("idle")),
          input.timeoutMs,
        );
      }),
    ]).finally(() => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    });

  try {
    while (!terminal) {
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
        events.push(event);
        if (isTerminalEvent(event)) {
          terminal = true;
          break;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { events };
}

function isTerminalEvent(event: EveStreamEvent): boolean {
  return (
    event.type === "session.waiting" ||
    event.type === "session.failed" ||
    event.type === "turn.failed"
  );
}

function statusFromTail(
  events: EveStreamEvent[],
): "waiting" | "completed" | "failed" | "running" | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "session.waiting" || event.type === "turn.completed") {
      return "waiting";
    }
    if (event.type === "turn.failed" || event.type === "session.failed") {
      return "failed";
    }
    if (
      event.type === "message.appended" ||
      event.type === "actions.requested" ||
      event.type === "step.started" ||
      event.type === "reasoning.appended"
    ) {
      return "running";
    }
  }
  return null;
}

function sessionStatus(
  value: string,
): "running" | "waiting" | "completed" | "failed" {
  if (
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  return "waiting";
}

function parseEveLine(raw: string): EveStreamEvent | null {
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

interface TurnProjection {
  turnId: string;
  index: number;
  userText: string | null;
  /** Every settled assistant message of the turn (they interleave with tool steps). */
  messages: string[];
  /** Partial text of a message that never completed (turn cut off mid-stream). */
  partial: string | null;
  inputRequests: ChatInputRequest[];
  modelId: string | null;
  effort: ReasoningEffort | null;
  steps: ChatStep[];
  error: string | null;
  stepStarts: Map<number, number>;
  actionsBySeq: Map<number, TurnAction[]>;
  actionByCallId: Map<string, TurnAction>;
}

interface TurnAction {
  toolName: string;
  summary?: string;
  exitCode?: number;
  isError?: boolean;
}

function projectEventsToEntries(
  events: EveStreamEvent[],
  session: PlaygroundSession,
): ChatEntry[] {
  const turns = new Map<string, TurnProjection>();
  const ordered: TurnProjection[] = [];
  let modelId: string | null = null;
  // Dynamic-model agents report `dynamic:<fallback id>`; the model that actually served a turn
  // is then the message's directive (if any) over that fallback. Static agents ignore
  // directives, so attribution must too.
  let dynamicModel = false;

  const turnFor = (turnId: string | null): TurnProjection | null => {
    if (!turnId) return null;
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        index: ordered.length,
        userText: null,
        messages: [],
        partial: null,
        inputRequests: [],
        modelId,
        effort: null,
        steps: [],
        error: null,
        stepStarts: new Map(),
        actionsBySeq: new Map(),
        actionByCallId: new Map(),
      };
      turns.set(turnId, turn);
      ordered.push(turn);
    }
    return turn;
  };

  for (const event of events) {
    const data = event.data;
    const turnId = typeof data.turnId === "string" ? data.turnId : null;
    const turn = turnFor(turnId);
    const at = event.meta?.at ? Date.parse(event.meta.at) : Date.now();
    const stepIndex = typeof data.stepIndex === "number" ? data.stepIndex : 0;
    const sequence =
      typeof data.sequence === "number" ? data.sequence : stepIndex;

    switch (event.type) {
      case "session.started": {
        const runtime = data.runtime as Record<string, unknown> | undefined;
        if (runtime && typeof runtime.modelId === "string") {
          const base = runtimeModelBase(runtime.modelId);
          dynamicModel = base.dynamic;
          modelId = base.id;
        }
        break;
      }
      case "turn.started":
        if (turn && !turn.modelId) turn.modelId = modelId;
        break;
      case "message.received": {
        if (!turn) break;
        const raw = textOf(data.message);
        if (raw === null) break;
        // The sent message may carry the model directive — attribute the turn to it, and never
        // show it: the transcript displays the message as the user typed it.
        if (dynamicModel) {
          const directive = parseModelDirective(raw);
          if (directive) {
            turn.modelId = directive.id;
            turn.effort = directive.effort ?? null;
          }
        }
        // Strip all three wrappers: the model directive; for a cross-redeploy reseed turn (#71),
        // the leading harnesst:context block seeded from the cached transcript; and, for a
        // channel-homed turn, eve's `<github_context>` envelope — the human opening a parked
        // GitHub question from the inbox should not have to read past delivery ids to find the
        // sentence they were sent here for.
        turn.userText = stripChannelContext(
          stripSeedContext(stripModelDirective(raw)),
        );
        break;
      }
      case "step.started":
        turn?.stepStarts.set(sequence, at);
        break;
      case "actions.requested": {
        if (!turn) break;
        const actions = Array.isArray(data.actions) ? data.actions : [];
        const seqActions = turn.actionsBySeq.get(sequence) ?? [];
        for (const rawAction of actions) {
          if (typeof rawAction !== "object" || rawAction === null) continue;
          const action = rawAction as Record<string, unknown>;
          const toolName =
            typeof action.toolName === "string" ? action.toolName : "tool";
          const summary = summarizeActionInput(action.input);
          const record: TurnAction = { toolName, summary };
          seqActions.push(record);
          if (typeof action.callId === "string") {
            turn.actionByCallId.set(action.callId, record);
          }
        }
        turn.actionsBySeq.set(sequence, seqActions);
        break;
      }
      case "action.result": {
        if (!turn) break;
        const result = data.result as Record<string, unknown> | undefined;
        const callId =
          result && typeof result.callId === "string" ? result.callId : null;
        const record = callId ? turn.actionByCallId.get(callId) : undefined;
        if (!record) break;
        const output = result?.output;
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
        break;
      }
      case "message.appended":
        // Cumulative for the CURRENT message only — kept as a fallback in case the
        // message never completes (turn cut off mid-stream).
        if (turn && typeof data.messageSoFar === "string") {
          turn.partial = data.messageSoFar;
        }
        break;
      case "message.completed": {
        if (!turn) break;
        const message = textOf(data.message) ?? textOf(data);
        if (message) turn.messages.push(message);
        turn.partial = null;
        break;
      }
      case "input.requested":
        // The agent asked the user something (ask_question / tool approval).
        if (turn) turn.inputRequests.push(...inputRequestsOf(data));
        break;
      case "step.completed":
      case "step.failed": {
        if (!turn) break;
        const failure =
          event.type === "step.failed"
            ? failureOf(data, "The agent step failed.")
            : null;
        if (failure) turn.error = failure.text;
        const usage = data.usage as Record<string, unknown> | undefined;
        const started = turn.stepStarts.get(sequence);
        const actions = turn.actionsBySeq.get(sequence);
        const primary = actions?.[0];
        turn.steps.push({
          type: event.type,
          name: stringField(data, "name"),
          durationMs: started != null ? Math.max(0, at - started) : null,
          tokensIn:
            usage && typeof usage.inputTokens === "number"
              ? usage.inputTokens
              : null,
          tokensOut:
            usage && typeof usage.outputTokens === "number"
              ? usage.outputTokens
              : null,
          isError: event.type === "step.failed",
          code: failure?.code ?? null,
          message: failure?.message ?? null,
          details: failure?.details ?? null,
          toolName: primary?.toolName ?? null,
          summary: primary?.summary ?? null,
        });
        break;
      }
      case "turn.failed":
      case "session.failed":
        if (turn || event.type === "session.failed") {
          const failure = failureOf(data, "The turn failed.");
          const targetTurn = turn ?? ordered.at(-1);
          if (targetTurn) targetTurn.error = failure.text;
        }
        break;
    }
  }

  const entries: ChatEntry[] = [];
  const channelLabel = session.resumeVia
    ? channelLabelFor(session.resumeVia.channel)
    : null;
  const lastTurn = ordered.at(-1);
  for (const turn of ordered) {
    if (turn.userText) {
      entries.push({
        id: `${turn.turnId}:user`,
        role: "user",
        text: turn.userText,
      });
    }
    const reply =
      turn.messages.length > 0
        ? [...turn.messages, ...(turn.partial ? [turn.partial] : [])].join(
            "\n\n",
          )
        : turn.partial;
    if (
      reply !== null ||
      turn.inputRequests.length > 0 ||
      turn.error !== null ||
      turn.steps.length > 0
    ) {
      const normalized = normalizeReply(reply);
      // `session.status` is a property of the SESSION, not of this turn, so it may only stand in
      // for a missing error on the turn that was actually running when it failed. Applied to every
      // reply-less turn (as it once was) it defames the completed ones: a turn that ended by ASKING
      // has no reply by design, so a parked GitHub question read "The turn stopped before harnesst
      // recorded a final reply" as soon as a later turn failed — above the question itself.
      const isUnfinishedTail =
        turn === lastTurn &&
        !normalized.reply &&
        turn.inputRequests.length === 0;
      const replayError =
        turn.error ??
        (session.status === "failed" && isUnfinishedTail
          ? "The turn stopped before harnesst recorded a final reply. Reloading may recover it if Eve finished after the last saved cursor."
          : null);
      const normalizedError = normalizeTurnError(replayError, { channelLabel });
      entries.push({
        id: `${turn.turnId}:assistant`,
        role: "assistant",
        text: normalized.reply ?? "",
        structured: normalized.replyIsStructured,
        version: session.lastVersion ?? undefined,
        modelId: turn.modelId,
        effort: turn.effort,
        steps: turn.steps,
        inputRequests:
          turn.inputRequests.length > 0 ? turn.inputRequests : undefined,
        error: normalizedError?.message ?? null,
        errorDetail: normalizedError?.detail ?? null,
        errorRetryable: normalizedError?.retryable ?? false,
      });
    }
  }
  return entries;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const text = (part as Record<string, unknown>).text;
          return typeof text === "string" ? text : null;
        }
        return null;
      })
      .filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const object = value as Record<string, unknown>;
  for (const key of [
    "text",
    "content",
    "message",
    "output",
    "result",
    "reply",
  ]) {
    const nested = object[key];
    if (typeof nested === "string" && nested.trim()) return nested;
    if (typeof nested === "object" && nested !== null) {
      const text = textOf(nested);
      if (text) return text;
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
  if (typeof value === "string") {
    return value.trim() ? compactText(value.trim()) : null;
  }
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

function summarizeActionInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const object = input as Record<string, unknown>;
  const preferred =
    object.command ??
    object.skill ??
    object.path ??
    object.file_path ??
    firstStringValue(object);
  if (typeof preferred !== "string") return undefined;
  const trimmed = preferred.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}

function firstStringValue(obj: Record<string, unknown>): string | undefined {
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function normalizeReply(reply: string | null): {
  reply: string | null;
  replyIsStructured: boolean;
} {
  if (!reply) return { reply, replyIsStructured: false };
  const trimmed = reply.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return {
        reply: JSON.stringify(JSON.parse(trimmed), null, 2),
        replyIsStructured: true,
      };
    } catch {
      // Plain prose that happens to start with a brace.
    }
  }
  return { reply, replyIsStructured: false };
}
