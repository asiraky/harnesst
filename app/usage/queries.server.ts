/**
 * Read queries behind the usage views (issue #418). Every query is bounded by an indexed key and
 * the time window:
 *   - runs by (project_id, started_at) or (agent_id, started_at);
 *   - run_steps only through a run id (run_steps_run_seq_idx), and only scalar columns, except the
 *     single call the call page opens;
 *   - gateway_calls by (org_id | connection_id, started_at), or (session_id, turn_id, step_index)
 *     for one run.
 * Callers pass project ids they have already authorised; every query also pins the org or project.
 */
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  agents,
  codexRateLimitSamples,
  codexRateLimits,
  modelProviderConnections,
  projects,
  runs,
  sessions,
} from "~/db/schema";
import type { BurnHour, RunAggregate } from "./rollup";
import type { TraceGatewayRow, TraceStepRow, WithheldMark } from "./trace";
import { parseToolRepeats, type RunSignal, type StepSignal } from "./warnings";

type Row = Record<string, unknown>;

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/** Raw rows come back with numerics as strings and timestamps as driver strings. */
const n = (v: unknown): number | null =>
  v == null ? null : typeof v === "number" ? v : Number(v);
const n0 = (v: unknown): number => n(v) ?? 0;
const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const str = (v: unknown): string | null => (v == null ? null : String(v));

/** A timestamp parameter (the raw driver does not map Date for untyped params). */
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

/** Run totals per (repository, agent) over the window. */
export async function runAggregates(input: {
  projectIds: string[];
  since: Date;
  agentId?: string;
}): Promise<RunAggregate[]> {
  if (input.projectIds.length === 0) return [];
  const agentFilter = input.agentId ? sql`and r.agent_id = ${input.agentId}` : sql``;
  const result = await rows<Row>(sql`
    select r.project_id, r.agent_id,
      count(*)::int as runs,
      count(*) filter (where r.status = 'failed')::int as failed,
      sum(r.tokens_input)::float8 as input,
      sum(r.tokens_input) filter (where r.tokens_cached_input is not null)::float8 as input_cache,
      sum(r.tokens_cached_input)::float8 as cached,
      sum(r.tokens_output)::float8 as output,
      sum(r.cost_usd)::float8 as cost,
      max(r.peak_context_tokens)::int as peak,
      sum(r.compaction_count)::int as compactions,
      count(*) filter (where r.compaction_count > 0)::int as compacted,
      coalesce(sum(c.calls), 0)::int as calls
    from runs r
    left join lateral (
      select count(*) as calls from run_steps s where s.run_id = r.id and s.type = 'model_call'
    ) c on true
    where r.project_id in (${idList(input.projectIds)})
      and r.started_at >= ${ts(input.since)}
      ${agentFilter}
    group by r.project_id, r.agent_id
  `);
  return result.map((r) => ({
    projectId: String(r.project_id),
    agentId: str(r.agent_id),
    runs: n0(r.runs),
    failed: n0(r.failed),
    input: n(r.input),
    inputWithCacheInfo: n(r.input_cache),
    cached: n(r.cached),
    output: n(r.output),
    costUsd: n(r.cost),
    peakContext: n(r.peak),
    compactions: n(r.compactions),
    compactedRuns: n0(r.compacted),
    calls: n0(r.calls),
  }));
}

/** Input per agent per UTC day, for the team page's stacked bars. */
export async function dailyInputByAgent(projectId: string, since: Date) {
  const result = await rows<Row>(sql`
    select agent_id, date_trunc('day', started_at at time zone 'UTC') as day,
      sum(tokens_input)::float8 as input, count(*)::int as runs
    from runs
    where project_id = ${projectId} and started_at >= ${ts(since)}
    group by 1, 2
  `);
  return result.map((r) => ({
    agentId: str(r.agent_id),
    // `day` is a UTC wall time without zone; pin it to UTC.
    day: `${(r.day instanceof Date ? r.day.toISOString() : String(r.day)).slice(0, 10)}T00:00:00.000Z`,
    input: n0(r.input),
    runs: n0(r.runs),
  }));
}

