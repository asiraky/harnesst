/**
 * Runs store + ingest (Observe pillar, M3 — PRD §7.6, ARCH §3.7).
 *
 * Normalizes telemetry (eve OTel spans + Workflow event log) into Session → Run → Step. BYO
 * instances POST here with a per-project ingest token; managed instances are co-located but
 * use the same path. The system prompt is reconstructed from the Run's Release commit (link,
 * not snapshot); user input, tool I/O, tokens, and timing are runtime data and are stored.
 */
import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";

import { hashEdnToken, mintEdnToken } from "~/auth/edn-token.server";
import { db } from "~/db/client.server";
import {
  agents,
  deployments,
  ingestTokens,
  releases,
  runSteps,
  runs,
  sessions,
} from "~/db/schema";
import { redactSecrets } from "~/observability/capture.server";

type IngestDb = Pick<typeof db, "delete" | "insert" | "select">;

/** Mint a project ingest token. Returns the plaintext ONCE; only the hash is stored. */
export async function createIngestToken(projectId: string, name: string) {
  const token = mintEdnToken();
  await db
    .insert(ingestTokens)
    .values({ projectId, name, tokenHash: hashEdnToken(token) });
  return token;
}

export function listIngestTokens(projectId: string) {
  return db
    .select({
      id: ingestTokens.id,
      name: ingestTokens.name,
      createdAt: ingestTokens.createdAt,
      lastUsedAt: ingestTokens.lastUsedAt,
    })
    .from(ingestTokens)
    .where(eq(ingestTokens.projectId, projectId))
    .orderBy(desc(ingestTokens.createdAt));
}

/** Resolve a Bearer ingest token to its project id, or null. Bumps lastUsedAt on hit. */
export async function resolveIngestToken(token: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(ingestTokens)
    .where(eq(ingestTokens.tokenHash, hashEdnToken(token)))
    .limit(1);
  if (!row) return null;
  await db
    .update(ingestTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(ingestTokens.id, row.id));
  return row.projectId;
}

/**
 * One ordered step of a run. This is the additive BYO ingest contract — new `data` fields are
 * always optional and old runs with thin/absent data must keep rendering.
 *
 * Canonical `data` shape per step `type` (all fields optional; every consumer degrades to what
 * exists). Rich fields are size-capped at ingest and passed through a secret-redaction pass:
 *   - `tool_call`:   `{ input?, output?, summary?, exitCode?, truncated? }`
 *                    — `input`/`output` are the FULL tool payloads (any JSON); `summary` is a
 *                      one-line hint; `exitCode` for bash-style tools; `truncated` when capped.
 *   - `message`:     `{ role: "user" | "assistant", text, truncated? }`
 *                    — role:user leads a run (the triggering input); role:assistant is a reply,
 *                      the final one being the run's answer.
 *   - `reasoning`:   `{ text, truncated? }` — model thinking as prose (BYO-only; the playground
 *                      stream carries no reasoning text, so it never emits this).
 *   - `model_call`:  `{ message?, code?, details? }` — only populated on error (failure detail);
 *                      no request messages exist in the eve stream to capture.
 */
export interface IngestStep {
  seq: number;
  type: "model_call" | "tool_call" | "reasoning" | "message";
  model?: string;
  toolName?: string;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  isError?: boolean;
  approvalGated?: boolean;
  data?: Record<string, unknown>;
  startedAt?: string;
}

export interface IngestPayload {
  externalRunId: string;
  deploymentId?: string;
  releaseId?: string;
  channel?: string;
  status?: "running" | "completed" | "failed";
  tokensInput?: number;
  tokensOutput?: number;
  wallClockMs?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  metadata?: Record<string, unknown>;
  session?: { externalSessionId?: string; trigger?: string; channel?: string };
  steps?: IngestStep[];
}

/**
 * The roster member a run belongs to: the release's agent when the payload carries one,
 * else the sole member (single-agent repos). Multi-member runs without a release stay
 * unattributed (null) rather than guessing.
 */
async function resolveRunAgent(
  client: IngestDb,
  projectId: string,
  releaseId: string | undefined,
): Promise<string | null> {
  if (releaseId) {
    const [rel] = await client
      .select({ agentId: releases.agentId })
      .from(releases)
      .where(eq(releases.id, releaseId))
      .limit(1);
    if (rel) return rel.agentId;
  }
  const roster = await client
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.projectId, projectId))
    .limit(2);
  return roster.length === 1 ? roster[0].id : null;
}

