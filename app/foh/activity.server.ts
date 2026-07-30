/**
 * Front of House activity feed — the server half (§5). Reads the four existing tables
 * (FOH sessions, delegations, runs, deployments) with parallel per-source queries, each
 * already cursor-cut (`at < before`), newest-first and limited, then hands the rows to the
 * pure projection in activity.ts. No new write path, no materialized table (PRD: only if the
 * projection provably can't keep up).
 *
 * Content policy (issue #221 finding 3) — the feed is viewer-aware:
 * - Back-of-house viewers (admin/owner) see everything, unredacted.
 * - Members see session events only for FOH sessions they can open — their own rows plus
 *   agent-opened ones (the same `created_by = viewer OR created_by IS NULL` predicate as
 *   `listFohSessionsForAgent`). Out-of-scope sessions are absent, not redacted, consistent
 *   with the guard's 404 probe philosophy.
 * - Members keep every run EVENT (existence/status/channel/agent are team activity) but the
 *   human-authored content — `metadata.input` (the triggering prompt) and `error` — is
 *   redacted unless the run belongs to an FOH session the member can open. Attribution goes
 *   through the observability `sessions` table: `runs.session_id` stores that table's
 *   internal id, and its `external_session_id` matches the FOH playground session's eve
 *   handle. Everything unattributable (assistant/playground/discord/github runs, other
 *   members' FOH runs) renders with input/error null.
 * - Delegation and deployment entries are unchanged: their text is agent-authored, and the
 *   delegation exchange expansion reads the agent-opened FOH session, which is team-wide.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import { user } from "~/db/auth-schema";
import { db } from "~/db/client.server";
import {
  agents,
  delegations,
  deployments,
  environments,
  playgroundSessions,
  releases,
  runs,
  runSteps,
  sessions,
} from "~/db/schema";
import {
  dropLeadingAsk,
  exchangeStepsFromEntries,
  projectActivity,
  summarizeExchangeSteps,
  type ActivityPage,
  type ExchangeStep,
} from "~/foh/activity";
import { loadPlaygroundEntriesFromCache } from "~/playground/sessions.server";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** `col < before`, or no condition on the first page (and() drops undefined). */
const cutoff = (col: AnyColumn, before?: Date): SQL | undefined =>
  before ? lt(col, before) : undefined;

export interface ActivityViewer {
  userId: string;
  /** Admin/owner (from `FohAccess.backOfHouse`): full, unredacted feed. */
  backOfHouse: boolean;
}

/** FOH sessions the viewer can open: their own rows plus agent-opened ones (D5). */
const memberSessionScope = (viewer: ActivityViewer): SQL | undefined =>
  or(
    eq(playgroundSessions.createdBy, viewer.userId),
    isNull(playgroundSessions.createdBy),
  );