export interface RunRow {
  id: string;
  projectId: string;
  agentId: string | null;
  externalRunId: string | null;
  status: string;
  channel: string | null;
  startedAt: string;
  finishedAt: string | null;
  input: number | null;
  cached: number | null;
  output: number | null;
  costUsd: number | null;
  peakContext: number | null;
  compactions: number | null;
  wallClockMs: number | null;
  settledBy: string | null;
  calls: number;
  toolCalls: number;
  toolErrors: number;
  callErrors: number;
  compactionsRequested: number;
  window: number | null;
  medianContext: number | null;
}

/**
 * Runs with their per-run step counts, newest first. `orderBy: "input"` returns the heaviest
 * runs instead. Step counts come from scalar columns only.
 */
export async function listRunRows(input: {
  projectIds: string[];
  since: Date;
  agentId?: string;
  limit: number;
  offset?: number;
  orderBy?: "recent" | "input";
}): Promise<RunRow[]> {
  if (input.projectIds.length === 0) return [];
  const agentFilter = input.agentId ? sql`and r.agent_id = ${input.agentId}` : sql``;
  const order =
    input.orderBy === "input"
      ? sql`r.tokens_input desc nulls last, r.started_at desc`
      : sql`r.started_at desc`;
  // Pick the page of runs first, then count steps for those runs only.
  const result = await rows<Row>(sql`
    with picked as materialized (
      select r.* from runs r
      where r.project_id in (${idList(input.projectIds)})
        and r.started_at >= ${ts(input.since)}
        ${agentFilter}
      order by ${order}
      limit ${input.limit} offset ${input.offset ?? 0}
    )
    select r.id, r.project_id, r.agent_id, r.external_run_id, r.status, r.channel,
      r.started_at, r.finished_at, r.tokens_input, r.tokens_cached_input, r.tokens_output,
      r.cost_usd, r.peak_context_tokens, r.compaction_count, r.wall_clock_ms,
      r.metadata->>'settledBy' as settled_by,
      st.calls, st.tool_calls, st.tool_errors, st.call_errors, st.compactions_requested,
      st.context_window, st.median_ctx
    from picked r
    left join lateral (
      select
        count(*) filter (where s.type = 'model_call')::int as calls,
        count(*) filter (where s.type = 'tool_call')::int as tool_calls,
        count(*) filter (where s.type = 'tool_call' and s.is_error)::int as tool_errors,
        count(*) filter (where s.type = 'model_call' and s.is_error)::int as call_errors,
        count(*) filter (where s.type = 'compaction')::int as compactions_requested,
        max(s.context_window)::int as context_window,
        (percentile_cont(0.5) within group (order by s.tokens_input)
          filter (where s.type = 'model_call'))::float8 as median_ctx
      from run_steps s where s.run_id = r.id
    ) st on true
    order by ${order}
  `);
  return result.map((r) => ({
    id: String(r.id),
    projectId: String(r.project_id),
    agentId: str(r.agent_id),
    externalRunId: str(r.external_run_id),
    status: String(r.status),
    channel: str(r.channel),
    startedAt: iso(r.started_at)!,
    finishedAt: iso(r.finished_at),
    input: n(r.tokens_input),
    cached: n(r.tokens_cached_input),
    output: n(r.tokens_output),
    costUsd: n(r.cost_usd),
    peakContext: n(r.peak_context_tokens),
    compactions: n(r.compaction_count),
    wallClockMs: n(r.wall_clock_ms),
    settledBy: str(r.settled_by),
    calls: n0(r.calls),
    toolCalls: n0(r.tool_calls),
    toolErrors: n0(r.tool_errors),
    callErrors: n0(r.call_errors),
    compactionsRequested: n0(r.compactions_requested),
    window: n(r.context_window),
    medianContext: n(r.median_ctx),
  }));
}

export interface ToolRank {
  toolName: string;
  calls: number;
  tokens: number | null;
  avgTokens: number | null;
  maxTokens: number | null;
  errors: number;
  withheld: number;
}

