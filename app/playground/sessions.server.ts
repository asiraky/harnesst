import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { inputRequestsOf } from "~/agent/talk.server";
import { normalizeTurnError } from "~/chat/stream-error";
import type { ChatEntry, ChatInputRequest, ChatStep } from "~/chat/types";
import { user } from "~/db/auth-schema";
import { db } from "~/db/client.server";
import {
  agents,
  conversationReads,
  playgroundSessions,
  type SessionResumeVia,
} from "~/db/schema";
import {
  mergeArtifactEntries,
  turnAnchorsFromEvents,
} from "~/foh/artifact-entries";
import { listArtifactsForSession } from "~/foh/artifact-store.server";
import { channelLabelFor } from "~/foh/channel-resume";
import {
  openInboxQuestion,
  resolveInboxForArchivedSession,
  resolveInboxForSession,
} from "~/foh/inbox.server";
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
import { stripSystemNotes } from "~/chat/system-note";
import type { Target } from "~/chat/playground.server";
import type { ReasoningEffort } from "~/models/reasoning";

export { titleFromMessage } from "~/foh/session-title";

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

/**
 * Inference is best-effort and can finish after a human renames the row. Keep the check inside
 * the UPDATE expression so the manual rename wins even when the two writes race.
 */
function inferredTitleUpdate(title: string | null | undefined) {
  if (title == null) return undefined;
  return sql<
    string | null
  >`CASE WHEN ${playgroundSessions.titleManuallySet} THEN ${playgroundSessions.title} ELSE ${title} END`;
}

/**
 * The front-of-house row predicate (§6 roles): a member sees their own conversations plus
 * agent-opened ones (`created_by IS NULL`, team-wide by design); an admin/owner sees
 * everything on the agent. Written once and shared so that the list, the single-row read, and
 * the archive mutations can never drift apart — and() drops the `undefined`.
 */
function fohViewerScope(
  viewerId: string,
  includeAll?: boolean,
): SQL | undefined {
  return includeAll
    ? undefined
    : or(
        eq(playgroundSessions.createdBy, viewerId),
        isNull(playgroundSessions.createdBy),
      );
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
  /** When the conversation was archived out of the FOH list (#278); null while it is live. */
  archivedAt: string | null;
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
    archivedAt: session.archivedAt?.toISOString() ?? null,
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
 * Rename one visible FOH conversation. This uses the same tenancy/role predicate as the list and
 * single-row read; a plain member cannot rename another member's private conversation. Renaming
 * does not bump `updatedAt`: that timestamp represents conversation activity and controls list
 * order, not metadata edits.
 */
export async function renameFohSession(input: {
  id: string;
  projectId: string;
  agentId: string;
  viewerId: string;
  includeAll?: boolean;
  title: string;
}): Promise<{ id: string; title: string } | null> {
  const [renamed] = await db
    .update(playgroundSessions)
    .set({ title: input.title, titleManuallySet: true })
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.agentId, input.agentId),
        surfaceScope("foh"),
        fohViewerScope(input.viewerId, input.includeAll),
        isNull(playgroundSessions.archivedAt),
      ),
    )
    .returning({ id: playgroundSessions.id, title: playgroundSessions.title });
  return renamed?.title ? { id: renamed.id, title: renamed.title } : null;
}

/**
 * FOH middle-pane list (§6 roles): members see their own sessions plus agent-opened ones
 * (`created_by IS NULL`); admins/owners (`includeAll`) see every FOH session for the agent.
 * Rows carry the viewer's unread flag (D3) and come back needs-you first.
 *
 * Archived rows are absent (#278). That also re-aims the caller's row-spam guard — it counts
 * what this returns — at UNARCHIVED conversations, which is the intent: tidying up must make
 * room for new work.
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
        isNull(playgroundSessions.archivedAt),
        fohViewerScope(input.viewerId, input.includeAll),
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
 *
 * Archived rows are invisible here by default (#278), which is what makes a bookmarked URL and
 * every stream/stop/read post 404 on an archived conversation without a single extra check.
 * Only the archive mutations themselves pass `includeArchived` — undo and idempotent re-archive
 * must still be able to find the row.
 */