/** Shared ingest implementation so a managed start can hold its deployment lock throughout. */
async function ingestRunWith(
  client: IngestDb,
  projectId: string,
  p: IngestPayload,
): Promise<void> {
  const agentId = await resolveRunAgent(client, projectId, p.releaseId);
  let sessionId: string | null = null;
  if (p.session?.externalSessionId) {
    const [s] = await client
      .insert(sessions)
      .values({
        projectId,
        agentId,
        externalSessionId: p.session.externalSessionId,
        trigger: p.session.trigger ?? null,
        channel: p.session.channel ?? null,
      })
      .onConflictDoUpdate({
        target: [sessions.projectId, sessions.externalSessionId],
        set: { trigger: p.session.trigger ?? null },
      })
      .returning();
    sessionId = s.id;
  }

  // Run-level fields carry sensitive material too — metadata.input is the raw user message
  // (rendered directly by the transcript) and tool errors can embed tokens. Same chokepoint
  // as step data, so BOTH producers (playground + BYO) are covered.
  const error = p.error != null ? (redactSecrets(p.error) as string) : null;
  const metadata =
    (redactSecrets(p.metadata ?? {}) as Record<string, unknown>) ?? {};

  const incomingStatus = p.status ?? "running";
  const [run] = await client
    .insert(runs)
    .values({
      projectId,
      agentId,
      deploymentId: p.deploymentId ?? null,
      releaseId: p.releaseId ?? null,
      sessionId,
      externalRunId: p.externalRunId,
      channel: p.channel ?? null,
      status: incomingStatus,
      tokensInput: p.tokensInput ?? null,
      tokensOutput: p.tokensOutput ?? null,
      wallClockMs: p.wallClockMs ?? null,
      error,
      metadata,
      ...(p.startedAt ? { startedAt: new Date(p.startedAt) } : {}),
      finishedAt: p.finishedAt ? new Date(p.finishedAt) : null,
    })
    .onConflictDoUpdate({
      target: [runs.projectId, runs.externalRunId],
      // A duplicated/replayed start may refresh a still-running row, but it can never resurrect
      // a run that a completion or lifecycle reconciliation has already made terminal.
      ...(incomingStatus === "running"
        ? { setWhere: eq(runs.status, "running") }
        : {}),
      set: {
        sessionId,
        agentId,
        deploymentId: p.deploymentId ?? null,
        releaseId: p.releaseId ?? null,
        status: incomingStatus,
        tokensInput: p.tokensInput ?? null,
        tokensOutput: p.tokensOutput ?? null,
        wallClockMs: p.wallClockMs ?? null,
        error,
        finishedAt: p.finishedAt ? new Date(p.finishedAt) : null,
      },
    })
    .returning();

  // A terminal row rejected a duplicate `running` update via setWhere. Its transcript and
  // terminal fields are authoritative, so there is intentionally nothing else to mutate.
  if (!run) return;

  if (p.steps && p.steps.length > 0) {
    // Replace steps for idempotency (a later event carries the full step list).
    await client.delete(runSteps).where(eq(runSteps.runId, run.id));
    await client.insert(runSteps).values(
      p.steps.map((st) => ({
        runId: run.id,
        seq: st.seq,
        type: st.type,
        model: st.model ?? null,
        toolName: st.toolName ?? null,
        tokensInput: st.tokensInput ?? null,
        tokensOutput: st.tokensOutput ?? null,
        durationMs: st.durationMs ?? null,
        isError: st.isError ?? false,
        approvalGated: st.approvalGated ?? false,
        // Redact obvious credentials for BOTH producers (playground + BYO) at this chokepoint.
        data: (redactSecrets(st.data ?? {}) as Record<string, unknown>) ?? {},
        startedAt: st.startedAt ? new Date(st.startedAt) : null,
      })),
    );
  }
}

/** Ingest one run (+ optional session + steps) for a project. Idempotent per externalRunId. */
export async function ingestRun(
  projectId: string,
  p: IngestPayload,
): Promise<void> {
  await ingestRunWith(db, projectId, p);
}

/**
 * Persist a managed `running` row only while its deployment is still live. The shared row lock
 * coordinates with deployment stop updates: a start either commits before the stop (and the
 * following reconciliation catches it) or observes the stopped state and inserts nothing.
 */
export async function ingestRunStart(
  projectId: string,
  p: IngestPayload & { deploymentId: string; status: "running" },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [deployment] = await tx
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, p.deploymentId))
      .for("share");
    if (deployment?.status !== "live") return false;
    await ingestRunWith(tx, projectId, p);
    return true;
  });
}

export type RunSort = "newest" | "slowest" | "tokens" | "errors";

/** Faceted run-list filter — all composable, all optional. Drives list + stats + sparkline. */
export interface RunFilter {
  releaseId?: string;
  agentId?: string;
  status?: "completed" | "failed" | "running";
  channel?: string;
  /** Lower bound on startedAt (the time-range facet: 24h / 7d / 30d). */
  since?: Date;
  sort?: RunSort;
}