/** Tools ranked by the tokens their results fed back into the context. */
export async function toolRanking(input: {
  projectId: string;
  agentId: string;
  since: Date;
}): Promise<ToolRank[]> {
  // `data ? 'withheld'` reads the whole jsonb; only a large result can have been withheld, so the
  // cheap size test runs first and keeps the scan off the payloads of ordinary results.
  const result = await rows<Row>(sql`
    select coalesce(s.tool_name, '(unnamed)') as tool_name,
      count(*)::int as calls,
      sum(s.result_tokens)::float8 as tokens,
      avg(s.result_tokens)::float8 as avg_tokens,
      max(s.result_tokens)::int as max_tokens,
      count(*) filter (where s.is_error)::int as errors,
      count(*) filter (where s.result_tokens >= 1000 and s.data ? 'withheld')::int as withheld
    from runs r
    join run_steps s on s.run_id = r.id
    where r.project_id = ${input.projectId} and r.agent_id = ${input.agentId}
      and r.started_at >= ${ts(input.since)} and s.type = 'tool_call'
    group by 1
    order by sum(s.result_tokens) desc nulls last, count(*) desc
    limit 25
  `);
  return result.map((r) => ({
    toolName: String(r.tool_name),
    calls: n0(r.calls),
    tokens: n(r.tokens),
    avgTokens: n(r.avg_tokens),
    maxTokens: n(r.max_tokens),
    errors: n0(r.errors),
    withheld: n0(r.withheld),
  }));
}

/** Subagent child runs of one agent, by subagent name. */
export async function subagentUsage(input: {
  projectId: string;
  agentId: string;
  since: Date;
}) {
  const result = await rows<Row>(sql`
    select s.subagent_name as name, count(distinct r.id)::int as runs, count(*)::int as calls,
      sum(s.tokens_input)::float8 as input, max(s.tokens_input)::int as peak
    from runs r
    join run_steps s on s.run_id = r.id
    where r.project_id = ${input.projectId} and r.agent_id = ${input.agentId}
      and r.started_at >= ${ts(input.since)}
      and s.type = 'model_call' and s.subagent_name is not null
    group by 1
    order by 4 desc nulls last
  `);
  return result.map((r) => ({
    name: String(r.name),
    runs: n0(r.runs),
    calls: n0(r.calls),
    input: n(r.input),
    peak: n(r.peak),
  }));
}

/** Agent names (members and the assistant) for a set of repositories. */
export async function agentNames(projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, { name: string; projectId: string }>();
  const list = await db
    .select({ id: agents.id, name: agents.name, projectId: agents.projectId })
    .from(agents)
    .where(inArray(agents.projectId, projectIds));
  return new Map(list.map((a) => [a.id, { name: a.name, projectId: a.projectId }]));
}

// ---------------------------------------------------------------------------------------------
// Connections (workspace admins only: callers gate)
// ---------------------------------------------------------------------------------------------

export async function listConnections(orgId: string) {
  return db
    .select({
      id: modelProviderConnections.id,
      provider: modelProviderConnections.provider,
      label: modelProviderConnections.label,
      accountEmail: modelProviderConnections.accountEmail,
      status: modelProviderConnections.status,
    })
    .from(modelProviderConnections)
    .where(eq(modelProviderConnections.orgId, orgId));
}

export interface PlanHeadroom {
  primaryUsedPercent: number | null;
  primaryWindowMinutes: number | null;
  primaryResetsAt: string | null;
  secondaryUsedPercent: number | null;
  secondaryWindowMinutes: number | null;
  secondaryResetsAt: string | null;
  observedAt: string;
}

const headroomOf = (r: typeof codexRateLimits.$inferSelect): PlanHeadroom => ({
  primaryUsedPercent: r.primaryUsedPercent,
  primaryWindowMinutes: r.primaryWindowMinutes,
  primaryResetsAt: r.primaryResetsAt?.toISOString() ?? null,
  secondaryUsedPercent: r.secondaryUsedPercent,
  secondaryWindowMinutes: r.secondaryWindowMinutes,
  secondaryResetsAt: r.secondaryResetsAt?.toISOString() ?? null,
  observedAt: r.observedAt.toISOString(),
});