export async function getFohSessionForViewer(input: {
  id: string;
  projectId: string;
  /** Constrain to one agent (session view); omit where the route only knows the session. */
  agentId?: string;
  viewerId: string;
  includeAll?: boolean;
  includeArchived?: boolean;
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
        input.includeArchived
          ? undefined
          : isNull(playgroundSessions.archivedAt),
        fohViewerScope(input.viewerId, input.includeAll),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Where an agent's out-of-band write (artifact publishing, #290) is allowed to land: the ONE
 * front-of-house conversation that is running a turn on the deployment that is calling, right now.
 *
 * The caller is a TOOL, so nothing about the destination can come off the wire — the bearer proves
 * a deployment and eve hands a tool no session id. "Most recently updated FOH session of this
 * agent" was the first shape of this and it was a confidentiality bug, not a placement bug: FOH
 * sessions are per-creator visible, one deployment serves EVERY member's conversation with the
 * agent, and `updatedAt` is bumped by any message, drain event or unarchive — so member A's row
 * could be the newest while member B's turn published, and B's screenshot would render (and
 * download) inside A's transcript instead.
 *
 * So the destination is derived from the live turn instead, which is the fact the publish actually
 * carries: the tool runs INSIDE a turn, and a turn is claimed atomically
 * (`claimPlaygroundSessionForTurn`) onto exactly one session row with `status = 'running'`, a
 * fencing token, and this environment stamped on it (#288 dropped `last_deployment_id`, so the
 * environment — whose world store is shared by every deployment serving it — is the scope).
 * Staleness uses the claim's own cutoff, so an abandoned `running` row cannot be published into
 * forever.
 *
 * Two live turns on one deployment is possible (two members talking to the same agent at once), and
 * there is nothing in a publish that could tell them apart — so that is REFUSED (`ambiguous`)
 * rather than guessed. Refusing loses an image; guessing leaks one.
 */
export type FohPublishTargetResult =
  | { ok: true; session: PlaygroundSession }
  | { ok: false; reason: "no_live_turn" | "ambiguous" };

export async function liveFohTurnForDeployment(input: {
  projectId: string;
  agentId: string;
  /** The publishing deployment's environment — a staging container cannot publish into prod. */
  environmentId: string | null;
  /** Claim staleness cutoff; callers pass TURN_IDLE_TIMEOUT_MS, as the turn claim does. */
  staleAfterMs: number;
  now?: Date;
}): Promise<FohPublishTargetResult> {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - input.staleAfterMs);
  const rows = await db
    .select()
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.projectId, input.projectId),
        eq(playgroundSessions.agentId, input.agentId),
        surfaceScope("foh"),
        isNull(playgroundSessions.archivedAt),
        input.environmentId
          ? eq(playgroundSessions.environmentId, input.environmentId)
          : isNull(playgroundSessions.environmentId),
        eq(playgroundSessions.status, "running"),
        isNotNull(playgroundSessions.turnClaimId),
        gt(playgroundSessions.updatedAt, staleBefore),
      ),
    )
    // Two is all that matters: one row is the answer, two is a refusal.
    .limit(2);
  if (rows.length === 0) return { ok: false, reason: "no_live_turn" };
  if (rows.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, session: rows[0] };
}

/**
 * Outcome of a front-of-house archive (#278). A refusal is a VALUE, not a throw: "still
 * working — stop it first" is ordinary UI copy, not an error condition.
 */
export type ArchiveFohSessionResult =
  | { ok: true; session: PlaygroundSession }
  | { ok: false; reason: "not_found" | "working" };

/**
 * Archive one FOH session — the front-of-house tidy-up (#278). Reversible and cheap: the
 * transcript is untouched and undo is a single column clear. Nothing in FOH can destroy a
 * conversation; only the back-of-house `deleteFohSessionPermanently` does.
 *
 * Visibility is the viewer's own (`getFohSessionForViewer`): a member archives what they can
 * see, an admin/owner anything on the agent.
 */
export async function archiveFohSession(input: {
  id: string;
  projectId: string;
  viewerId: string;
  includeAll?: boolean;
  now?: Date;
}): Promise<ArchiveFohSessionResult> {
  const session = await getFohSessionForViewer({
    id: input.id,
    projectId: input.projectId,
    viewerId: input.viewerId,
    includeAll: input.includeAll,
    includeArchived: true,
  });
  if (!session) return { ok: false, reason: "not_found" };
  // Idempotent: a double-click, or a stale tab acting on a row someone already tidied away.
  // The inbox resolve runs AGAIN rather than being skipped: the row update and the resolve are
  // two statements, so a resolve that threw after the update committed left the conversation
  // hidden with items still pending, and this retry is the only path that can still repair it.
  if (session.archivedAt) {
    await resolveInboxForArchivedSession(session.id, session.archivedAt);
    return { ok: true, session };
  }
  // A live turn has to be stopped deliberately first — archiving mid-turn would hide a
  // conversation that is still writing events into itself (D4 status mapping).
  if (fohSessionStatus(session) === "working") {
    return { ok: false, reason: "working" };
  }

  const now = input.now ?? new Date();
  const [row] = await db
    .update(playgroundSessions)
    .set({
      archivedAt: now,
      archivedBy: input.viewerId,
      // Archiving retracts the conversation's claim on the team's attention, so the needs-you
      // park goes with it; leaving it set would resurrect a phantom question on restore.
      pendingInputAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(playgroundSessions.id, session.id),
        isNull(playgroundSessions.archivedAt),
        // Closes the read-then-write race: a turn claimed since the read above wins, and the
        // caller gets the same refusal it would have got a moment earlier.
        ne(playgroundSessions.status, "running"),
      ),
    )
    .returning();
  if (!row) {
    // Zero rows means one of two different things, and they must not be conflated: a turn
    // claimed the row (refuse), or a concurrent archive won (succeed — telling the loser of two
    // simultaneous clicks "still working" would deny them the Undo for a row that IS archived).
    const current = await getFohSessionForViewer({
      id: session.id,
      projectId: input.projectId,
      viewerId: input.viewerId,
      includeAll: input.includeAll,
      includeArchived: true,
    });
    if (current?.archivedAt) {
      await resolveInboxForArchivedSession(current.id, current.archivedAt);
      return { ok: true, session: current };
    }
    return { ok: false, reason: "working" };
  }
  // The bell items go with the park — ALL of them, unlike a deliberate stop (api.foh.stop),
  // which leaves `finished` to be acknowledged by opening the session. Nobody can open this one
  // any more, so an unresolved item would be a permanent bell entry pointing at a 404.
  await resolveInboxForArchivedSession(session.id, now);
  return { ok: true, session: row };
}