export async function listTeamActivity(
  projectId: string,
  opts: { viewer: ActivityViewer; before?: Date; limit?: number },
): Promise<ActivityPage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const { before, viewer } = opts;
  const memberView = !viewer.backOfHouse;

  const [sessionRows, delegationRows, runRows, deploymentRows, agentRows] =
    await Promise.all([
      db
        .select({
          id: playgroundSessions.id,
          createdAt: playgroundSessions.createdAt,
          agentId: playgroundSessions.agentId,
          createdBy: playgroundSessions.createdBy,
          openedByAgentId: playgroundSessions.openedByAgentId,
          title: playgroundSessions.title,
        })
        .from(playgroundSessions)
        .where(
          and(
            eq(playgroundSessions.projectId, projectId),
            eq(playgroundSessions.surface, "foh"),
            // Archived conversations leave the feed with the list (#278): "session opened" is
            // an entry about a conversation, and the conversation is no longer there to open.
            isNull(playgroundSessions.archivedAt),
            memberView ? memberSessionScope(viewer) : undefined,
            cutoff(playgroundSessions.createdAt, before),
          ),
        )
        .orderBy(desc(playgroundSessions.createdAt))
        .limit(limit),
      db
        .select({
          id: delegations.id,
          startedAt: delegations.startedAt,
          finishedAt: delegations.finishedAt,
          status: delegations.status,
          error: delegations.error,
          fromAgentId: delegations.fromAgentId,
          toAgentId: delegations.toAgentId,
          runId: delegations.runId,
        })
        .from(delegations)
        .where(
          and(
            eq(delegations.projectId, projectId),
            cutoff(delegations.startedAt, before),
          ),
        )
        .orderBy(desc(delegations.startedAt))
        .limit(limit),
      db
        .select({
          id: runs.id,
          startedAt: runs.startedAt,
          status: runs.status,
          channel: runs.channel,
          agentId: runs.agentId,
          sessionId: runs.sessionId,
          error: runs.error,
          metadata: runs.metadata,
        })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), cutoff(runs.startedAt, before)))
        .orderBy(desc(runs.startedAt))
        .limit(limit),
      db
        .select({
          id: deployments.id,
          createdAt: deployments.createdAt,
          status: deployments.status,
          agentId: environments.agentId,
          version: releases.version,
        })
        .from(deployments)
        .innerJoin(environments, eq(deployments.environmentId, environments.id))
        .leftJoin(releases, eq(deployments.releaseId, releases.id))
        .where(
          and(
            eq(environments.projectId, projectId),
            cutoff(deployments.createdAt, before),
          ),
        )
        .orderBy(desc(deployments.createdAt))
        .limit(limit),
      db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.projectId, projectId)),
    ]);

  // Members keep run events but not their human-authored content unless the run belongs to
  // an FOH session they can open. `runs.session_id` holds the observability `sessions` row
  // id; that row shares its eve external_session_id with the FOH playground session, so the
  // join below resolves "runs whose session the viewer can open". Unattributable runs
  // (no session link, other surfaces, other members' sessions) get input/error nulled.
  let feedRuns = runRows;
  // Observability-session ids whose FOH content this member may read; `null` means
  // back-of-house (everything visible). Gates BOTH the run input/error redaction below AND
  // the actor attribution further down — otherwise #212's "Aaron messaged sam" headline would
  // leak, for a session F3 hides from this member, exactly the participant identity the
  // session-scoping was withholding.
  let memberVisibleSessionIds: Set<string> | null = null;
  if (memberView && runRows.length > 0) {
    const visibleSessionRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(
        playgroundSessions,
        and(
          eq(playgroundSessions.projectId, sessions.projectId),
          eq(playgroundSessions.externalSessionId, sessions.externalSessionId),
        ),
      )
      .where(
        and(
          eq(sessions.projectId, projectId),
          eq(playgroundSessions.surface, "foh"),
          isNotNull(playgroundSessions.externalSessionId),
          memberSessionScope(viewer),
        ),
      );
    memberVisibleSessionIds = new Set(visibleSessionRows.map((s) => s.id));
    const contentVisible = memberVisibleSessionIds;
    feedRuns = runRows.map((r) =>
      r.sessionId != null && contentVisible.has(r.sessionId)
        ? r
        : {
            ...r,
            error: null,
            // Keep the rest of metadata (delegationId drives delegation-run suppression).
            metadata: r.metadata ? { ...r.metadata, input: null } : r.metadata,
          },
    );
  }

  // Delegation ask text lives on the linked run's metadata (runId is best-effort — the
  // relay records it try/caught, so misses just render without a quote).
  const linkedRunIds = [
    ...new Set(
      delegationRows.map((d) => d.runId).filter((id): id is string => id != null),
    ),
  ];
  const askRows = linkedRunIds.length
    ? await db
        .select({ id: runs.id, metadata: runs.metadata })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), inArray(runs.id, linkedRunIds)))
    : [];
  const askByRunId = new Map(
    askRows.map((r) => [
      r.id,
      typeof r.metadata?.input === "string" ? r.metadata.input : null,
    ]),
  );

  // FOH-channel runs are a human messaging an agent — attribute them by walking the
  // observability session back to the FOH playground session's creator (§212: the feed
  // should read "Aaron messaged sam", not agent-first). Read-time join, so historical rows
  // resolve too; misses (null sessionId, reaped session) just fall back to agent-first copy.
  const fohRunSessionIds = [
    ...new Set(
      runRows
        .filter((r) => r.channel === "foh" && r.sessionId != null)
        .map((r) => r.sessionId as string),
    ),
  ];
  const actorRows = fohRunSessionIds.length
    ? await db
        .select({ sessionId: sessions.id, createdBy: playgroundSessions.createdBy })
        .from(sessions)
        .innerJoin(
          playgroundSessions,
          and(
            eq(playgroundSessions.externalSessionId, sessions.externalSessionId),
            eq(playgroundSessions.projectId, projectId),
            eq(playgroundSessions.surface, "foh"),
          ),
        )
        .where(
          and(eq(sessions.projectId, projectId), inArray(sessions.id, fohRunSessionIds)),
        )
    : [];
  const creatorBySessionId = new Map(
    actorRows.map((r) => [r.sessionId, r.createdBy]),
  );

  const openerIds = [
    ...new Set(
      [
        ...sessionRows.map((s) => s.createdBy),
        ...actorRows.map((r) => r.createdBy),
      ].filter((id): id is string => id != null),
    ),
  ];
  const userRows = openerIds.length
    ? await db
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(inArray(user.id, openerIds))
    : [];
  const userNames = new Map(userRows.map((u) => [u.id, u.name]));

  const actorByRunId = new Map(
    runRows.map((r) => {
      // A member only learns who messaged an agent for runs whose content they may read; for
      // runs F3 redacts, the actor is withheld too (issue #221 finding 3).
      const contentVisible =
        memberVisibleSessionIds === null ||
        (r.sessionId != null && memberVisibleSessionIds.has(r.sessionId));
      if (!contentVisible) return [r.id, null];
      const createdBy =
        r.sessionId != null ? creatorBySessionId.get(r.sessionId) : null;
      return [r.id, createdBy != null ? (userNames.get(createdBy) ?? null) : null];
    }),
  );

  return projectActivity(
    {
      sessions: sessionRows,
      delegations: delegationRows,
      runs: feedRuns,
      deployments: deploymentRows,
    },
    {
      limit,
      agentNames: new Map(agentRows.map((a) => [a.id, a.name])),
      userNames,
      askByRunId,
      actorByRunId,
    },
  );
}