export async function latestHeadroom(orgId: string): Promise<Map<string, PlanHeadroom>> {
  const list = await db.select().from(codexRateLimits).where(eq(codexRateLimits.orgId, orgId));
  return new Map(list.map((r) => [r.connectionId, headroomOf(r)]));
}

export interface ConnectionTotals {
  connectionId: string;
  calls: number;
  input: number | null;
  cached: number | null;
  /** Input and calls on rows that report cached tokens: the base for a cache hit rate. */
  cacheInput: number | null;
  cacheCalls: number;
  output: number | null;
  reasoning: number | null;
  rateLimited: number;
  errors: number;
  lastAt: string | null;
  lastRateLimitedAt: string | null;
  planType: string | null;
}

export async function connectionTotals(orgId: string, since: Date): Promise<ConnectionTotals[]> {
  const result = await rows<Row>(sql`
    select connection_id, count(*)::int as calls,
      sum(input_tokens)::float8 as input, sum(cached_input_tokens)::float8 as cached,
      sum(input_tokens) filter (where cached_input_tokens is not null)::float8 as cache_input,
      count(*) filter (where cached_input_tokens is not null)::int as cache_calls,
      sum(output_tokens)::float8 as output, sum(reasoning_tokens)::float8 as reasoning,
      count(*) filter (where http_status = 429)::int as limited,
      count(*) filter (where http_status >= 400 and http_status <> 429)::int as errors,
      max(started_at) as last_at,
      max(started_at) filter (where http_status = 429) as last_limited_at,
      (array_agg(plan_type order by started_at desc) filter (where plan_type is not null))[1] as plan_type
    from gateway_calls
    where org_id = ${orgId} and started_at >= ${ts(since)}
    group by connection_id
  `);
  return result.map((r) => ({
    connectionId: String(r.connection_id),
    calls: n0(r.calls),
    input: n(r.input),
    cached: n(r.cached),
    cacheInput: n(r.cache_input),
    cacheCalls: n0(r.cache_calls),
    output: n(r.output),
    reasoning: n(r.reasoning),
    rateLimited: n0(r.limited),
    errors: n0(r.errors),
    lastAt: iso(r.last_at),
    lastRateLimitedAt: iso(r.last_limited_at),
    planType: str(r.plan_type),
  }));
}

/** Input per hour per (repository, agent label) on one connection. */
export async function connectionBurn(
  orgId: string,
  connectionId: string,
  since: Date,
): Promise<BurnHour[]> {
  const result = await rows<Row>(sql`
    select date_trunc('hour', started_at) as hour, project_id, agent_name,
      count(*)::int as calls, coalesce(sum(input_tokens), 0)::float8 as input,
      sum(cached_input_tokens)::float8 as cached,
      coalesce(sum(output_tokens), 0)::float8 as output,
      count(*) filter (where http_status = 429)::int as limited
    from gateway_calls
    where connection_id = ${connectionId} and org_id = ${orgId} and started_at >= ${ts(since)}
    group by 1, 2, 3
  `);
  return result.map((r) => ({
    hour: iso(r.hour)!,
    projectId: str(r.project_id),
    agentName: str(r.agent_name),
    calls: n0(r.calls),
    input: n0(r.input),
    cached: n(r.cached),
    output: n0(r.output),
    rateLimited: n0(r.limited),
  }));
}

/** Plan samples in the window, plus the last one before it so the line starts at the edge. */
export async function headroomSamples(orgId: string, connectionId: string, since: Date) {
  const scope = and(
    eq(codexRateLimitSamples.orgId, orgId),
    eq(codexRateLimitSamples.connectionId, connectionId),
  );
  const [inWindow, before] = await Promise.all([
    db
      .select()
      .from(codexRateLimitSamples)
      .where(and(scope, gte(codexRateLimitSamples.observedAt, since)))
      .orderBy(codexRateLimitSamples.observedAt)
      .limit(5000),
    db
      .select()
      .from(codexRateLimitSamples)
      .where(and(scope, sql`${codexRateLimitSamples.observedAt} < ${ts(since)}`))
      .orderBy(desc(codexRateLimitSamples.observedAt))
      .limit(1),
  ]);
  return [...before, ...inWindow].map((s) => ({
    observedAt: s.observedAt.toISOString(),
    primary: s.primaryUsedPercent,
    secondary: s.secondaryUsedPercent,
  }));
}