/** The archive-clearing update, shared by the FOH undo and the back-of-house restore. */
async function clearArchiveMarks(
  where: SQL | undefined,
): Promise<PlaygroundSession | null> {
  const [row] = await db
    .update(playgroundSessions)
    .set({ archivedAt: null, archivedBy: null, updatedAt: new Date() })
    .where(where)
    .returning();
  return row ?? null;
}

/**
 * Un-archive from the front of house — the "Undo" on the archived strip (#278). Same state
 * transition as `restoreFohSession`, but scoped to the FOH viewer rather than gated on
 * back-of-house: the person who just archived a conversation must be able to take it back
 * without an admin.
 */
export async function unarchiveFohSessionForViewer(input: {
  id: string;
  projectId: string;
  viewerId: string;
  includeAll?: boolean;
}): Promise<
  { ok: true; session: PlaygroundSession } | { ok: false; reason: "not_found" }
> {
  const row = await clearArchiveMarks(
    and(
      eq(playgroundSessions.id, input.id),
      eq(playgroundSessions.projectId, input.projectId),
      surfaceScope("foh"),
      isNotNull(playgroundSessions.archivedAt),
      fohViewerScope(input.viewerId, input.includeAll),
    ),
  );
  return row ? { ok: true, session: row } : { ok: false, reason: "not_found" };
}

/**
 * Restore an archived session from the back of house. `backOfHouse` is asserted rather than
 * assumed: every caller already passes the route guard's flag, and a future caller that
 * forgets should fail loudly here instead of quietly granting a member admin reach.
 */
export async function restoreFohSession(input: {
  id: string;
  projectId: string;
  backOfHouse: boolean;
}): Promise<PlaygroundSession | null> {
  if (!input.backOfHouse) {
    throw new Error("restoreFohSession requires back-of-house access");
  }
  return clearArchiveMarks(
    and(
      eq(playgroundSessions.id, input.id),
      eq(playgroundSessions.projectId, input.projectId),
      surfaceScope("foh"),
      isNotNull(playgroundSessions.archivedAt),
    ),
  );
}

/**
 * Delete an archived FOH session for good — the only user-reachable destructive path over
 * conversations (`deleteBareNotificationSession` is the one other `db.delete`, a server-side
 * compensation scoped to seconds-old bare notification rows). `archived_at IS NOT NULL` is part
 * of the predicate, so a live conversation can never be deleted through here: archiving first
 * is the mandatory, reversible step. Events, reads, inbox items and checkouts go with the row
 * via the existing ON DELETE cascades — there is deliberately no manual cleanup to keep in sync.
 */
export async function deleteFohSessionPermanently(input: {
  id: string;
  projectId: string;
  backOfHouse: boolean;
}): Promise<boolean> {
  if (!input.backOfHouse) {
    throw new Error("deleteFohSessionPermanently requires back-of-house access");
  }
  const deleted = await db
    .delete(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        eq(playgroundSessions.projectId, input.projectId),
        surfaceScope("foh"),
        isNotNull(playgroundSessions.archivedAt),
      ),
    )
    .returning({ id: playgroundSessions.id });
  return deleted.length > 0;
}

/** One row of the back-of-house archived listing — metadata only, no transcript. */
export interface ArchivedFohSessionRow {
  id: string;
  title: string;
  agentName: string;
  /** Who opened it: the person's name/email, or the peer agent for agent-opened rows. */
  openedBy: string;
  openedByAgent: boolean;
  /** ISO strings: this crosses the loader boundary straight into the BOH table. */
  archivedAt: string;
  /** Display name of the archiver; null when the account has since been removed. */
  archivedBy: string | null;
  lastEventAt: string | null;
  updatedAt: string;
}