/** WHERE conditions shared by the list + the aggregate stats so they see the same window. */
function runConditions(projectId: string, filter: RunFilter): SQL[] {
  const conditions: SQL[] = [eq(runs.projectId, projectId)];
  if (filter.releaseId) conditions.push(eq(runs.releaseId, filter.releaseId));
  if (filter.agentId) conditions.push(eq(runs.agentId, filter.agentId));
  if (filter.status) conditions.push(eq(runs.status, filter.status));
  if (filter.channel) conditions.push(eq(runs.channel, filter.channel));
  if (filter.since) conditions.push(gte(runs.startedAt, filter.since));
  return conditions;
}

/** Run list for a project — faceted, sorted, capped. Member-scoped via `filter.agentId`. */
export function listRuns(projectId: string, filter: RunFilter = {}) {
  const where = and(...runConditions(projectId, filter));
  const totalTokens = sql<number>`coalesce(${runs.tokensInput}, 0) + coalesce(${runs.tokensOutput}, 0)`;
  const orderBy: SQL[] =
    filter.sort === "slowest"
      ? [sql`${runs.wallClockMs} desc nulls last`]
      : filter.sort === "tokens"
        ? [sql`${totalTokens} desc`]
        : filter.sort === "errors"
          ? [sql`(${runs.status} = 'failed') desc`, desc(runs.startedAt)]
          : [desc(runs.startedAt)];
  return db
    .select({
      id: runs.id,
      externalRunId: runs.externalRunId,
      channel: runs.channel,
      status: runs.status,
      tokensInput: runs.tokensInput,
      tokensOutput: runs.tokensOutput,
      wallClockMs: runs.wallClockMs,
      error: runs.error,
      metadata: runs.metadata,
      startedAt: runs.startedAt,
      version: releases.version,
    })
    .from(runs)
    .leftJoin(releases, eq(runs.releaseId, releases.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(200);
}

export interface RunStats {
  total: number;
  completed: number;
  failed: number;
  running: number;
  /** Fraction 0..1 of settled runs that completed (null when none settled). */
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  tokens: number;
}

/**
 * Aggregate health for the CURRENT filter window, computed in SQL over ALL matching runs (not
 * just the listed page): success rate, error count, p50/p95 wall-clock, total tokens. Powers
 * the list view's health header and the compare-by-version baseline.
 */
export async function runStats(
  projectId: string,
  filter: RunFilter = {},
): Promise<RunStats> {
  const where = and(...runConditions(projectId, filter));
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${runs.status} = 'completed')::int`,
      failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
      running: sql<number>`count(*) filter (where ${runs.status} = 'running')::int`,
      p50: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${runs.wallClockMs})`,
      p95: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${runs.wallClockMs})`,
      tokens: sql<number>`(coalesce(sum(${runs.tokensInput}), 0) + coalesce(sum(${runs.tokensOutput}), 0))::int`,
    })
    .from(runs)
    .where(where);
  const settled = (row?.completed ?? 0) + (row?.failed ?? 0);
  return {
    total: row?.total ?? 0,
    completed: row?.completed ?? 0,
    failed: row?.failed ?? 0,
    running: row?.running ?? 0,
    successRate: settled > 0 ? (row?.completed ?? 0) / settled : null,
    p50Ms: row?.p50 != null ? Math.round(row.p50) : null,
    p95Ms: row?.p95 != null ? Math.round(row.p95) : null,
    tokens: row?.tokens ?? 0,
  };
}

/** Distinct channel values for a project's runs (member-scoped) — powers the channel facet. */
export async function listRunChannels(
  projectId: string,
  agentId?: string,
): Promise<string[]> {
  const conditions: SQL[] = [eq(runs.projectId, projectId)];
  if (agentId) conditions.push(eq(runs.agentId, agentId));
  const rows = await db
    .selectDistinct({ channel: runs.channel })
    .from(runs)
    .where(and(...conditions));
  return rows
    .map((r) => r.channel)
    .filter((c): c is string => c != null && c.length > 0)
    .sort();
}

/** The harnesst run id for a `(project, externalRunId)` pair, or null (delegation linking). */
export async function getRunIdByExternal(
  projectId: string,
  externalRunId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.externalRunId, externalRunId)))
    .limit(1);
  return row?.id ?? null;
}

/** One run with its ordered steps (the transcript), scoped to the project. */
export async function getRunWithSteps(projectId: string, runId: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.id, runId)))
    .limit(1);
  if (!run) return null;
  const steps = await db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, run.id))
    .orderBy(runSteps.seq);
  const release = run.releaseId
    ? (await db.select().from(releases).where(eq(releases.id, run.releaseId)).limit(1))[0]
    : undefined;
  return { run, steps, release };
}