export async function rateLimitedCalls(orgId: string, connectionId: string, since: Date) {
  const result = await rows<Row>(sql`
    select started_at, project_id, agent_name, session_id, turn_id, step_index, model,
      error_code, left(error_message, 300) as error_message
    from gateway_calls
    where connection_id = ${connectionId} and org_id = ${orgId} and started_at >= ${ts(since)}
      and http_status = 429
    order by started_at desc
    limit 51
  `);
  return result.map((r) => ({
    startedAt: iso(r.started_at)!,
    projectId: str(r.project_id),
    agentName: str(r.agent_name),
    sessionId: str(r.session_id),
    model: str(r.model),
    errorCode: str(r.error_code),
    errorMessage: str(r.error_message),
  }));
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

export async function getRunRow(projectId: string, runId: string) {
  const [run] = await db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      agentId: runs.agentId,
      externalRunId: runs.externalRunId,
      status: runs.status,
      channel: runs.channel,
      tokensInput: runs.tokensInput,
      tokensOutput: runs.tokensOutput,
      tokensCachedInput: runs.tokensCachedInput,
      costUsd: runs.costUsd,
      compactionCount: runs.compactionCount,
      peakContextTokens: runs.peakContextTokens,
      wallClockMs: runs.wallClockMs,
      error: runs.error,
      settledBy: sql<string | null>`${runs.metadata}->>'settledBy'`,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      externalSessionId: sessions.externalSessionId,
    })
    .from(runs)
    .leftJoin(sessions, eq(sessions.id, runs.sessionId))
    .where(and(eq(runs.projectId, projectId), eq(runs.id, runId)))
    .limit(1);
  return run ?? null;
}

const withheldOf = (v: unknown): WithheldMark | null => {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  return { tokens: n0(w.tokens), limitTokens: n0(w.limitTokens) };
};

/** A run's steps as scalar columns plus small extracts; never the tool payloads. */
export async function traceSteps(
  runId: string,
  opts: { toolExtracts?: boolean } = {},
): Promise<TraceStepRow[]> {
  // Reading any key of `data` detoasts the whole payload, so tool rows' extracts are opt-in (the
  // run page lists them; the call page doesn't need them) and only a large result can have been
  // withheld, so the size test keeps that read off ordinary results.
  const extracts = opts.toolExtracts !== false;
  const toolSelect = extracts
    ? sql`case when type = 'tool_call' and result_tokens >= 1000 then data->'withheld' end as withheld,
      case when type = 'tool_call' then left(data->>'summary', 160) end as summary,
      case when type = 'tool_call' then md5((data->'input')::text) end as input_hash`
    : sql`null::jsonb as withheld, null::text as summary, null::text as input_hash`;
  const result = await rows<Row>(sql`
    select seq, type, model, tool_name, tokens_input, tokens_output, tokens_cache_read,
      tokens_cache_write, cost_usd, context_window, eve_session_id, turn_id, step_index,
      subagent_name, call_id, child_session_id, result_tokens, result_capped, duration_ms,
      is_error, started_at,
      case when type = 'compaction' then data end as compaction,
      case when type = 'model_call' and is_error then data->>'code' end as error_code,
      ${toolSelect}
    from run_steps
    where run_id = ${runId} and type in ('model_call', 'tool_call', 'compaction')
    order by seq
  `);
  return result.map((r) => ({
    seq: n0(r.seq),
    type: String(r.type),
    model: str(r.model),
    toolName: str(r.tool_name),
    tokensInput: n(r.tokens_input),
    tokensOutput: n(r.tokens_output),
    tokensCacheRead: n(r.tokens_cache_read),
    tokensCacheWrite: n(r.tokens_cache_write),
    costUsd: n(r.cost_usd),
    contextWindow: n(r.context_window),
    eveSessionId: str(r.eve_session_id),
    turnId: str(r.turn_id),
    stepIndex: n(r.step_index),
    subagentName: str(r.subagent_name),
    callId: str(r.call_id),
    childSessionId: str(r.child_session_id),
    resultTokens: n(r.result_tokens),
    resultCapped: r.result_capped == null ? null : Boolean(r.result_capped),
    durationMs: n(r.duration_ms),
    isError: Boolean(r.is_error),
    startedAt: iso(r.started_at),
    withheld: withheldOf(r.withheld),
    compaction: (r.compaction as TraceStepRow["compaction"]) ?? null,
    errorCode: str(r.error_code),
    summary: str(r.summary),
    inputHash: str(r.input_hash),
  }));
}