/**
 * Archived FOH sessions for one repo, newest-archived first (#278). Back-of-house only — the
 * caller is behind `requireProject`, so there is no viewer scope here by design: an admin
 * restoring or deleting must see every archived conversation, including other members'.
 *
 * The two people columns (opener, archiver) and the opening agent are resolved with follow-up
 * lookups rather than repeated self-joins on `user`/`agents`, which drizzle can only express
 * with table aliases this codebase does not otherwise use.
 */
export async function listArchivedFohSessions(
  projectId: string,
): Promise<ArchivedFohSessionRow[]> {
  const rows = await db
    .select({
      session: playgroundSessions,
      agentName: agents.name,
    })
    .from(playgroundSessions)
    .innerJoin(agents, eq(agents.id, playgroundSessions.agentId))
    .where(
      and(
        eq(playgroundSessions.projectId, projectId),
        surfaceScope("foh"),
        isNotNull(playgroundSessions.archivedAt),
      ),
    )
    .orderBy(desc(playgroundSessions.archivedAt));
  if (rows.length === 0) return [];

  const userIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.session.createdBy, row.session.archivedBy].filter(
          (id): id is string => id != null,
        ),
      ),
    ),
  ];
  const openerAgentIds = [
    ...new Set(
      rows
        .map((row) => row.session.openedByAgentId)
        .filter((id): id is string => id != null),
    ),
  ];
  const [people, openerAgents] = await Promise.all([
    userIds.length
      ? db
          .select({ id: user.id, name: user.name, email: user.email })
          .from(user)
          .where(inArray(user.id, userIds))
      : [],
    openerAgentIds.length
      ? db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, openerAgentIds))
      : [],
  ]);
  const personLabel = new Map(
    people.map((row) => [row.id, row.name || row.email] as const),
  );
  const agentLabel = new Map(openerAgents.map((row) => [row.id, row.name]));

  return rows.map(({ session, agentName }) => ({
    id: session.id,
    title: session.title ?? "New conversation",
    agentName,
    openedBy:
      (session.createdBy ? personLabel.get(session.createdBy) : null) ??
      (session.openedByAgentId
        ? (agentLabel.get(session.openedByAgentId) ?? "an agent")
        : null) ??
      // created_by IS NULL with no opening agent: a channel park (WS1) nobody in harnesst started.
      "the team",
    // A channel park writes BOTH `created_by` and `opened_by_agent_id` as null — nobody in
    // harnesst opened it and no peer agent did either. Keying off `created_by` alone labelled
    // those "the team (agent)".
    openedByAgent: session.openedByAgentId != null,
    archivedAt: (session.archivedAt ?? session.updatedAt).toISOString(),
    archivedBy: session.archivedBy
      ? (personLabel.get(session.archivedBy) ?? null)
      : null,
    lastEventAt: session.lastEventAt?.toISOString() ?? null,
    updatedAt: session.updatedAt.toISOString(),
  }));
}

/** How many archived FOH sessions a repo holds — the "N archived" footer link (#278). */
export async function countArchivedFohSessions(
  projectId: string,
): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.projectId, projectId),
        surfaceScope("foh"),
        isNotNull(playgroundSessions.archivedAt),
      ),
    );
  return row?.c ?? 0;
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
  /** Agent-initiated rows (#288 3c): the contact-user notification that opened the session. */
  openingMessage?: string | null;
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
      openingMessage: input.openingMessage ?? null,
    })
    .returning();
  return row;
}

/**
 * How many live agent-initiated FOH conversations an agent holds — the notify endpoint's
 * row-spam ceiling (#288 3c, the `foh.agent.tsx` new-session guard one caller further out).
 * Counts `created_by IS NULL` rows with no delegation (a delegation-opened row is a peer's
 * parked ask, not a notification) and, per #278, only unarchived ones — archiving is the way
 * back under the ceiling. `opening_message IS NOT NULL` is what makes the count NOTIFICATIONS
 * only: channel-parked conversations share the null creator/delegation shape (a GitHub user
 * opened them, not a member) but carry no opening message, and a busy channel must not eat the
 * agent's notification budget.
 */
export async function countAgentInitiatedFohSessions(
  agentId: string,
): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.agentId, agentId),
        surfaceScope("foh"),
        isNull(playgroundSessions.createdBy),
        isNull(playgroundSessions.delegationId),
        isNotNull(playgroundSessions.openingMessage),
        isNull(playgroundSessions.archivedAt),
      ),
    );
  return row?.c ?? 0;
}

/**
 * Compensation for a failed notify (#288 3c): the session insert and the notice inbox insert
 * share no transaction (this layer never opens one — see `parkChannelQuestion`), so a failed
 * bell write would otherwise strand a team-wide conversation nobody was told about, and the
 * agent's retry would open a second. The predicate is deliberately narrower than an id match:
 * only a row that still looks like a bare notification — agent-opened, no creator, no eve
 * session ever attached, an opening message present — can be reaped, so a mistaken call can
 * never take a conversation a human has engaged with.
 */