export interface DelegationExchange {
  delegationId: string;
  status: string;
  error: string | null;
  fromAgentName: string | null;
  toAgentName: string | null;
  startedAt: string;
  /** Only for settled rows (a waiting row's finishedAt is park-time bookkeeping, WP4). */
  finishedAt: string | null;
  /** The ask, from the linked run's metadata; null when the run never landed. */
  ask: string | null;
  /**
   * The exchange transcript. Relay-parked delegations read the agent-opened FOH session's
   * cached events (the delegate's real transcript); others fall back to the linked run's
   * steps. Empty when neither source exists. The leading user message is deduped against
   * `ask` (the header already quotes it).
   */
  steps: ExchangeStep[];
}

/** The full sam → ivy exchange behind one delegation entry (§6 legibility). */
export async function getDelegationExchange(
  projectId: string,
  delegationId: string,
): Promise<DelegationExchange | null> {
  const [row] = await db
    .select()
    .from(delegations)
    .where(and(eq(delegations.id, delegationId), eq(delegations.projectId, projectId)))
    .limit(1);
  if (!row) return null;

  const agentIds = [row.fromAgentId, row.toAgentId].filter(
    (id): id is string => id != null,
  );
  const agentRows = agentIds.length
    ? await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  const names = new Map(agentRows.map((a) => [a.id, a.name]));

  let ask: string | null = null;
  let steps: ExchangeStep[] = [];
  const run = row.runId
    ? (
        await db
          .select({ id: runs.id, metadata: runs.metadata })
          .from(runs)
          .where(and(eq(runs.id, row.runId), eq(runs.projectId, projectId)))
          .limit(1)
      )[0]
    : undefined;
  if (run) {
    ask = typeof run.metadata?.input === "string" ? run.metadata.input : null;
  }

  // Relay parking opens an agent-side FOH session for the delegate; when it exists, ITS
  // cached events are the real exchange (parked question, human answer, final reply) — the
  // linked run's steps then only hold the inbound ask + an empty model beat. Non-parking
  // delegations have no such session and their run_steps do carry the exchange.
  const [fohSession] = await db
    .select()
    .from(playgroundSessions)
    .where(
      and(
        eq(playgroundSessions.delegationId, row.id),
        eq(playgroundSessions.projectId, projectId),
      ),
    )
    .limit(1);
  if (fohSession) {
    steps = exchangeStepsFromEntries(await loadPlaygroundEntriesFromCache(fohSession));
  } else if (run) {
    const stepRows = await db
      .select({
        seq: runSteps.seq,
        type: runSteps.type,
        toolName: runSteps.toolName,
        isError: runSteps.isError,
        data: runSteps.data,
      })
      .from(runSteps)
      .where(eq(runSteps.runId, run.id))
      .orderBy(asc(runSteps.seq));
    steps = summarizeExchangeSteps(stepRows);
  }
  steps = dropLeadingAsk(steps, ask);

  const settled = row.status === "completed" || row.status === "failed";
  return {
    delegationId: row.id,
    status: row.status,
    error: row.error,
    fromAgentName: row.fromAgentId != null ? (names.get(row.fromAgentId) ?? null) : null,
    toAgentName: row.toAgentId != null ? (names.get(row.toAgentId) ?? null) : null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: settled && row.finishedAt ? row.finishedAt.toISOString() : null,
    ask,
    steps,
  };
}