/** Gateway call-log rows for a run's model calls, by eve session and turn (org-pinned). */
export async function traceGatewayRows(
  orgId: string,
  projectId: string,
  steps: Pick<TraceStepRow, "eveSessionId" | "turnId">[],
): Promise<TraceGatewayRow[]> {
  const sessionIds = [...new Set(steps.map((s) => s.eveSessionId).filter((v): v is string => !!v))];
  const turnIds = [...new Set(steps.map((s) => s.turnId).filter((v): v is string => !!v))];
  if (sessionIds.length === 0 || turnIds.length === 0) return [];
  const result = await rows<Row>(sql`
    select session_id, turn_id, step_index, started_at, ttft_ms, duration_ms, http_status,
      error_code, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
      context_window, composition, connection_id, plan_type, reasoning_effort, model
    from gateway_calls
    where org_id = ${orgId}
      and session_id in (${idList(sessionIds)})
      and turn_id in (${idList(turnIds)})
      -- Identity headers are unverified labels: a row naming another repository never joins.
      and (project_id = ${projectId} or project_id is null)
    order by started_at
    limit 5000
  `);
  return result.map((r) => ({
    sessionId: str(r.session_id),
    turnId: str(r.turn_id),
    stepIndex: n(r.step_index),
    startedAt: iso(r.started_at)!,
    ttftMs: n(r.ttft_ms),
    durationMs: n0(r.duration_ms),
    httpStatus: n(r.http_status),
    errorCode: str(r.error_code),
    inputTokens: n(r.input_tokens),
    cachedInputTokens: n(r.cached_input_tokens),
    outputTokens: n(r.output_tokens),
    reasoningTokens: n(r.reasoning_tokens),
    contextWindow: n(r.context_window),
    composition: (r.composition as Record<string, unknown> | null) ?? null,
    connectionId: String(r.connection_id),
    planType: str(r.plan_type),
    reasoningEffort: str(r.reasoning_effort),
    model: String(r.model),
  }));
}

/** Child runs a run's subagent tool calls started, by child eve session id. */
export async function childRuns(projectId: string, childSessionIds: string[]) {
  if (childSessionIds.length === 0) return new Map<string, string>();
  const list = await db
    .select({ runId: runs.id, externalSessionId: sessions.externalSessionId })
    .from(runs)
    .innerJoin(sessions, eq(sessions.id, runs.sessionId))
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(sessions.projectId, projectId),
        inArray(sessions.externalSessionId, childSessionIds),
      ),
    )
    .orderBy(runs.startedAt);
  const out = new Map<string, string>();
  for (const r of list) if (r.externalSessionId && !out.has(r.externalSessionId)) out.set(r.externalSessionId, r.runId);
  return out;
}

/** The full payloads of the tool calls one model call made (seq range), for the call page. */
export async function toolPayloads(runId: string, fromSeq: number, toSeq: number | null) {
  const upper = toSeq == null ? sql`` : sql`and seq < ${toSeq}`;
  const result = await rows<Row>(sql`
    select seq, tool_name, data, result_tokens, result_capped, is_error, duration_ms
    from run_steps
    where run_id = ${runId} and type = 'tool_call' and seq > ${fromSeq} ${upper}
    order by seq
    limit 100
  `);
  return result.map((r) => {
    const data = (r.data as Record<string, unknown> | null) ?? {};
    return {
      seq: n0(r.seq),
      toolName: str(r.tool_name),
      input: data.input ?? null,
      output: data.output ?? null,
      exitCode: n(data.exitCode),
      truncated: data.truncated === true,
      withheld: withheldOf(data.withheld),
      resultTokens: n(r.result_tokens),
      capped: r.result_capped === true,
      isError: Boolean(r.is_error),
      durationMs: n(r.duration_ms),
    };
  });
}