export async function deleteBareNotificationSession(id: string): Promise<void> {
  await db
    .delete(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.id, id),
        surfaceScope("foh"),
        isNull(playgroundSessions.createdBy),
        isNull(playgroundSessions.delegationId),
        isNull(playgroundSessions.externalSessionId),
        isNotNull(playgroundSessions.openingMessage),
      ),
    );
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
        lastVersion: input.version,
        status: "waiting",
        pendingInputAt: input.now,
        lastEventAt: input.now,
        updatedAt: input.now,
        // A fresh question RESURFACES an archived conversation (#278). Archiving says "I'm
        // done with this", not "hide anything this session ever asks again" — leaving it
        // archived would file a question into a row no FOH read can see, and lose it.
        archivedAt: null,
        archivedBy: null,
        ...(input.title ? { title: inferredTitleUpdate(input.title) } : {}),
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

  // A live turn holds the claim. Refresh only what the turn does not own — the resume handles,
  // and the archive marks (#278: no turn owns those, and a park landing mid-turn must still
  // resurface the conversation) — leaving `status`/`pendingInputAt`/`turn_claim_id` to the
  // claim holder.
  const [refreshed] = await db
    .update(playgroundSessions)
    .set({
      continuationToken: input.continuationToken,
      resumeVia: input.resumeVia,
      archivedAt: null,
      archivedBy: null,
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
 * relay chokepoints. Guarded on `status <> 'stopped'` and not archived: a session a human
 * deliberately retired must not be resurrected into the inbox by a late drain write. Returns
 * whether the park claim WON (a row
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
        // Archiving retracted the same claim on attention (#278), so a drain or reattach that
        // settles a moment after the archive must lose the way a stop makes it lose above —
        // otherwise the park flag and its inbox items land on a row no FOH read can see.
        isNull(playgroundSessions.archivedAt),
      ),
    )
    .returning({ id: playgroundSessions.id });
  return updated.length > 0;
}

/**
 * Put a `failed` row back to `waiting` after a park repair proved the failure never reached
 * the agent (issue #282: a send refused before delivery wrote `failed` while eve stayed
 * parked on its ask). Guarded on `status = 'failed'` so it can never stomp a running claim
 * or resurrect a stopped session. Returns whether a row was updated.
 */
export async function restoreRepairedSessionToWaiting(
  sessionId: string,
): Promise<boolean> {
  const updated = await db
    .update(playgroundSessions)
    .set({ status: "waiting", updatedAt: new Date() })
    .where(
      and(
        eq(playgroundSessions.id, sessionId),
        eq(playgroundSessions.status, "failed"),
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
      lastVersion: input.target.version,
      title: inferredTitleUpdate(input.title),
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
      // A BOUND row (externalSessionId set) keeps its home: environmentId/worldKey name the
      // one world store that holds the eve session, so only the first claim of an UNBOUND
      // row may bind them to the target — rewriting them on a bound row would point every
      // later env-match at an environment that never saw the session (#288).
      environmentId: sql`CASE WHEN ${playgroundSessions.externalSessionId} IS NULL THEN ${input.target.environmentId} ELSE ${playgroundSessions.environmentId} END`,
      worldKey: sql`CASE WHEN ${playgroundSessions.externalSessionId} IS NULL THEN ${input.target.environmentId} ELSE ${playgroundSessions.worldKey} END`,
      lastVersion: input.target.version,
      title: inferredTitleUpdate(input.title),
      status: "running",
      turnClaimId: input.claimId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        // Archive and claim are mutually exclusive transitions (#278). The archive predicate
        // refuses a `running` row; this refuses an archived one. Without both halves, a stream
        // route that resolved a live row and then spent time waking could claim a row
        // archived in the meantime — a running turn on a conversation no FOH read can reach, so
        // it cannot be opened or stopped, and BOH would offer to delete it outright.
        isNull(playgroundSessions.archivedAt),
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
      lastVersion: input.target.version,
      title: inferredTitleUpdate(input.title),
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

/**
 * Release a turn claim whose send was refused before the agent was ever contacted (issue
 * #282): put the row's status back to what it was before the claim and touch NOTHING else —
 * no cursor movement, no `lastEventAt` bump (no event happened; other viewers must not see
 * phantom activity). Claim-fenced and stop-wins like every other drain write. A pre-claim
 * `running` (the claim took over a stale turn) restores to `waiting` — writing `running`
 * back would strand a row nothing is draining.
 */
export async function releaseRefusedTurnClaim(input: {
  id: string;
  /** Fencing token; when absent the release still runs, guarded by stop-wins only. */
  claimId?: string | null;
  /** The row's status before the claim flipped it to `running`. */
  status: string;
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      status: input.status === "running" ? "waiting" : input.status,
      updatedAt: new Date(),
    })
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
      lastVersion: input.target.version,
      title: inferredTitleUpdate(input.title),
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
        // Archive is a terminal state for this writer for the same reason `stopped` is (#278):
        // a reconcile that read a live row, blocked on the eve tail, then lost a race with an
        // archive would otherwise write `status: 'running'` onto a hidden row — a turn nobody
        // can open or stop, which BOH would still offer to delete. Fencing the claim alone is
        // not enough; the cursor writer reaches the row without one.
        isNull(playgroundSessions.archivedAt),
        input.claimId
          ? eq(playgroundSessions.turnClaimId, input.claimId)
          : undefined,
      ),
    );
}

/**
 * Clear a session's eve handles so the next send starts a FRESH HTTP-homed eve session. Used
 * when a channel-homed resume descriptor is proven dead (the channel route answered "that
 * session is gone"): the descriptor can never resolve again, so the handles clear together —
 * leaving `resume_via` behind would aim the next turn at a channel answer route holding a
 * token for a session that no longer exists. The cursor resets with them; the fresh session's
 * stream starts over at index 0. Succession (#288 3b) does NOT come through here — it keeps
 * the handles until the successor provably exists (`bindSuccessorSessionHandles`).
 */
export async function clearSessionHandles(sessionId: string): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      externalSessionId: null,
      continuationToken: null,
      resumeVia: null,
      streamIndex: 0,
      updatedAt: new Date(),
    })
    .where(eq(playgroundSessions.id, sessionId));
}

/**
 * Rebind a channel-homed row to its SUCCESSOR eve session in one atomic write (#288 3b).
 * Called by the drain on the succession turn's `session` event — the first moment the
 * successor provably exists. Records the predecessor id for the render stitch (first
 * succession wins: a conversation spans at most two eve sessions, so the pointer never
 * moves once set), swaps in the successor's handles, drops the channel descriptor, and
 * restarts the cursor for the successor's stream. Claim-fenced and stop-wins like every
 * other drain write. Until this lands the row still holds the predecessor untouched, so a
 * succession that fails earlier retries with nothing lost.
 */
export async function bindSuccessorSessionHandles(input: {
  id: string;
  target: Target;
  externalSessionId: string;
  continuationToken: string | null;
  /** Fencing token (issue #221 finding 5): when set, only the claim-holding drain writes. */
  claimId?: string;
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      predecessorExternalSessionId: sql`CASE WHEN ${playgroundSessions.predecessorExternalSessionId} IS NULL AND ${playgroundSessions.externalSessionId} IS DISTINCT FROM ${input.externalSessionId} THEN ${playgroundSessions.externalSessionId} ELSE ${playgroundSessions.predecessorExternalSessionId} END`,
      externalSessionId: input.externalSessionId,
      continuationToken: input.continuationToken,
      resumeVia: null,
      streamIndex: 0,
      environmentId: input.target.environmentId,
      worldKey: input.target.environmentId,
      lastVersion: input.target.version,
      status: "running",
      lastEventAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(playgroundSessions.id, input.id),
        ne(playgroundSessions.status, "stopped"),
        isNull(playgroundSessions.archivedAt),
        input.claimId
          ? eq(playgroundSessions.turnClaimId, input.claimId)
          : undefined,
      ),
    );
}

/**
 * Advance a CHANNEL-HOMED session's cursor to the end of what eve already holds (WS1 park).
 * Nothing on harnesst's side ran those turns, so the cursor starts at 0 — but the human's
 * answer opens eve's stream at `startIndex = streamIndex`, so leaving it there would replay
 * the whole channel conversation into the browser as if it were part of the answering turn,
 * and the eve render (`loadPlaygroundEntriesFromEve` reads events 1..cursor) would show
 * nothing. Reads the tail from index 0 — it stops at the terminal event (`session.waiting`,
 * which is what a parked session emits) or on idle — and advances the cursor to what it saw,
 * guarded `stream_index < events.length` so a concurrent drain's larger cursor always wins.
 */
export async function advanceChannelHomedSessionCursor(input: {
  session: PlaygroundSession;
  target: Target;
  timeoutMs?: number;
}): Promise<PlaygroundSession> {
  if (!input.session.externalSessionId) return input.session;
  // A non-zero cursor is authoritative — an earlier park or a drain already advanced it.
  if (input.session.streamIndex > 0) return input.session;
  const { events } = await readEveSessionTail({
    baseUrl: input.target.url,
    sessionId: input.session.externalSessionId,
    startIndex: 0,
    timeoutMs: input.timeoutMs ?? 5_000,
  });
  if (events.length === 0) return input.session;
  await db
    .update(playgroundSessions)
    .set({ streamIndex: events.length, updatedAt: new Date() })
    .where(
      and(
        eq(playgroundSessions.id, input.session.id),
        lt(playgroundSessions.streamIndex, events.length),
      ),
    );
  return {
    ...input.session,
    streamIndex: Math.max(input.session.streamIndex, events.length),
  };
}