/** Plan percentages just before and just after a moment, for one call's subscription row. */
export async function headroomAround(orgId: string, connectionId: string, at: Date, end: Date) {
  const scope = and(
    eq(codexRateLimitSamples.orgId, orgId),
    eq(codexRateLimitSamples.connectionId, connectionId),
  );
  const [before, after] = await Promise.all([
    db
      .select()
      .from(codexRateLimitSamples)
      .where(and(scope, sql`${codexRateLimitSamples.observedAt} < ${ts(at)}`))
      .orderBy(desc(codexRateLimitSamples.observedAt))
      .limit(1),
    // Samples are stored only when a value changes, observed when the response headers arrive
    // (inside the call). The latest one by the call's end is what the plan stood at after it.
    db
      .select()
      .from(codexRateLimitSamples)
      .where(and(scope, sql`${codexRateLimitSamples.observedAt} <= ${ts(new Date(end.getTime() + 5000))}`))
      .orderBy(desc(codexRateLimitSamples.observedAt))
      .limit(1),
  ]);
  const pick = (s: (typeof before)[number] | undefined) =>
    s
      ? {
          primary: s.primaryUsedPercent,
          primaryResetsAt: s.primaryResetsAt?.toISOString() ?? null,
          secondary: s.secondaryUsedPercent,
          secondaryResetsAt: s.secondaryResetsAt?.toISOString() ?? null,
        }
      : null;
  return { before: pick(before[0]), after: pick(after[0]) };
}

export async function getConnection(orgId: string, connectionId: string) {
  const [row] = await db
    .select({
      id: modelProviderConnections.id,
      provider: modelProviderConnections.provider,
      label: modelProviderConnections.label,
      accountEmail: modelProviderConnections.accountEmail,
      status: modelProviderConnections.status,
    })
    .from(modelProviderConnections)
    .where(
      and(eq(modelProviderConnections.orgId, orgId), eq(modelProviderConnections.id, connectionId)),
    )
    .limit(1);
  return row ?? null;
}

/** Project names for ids already known to belong to the org. */
export async function projectNames(orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const list = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), inArray(projects.id, ids)));
  return new Map(list.map((p) => [p.id, p.name]));
}

// ---------------------------------------------------------------------------------------------
// Warning signals (issue #419)
// ---------------------------------------------------------------------------------------------

/** The most recent runs a warning scan looks at, so a busy window stays bounded. */
export const WARNING_RUN_LIMIT = 1000;

/**
 * What the warning rules read, for the runs in scope: per-run context, sweep and repeat fields,
 * and step groups (compactions per turn, tool errors per tool and kind, withheld results per
 * tool). Payloads are read only for compaction rows, tool errors and large results.
 */
export async function warningSignals(input: {
  projectIds: string[];
  since: Date;
  agentId?: string;
  runId?: string;
}): Promise<{ runs: RunSignal[]; steps: StepSignal[] }> {
  if (input.projectIds.length === 0) return { runs: [], steps: [] };
  const scope = sql`r.project_id in (${idList(input.projectIds)})
    ${input.runId ? sql`and r.id = ${input.runId}` : sql`and r.started_at >= ${ts(input.since)}`}
    ${input.agentId ? sql`and r.agent_id = ${input.agentId}` : sql``}`;
  const picked = sql`picked as materialized (
    select r.id, r.project_id, r.agent_id, r.started_at, r.finished_at, r.peak_context_tokens,
      r.metadata->>'settledBy' as settled_by, r.metadata->'toolRepeats' as repeats
    from runs r where ${scope}
    order by r.started_at desc
    limit ${WARNING_RUN_LIMIT}
  )`;
  const [runRows, stepRows] = await Promise.all([
    rows<Row>(sql`
      with ${picked}
      select p.*, st.median_ctx, st.context_window, st.calls
      from picked p
      left join lateral (
        select (percentile_cont(0.5) within group (order by s.tokens_input))::float8 as median_ctx,
          max(s.context_window)::int as context_window, count(*)::int as calls
        from run_steps s where s.run_id = p.id and s.type = 'model_call'
      ) st on true
    `),
    rows<Row>(sql`
      with ${picked}
      select p.id as run_id, p.project_id, p.agent_id, p.started_at, g.*
      from picked p
      join lateral (
        select
          case when s.type = 'compaction' then 'compaction'
            when s.result_tokens >= 1000 and s.data ? 'withheld' then 'withheld'
            else 'tool_error' end as kind,
          case when s.type = 'compaction' then coalesce(s.turn_id, '')
            else coalesce(s.tool_name, '(unnamed)') end as grp,
          case when s.type = 'tool_call' and not (s.result_tokens >= 1000 and s.data ? 'withheld')
            then coalesce('exit ' || (s.data->>'exitCode'), 'error') end as error_kind,
          count(*)::int as n,
          count(*) filter (where s.type = 'compaction' and s.data->>'completed' = 'true')::int as completed,
          min(s.seq)::int as first_seq,
          max(s.result_tokens)::int as max_tokens,
          -- Only withheld rows (large results already matched above) have their payload read here.
          max(case when s.result_tokens >= 1000 and s.data ? 'withheld'
              and jsonb_typeof(s.data->'withheld'->'limitTokens') = 'number'
            then (s.data->'withheld'->>'limitTokens')::float8 end) as limit_tokens
        from run_steps s
        where s.run_id = p.id
          and (s.type = 'compaction'
            or (s.type = 'tool_call' and (s.is_error or (s.result_tokens >= 1000 and s.data ? 'withheld'))))
        group by 1, 2, 3
      ) g on true
    `),
  ]);
  return {
    runs: runRows.map((r) => ({
      runId: String(r.id),
      projectId: String(r.project_id),
      agentId: str(r.agent_id),
      startedAt: iso(r.started_at)!,
      finishedAt: iso(r.finished_at),
      settledBy: str(r.settled_by),
      medianContext: n(r.median_ctx),
      window: n(r.context_window),
      peakContext: n(r.peak_context_tokens),
      calls: n0(r.calls),
      repeats: parseToolRepeats(r.repeats),
    })),
    steps: stepRows.map((r) => ({
      runId: String(r.run_id),
      projectId: String(r.project_id),
      agentId: str(r.agent_id),
      startedAt: iso(r.started_at)!,
      kind: String(r.kind) as StepSignal["kind"],
      group: String(r.grp),
      errorKind: str(r.error_kind),
      count: n0(r.n),
      completed: n0(r.completed),
      firstSeq: n0(r.first_seq),
      maxTokens: n(r.max_tokens),
      limitTokens: n(r.limit_tokens),
    })),
  };
}

/**
 * Evidence for a few steps (each warning's worst case): a short input and error excerpt, and the
 * model call that made the step. Scoped to runs the caller already authorised.
 */
export async function stepEvidence(items: { runId: string; seq: number }[]) {
  const out = new Map<string, { callSeq: number | null; inputPreview: string | null; message: string | null }>();
  if (items.length === 0) return out;
  const pairs = sql.join(items.map((i) => sql`(${i.runId}, ${i.seq}::int)`), sql`, `);
  const result = await rows<Row>(sql`
    select s.run_id, s.seq,
      left((s.data->'input')::text, 300) as input_preview,
      left(coalesce(
        s.data->'output'->>'stderr', s.data->>'error', s.data->'output'->>'error',
        case when jsonb_typeof(s.data->'output') = 'string' then s.data->>'output' end
      ), 300) as message,
      (select max(m.seq) from run_steps m
        where m.run_id = s.run_id and m.type = 'model_call' and m.seq < s.seq) as call_seq
    from run_steps s
    where (s.run_id, s.seq) in (${pairs})
  `);
  for (const r of result) {
    out.set(`${r.run_id}:${r.seq}`, {
      callSeq: n(r.call_seq),
      inputPreview: str(r.input_preview),
      message: str(r.message),
    });
  }
  return out;
}