export async function markPlaygroundSessionStopped(input: {
  id: string;
  target?: Target | null;
  title?: string | null;
}): Promise<void> {
  await db
    .update(playgroundSessions)
    .set({
      // A stopped session may be settled with no reachable target; the row's stored
      // environment/version then stay as they were.
      environmentId: input.target?.environmentId,
      worldKey: input.target?.environmentId,
      lastVersion: input.target?.version,
      title: inferredTitleUpdate(input.title),
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

/**
 * Cap for replay reads that cannot trust a cursor: the succession prologue of a channel row
 * whose fire-and-forget heal never ran (stream_index still 0), and the predecessor half of
 * the succession stitch (the predecessor's cursor was reset when the row rebound).
 */
const UNCURSORED_EVENT_CAP = 1_000;
/**
 * A capped read asks for more events than eve holds, and eve never closes a session stream —
 * it just goes silent at the end. Stop after this much silence; a healthy instance streams
 * its whole log in milliseconds (see `tailBudgetsMs`), so this is an end-of-log detector,
 * not a latency allowance.
 */
const CAPPED_READ_IDLE_STOP_MS = 1_000;

export async function loadPlaygroundEntriesFromEve(input: {
  session: PlaygroundSession;
  target: Target;
  timeoutMs?: number;
  /**
   * Overrides the cursor as the read limit — for callers whose cursor is known-stale (a
   * channel row whose heal never ran reads under `UNCURSORED_EVENT_CAP` instead of trusting
   * a zero). Capped reads idle-stop at end-of-log rather than run out the full budget.
   */
  limit?: number;
}): Promise<ChatEntry[]> {
  if (!input.session.externalSessionId) return [];
  const limit = input.limit ?? input.session.streamIndex;
  const events =
    limit > 0
      ? await readEveSessionEvents({
          baseUrl: input.target.url,
          limit,
          sessionId: input.session.externalSessionId,
          timeoutMs: input.timeoutMs,
          idleStopMs:
            input.limit !== undefined ? CAPPED_READ_IDLE_STOP_MS : undefined,
        })
      : [];
  // Artifacts (#290) are transcript elements that never travelled through eve, so they are
  // folded in AFTER the projection — the event pipeline is untouched. Read even when there
  // are no events: an artifact published before the first event still has to appear.
  const published = await listArtifactsForSession(input.session.id);
  // Succession stitch (#288 3b): a succeeded conversation spans two eve sessions in the
  // same world store — prepend the predecessor's RAW events and project once; the
  // `session.started` epoch keeps the two sessions' turn keys apart (#261). Best-effort:
  // an unreadable predecessor renders the successor alone. Artifact anchors are ambiguous
  // across the two sessions' index spaces, so cards on a succeeded conversation trail the
  // transcript instead of risking a wrong inline placement.
  const predecessorId = input.session.predecessorExternalSessionId;
  if (predecessorId && predecessorId !== input.session.externalSessionId) {
    try {
      const prologue = await readEveSessionEvents({
        baseUrl: input.target.url,
        limit: UNCURSORED_EVENT_CAP,
        sessionId: predecessorId,
        timeoutMs: input.timeoutMs,
        idleStopMs: CAPPED_READ_IDLE_STOP_MS,
      });
      return mergeArtifactEntries(
        projectEventsToEntries([...prologue, ...events], input.session),
        published,
        [],
      );
    } catch {
      // Fall through to the successor-only render.
    }
  }
  // Eve's log is 1-based ("our index 1 is eve's first event"), and with the durable cache
  // gone artifact rows record plain eve-space indices — position+1 reconstructs them.
  const anchors = turnAnchorsFromEvents(
    events.map((event, index) => ({
      streamIndex: index + 1,
      type: event.type,
      data: event.data,
    })),
  );
  return mergeArtifactEntries(
    projectEventsToEntries(events, input.session),
    published,
    anchors,
  );
}

/**
 * What a tail read is allowed to spend waiting for eve — and why a settled session gets far less.
 *
 * Eve answers "nothing new" by saying NOTHING AT ALL. A stream request positioned past the
 * session's last event never sends so much as a response header; it just holds the socket open.
 * Measured against a live production instance on 2026-07-27: at the saved cursor, `code=000` after
 * 6s — no status line, no body — while the same endpoint asked for an index it HAS answers in 2ms
 * and streams in 3ms. So these numbers are not latency allowances. They are the flat price of a
 * no-op reconcile, and the loader pays it on the critical path of every page load.
 *
 * That is precisely what made the one `failed` session in a FOH list take ~3s to open, every time,
 * while its neighbours took 30ms: the reconcile fires for `running` OR `failed` rows, and a settled
 * row's cursor always sits past the end, so it always ran out the full pre-headers budget.
 *
 * A `running` row may have a live turn mid-flight worth waiting for, and keeps the generous budget.
 * A settled row is only being checked for stray history — a park the drain died before recording,
 * or a turn a CHANNEL ran without harnesst — and 300ms is two orders of magnitude above the
 * measured healthy response. A read that comes up empty writes nothing and advances no cursor, so
 * the worst case of being too impatient is that the next load tries again.
 */
const EVE_TAIL_IDLE_MS = 1_500;
const EVE_SETTLED_TAIL_MS = 300;

export function tailBudgetsMs(status: string): {
  connectMs: number;
  idleMs: number;
} {
  return status === "running"
    ? { connectMs: EVE_STREAM_CONNECT_TIMEOUT_MS, idleMs: EVE_TAIL_IDLE_MS }
    : { connectMs: EVE_SETTLED_TAIL_MS, idleMs: EVE_SETTLED_TAIL_MS };
}

export async function reconcilePlaygroundSessionFromEve(input: {
  session: PlaygroundSession;
  target: Target;
  timeoutMs?: number;
}): Promise<PlaygroundSession> {
  if (!input.session.externalSessionId) return input.session;
  const budgets = tailBudgetsMs(input.session.status);
  const tail = await readEveSessionTail({
    baseUrl: input.target.url,
    sessionId: input.session.externalSessionId,
    startIndex: input.session.streamIndex,
    timeoutMs: input.timeoutMs ?? budgets.idleMs,
    connectTimeoutMs: input.timeoutMs ?? budgets.connectMs,
  });
  if (tail.events.length === 0) return input.session;

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
  /**
   * When set, a read that goes this long without a fresh chunk returns what it has. A
   * cursor-exact read is ended by `limit` itself; a CAPPED read (limit above the real event
   * count) would otherwise hold eve's never-closing stream open for the whole `timeoutMs`.
   */
  idleStopMs?: number;
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
      let chunk: ReadableStreamReadResult<Uint8Array>;
      if (input.idleStopMs) {
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              idleTimer = setTimeout(
                () => reject(new Error("idle")),
                input.idleStopMs,
              );
            }),
          ]);
        } catch (error) {
          if ((error as Error).message === "idle") break;
          throw error;
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      } else {
        chunk = await reader.read();
      }
      const { done, value } = chunk;
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
  /** Pre-headers budget; see `tailBudgetsMs` for why a settled session gets a much shorter one. */
  connectTimeoutMs?: number;
}): Promise<{ events: EveStreamEvent[] }> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const fetchController = new AbortController();
  // Pre-headers budget only — the timer is cleared as soon as the response arrives, and the idle
  // race below bounds the body reads. See EVE_STREAM_CONNECT_TIMEOUT_MS for why this is short.
  const fetchTimer = setTimeout(
    () => fetchController.abort(),
    input.connectTimeoutMs ?? EVE_STREAM_CONNECT_TIMEOUT_MS,
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
  /** Turn id scoped to the emitting eve session — see `projectEventsToEntries`. */
  key: string;
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

/**
 * Projects a replayed eve event stream into the transcript entries the chat UI renders,
 * grouping every event of a turn (user message, assistant messages, tool steps, errors) into one
 * user + one assistant entry, in first-sighting order.
 *
 * Turn ids are only unique WITHIN the eve session that emitted them — eve restarts at `turn_0` per
 * session. A single replay normally holds one eve session, but the projection still scopes turn
 * identity by an epoch bumped on each `session.started`: it is free, and it keeps a stream that
 * does concatenate sessions from letting a later `turn_0` overwrite the first turn's user text
 * and glue its reply onto the opening exchange (#261).
 *
 * Exported for the projection unit tests.
 */
export function projectEventsToEntries(
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
  // Which eve session's log we are inside; see the doc comment above.
  let epoch = 0;

  const turnFor = (turnId: string | null): TurnProjection | null => {
    if (!turnId) return null;
    const key = `${epoch}:${turnId}`;
    let turn = turns.get(key);
    if (!turn) {
      turn = {
        key,
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
      turns.set(key, turn);
      ordered.push(turn);
    }
    return turn;
  };

  for (const event of events) {
    const data = event.data;
    // `session.started` is an eve session's first event — verified in prod: it appears exactly once
    // per eve session in the stream and never lands mid-turn — so bumping the epoch here,
    // before the turn is resolved, scopes the buckets with no schema change.
    if (event.type === "session.started") epoch += 1;
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
        // Strip all four wrappers: the model directive; a leading harnesst:context block (the
        // seeded prologue of a successor session); harnesst's own per-turn notes (the
        // assistant's checkout path and last sync's warnings); and, for a channel-homed turn,
        // eve's `<github_context>` envelope — the human opening a parked GitHub question from
        // the inbox should not have to read past delivery ids to find the sentence they were
        // sent here for.
        turn.userText = stripChannelContext(
          stripSystemNotes(stripSeedContext(stripModelDirective(raw))),
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
        id: `${turn.key}:user`,
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
        id: `${turn.key}:assistant`,
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
