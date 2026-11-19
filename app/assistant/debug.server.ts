/**
 * The assistant's read-only debugging actions (issue #432): `runs`, `run-trace`, `usage` and
 * `deployments` on `POST /api/assistant/<action>`. They read the same queries as the usage
 * pages, always for `ctx.project` (the project the deployment token resolves to): nothing here
 * takes a project id from the body, a pasted run link naming another repository is refused, and
 * a bare run id is read through `getRunRow(project.id, ...)`, which finds only this project's runs.
 *
 * Every response is fitted under `RESPONSE_BUDGET_BYTES` (see `./debug.ts`) and every excerpt
 * of tool input, output, error or log text goes through `redactText` first. Run steps were
 * already scrubbed at ingest; this second, stricter pass also masks secret-named fields.
 *
 * Business failures are `{ ok: false, error }`, served at HTTP 200 like the other actions.
 */
import type { AssistantContext } from "~/assistant/authoring.server";
import type { DataStore } from "~/data/ports";
import { toolResultLimitTokens } from "~/gateway/tool-result-limit";
import { redactText } from "~/observability/capture.server";
import { getRuntime } from "~/seams/index.server";
import {
  childRuns,
  getRunRow,
  listRunRows,
  runAggregates,
  stepEvidence,
  toolPayloads,
  toolRanking,
  traceGatewayRows,
  traceSteps,
} from "~/usage/queries.server";
import { buildTrace, type TraceStepRow } from "~/usage/trace";
import { loadWarnings } from "~/usage/warnings.server";
import {
  byteSize,
  cut,
  fitChunk,
  fitItems,
  intParam,
  parseRunRef,
  parseSince,
} from "./debug";

export interface DebugDeps {
  store: DataStore;
  listRunRows: typeof listRunRows;
  /** `getRunRow`, typed as it behaves: undefined when the run isn't in that project. */
  getRunRow: (projectId: string, runId: string) => Promise<Awaited<ReturnType<typeof getRunRow>> | undefined>;
  traceSteps: typeof traceSteps;
  traceGatewayRows: typeof traceGatewayRows;
  childRuns: typeof childRuns;
  stepEvidence: typeof stepEvidence;
  toolPayloads: typeof toolPayloads;
  runAggregates: typeof runAggregates;
  toolRanking: typeof toolRanking;
  loadWarnings: typeof loadWarnings;
  /** The deploy target's container log tail, or null when the target has none. */
  logsTail: ((deploymentId: string, lines: number) => Promise<string>) | null;
  /** Secret values an environment's containers run with, masked out of their logs. */
  secretValues: (scope: { projectId: string; agentId: string; environmentId: string }) => Promise<string[]>;
  now: () => Date;
}

export function defaultDebugDeps(): DebugDeps {
  const runtime = getRuntime();
  const target = runtime.deployTarget;
  return {
    store: runtime.data,
    listRunRows,
    getRunRow,
    traceSteps,
    traceGatewayRows,
    childRuns,
    stepEvidence,
    toolPayloads,
    runAggregates,
    toolRanking,
    loadWarnings,
    logsTail: target.logsTail ? (id, lines) => target.logsTail!(id, lines) : null,
    secretValues: async (scope) => Object.values(await runtime.secrets.resolve(scope)),
    now: () => new Date(),
  };
}

type Body = Record<string, unknown>;
type Result = Record<string, unknown>;

const fail = (error: string): Result => ({ ok: false, error });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const INPUT_CHARS = 200;
const ERROR_CHARS = 240;
const CHUNK_CHARS = 16_000;

/** Redact, then cut: cutting first could leave half a secret the patterns no longer match. */
const excerpt = (text: string | null | undefined, max: number) =>
  text == null ? null : cut(redactText(text), max);

const runLink = (projectId: string, runId: string) => `/usage/repos/${projectId}/runs/${runId}`;

async function agentNameMap(store: DataStore, projectId: string) {
  const list = await store.agents.listByProject(projectId);
  return { list, name: new Map(list.map((a) => [a.id, a.name])) };
}

// ---------------------------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------------------------

export async function listRunsAction(ctx: AssistantContext, body: Body, deps: DebugDeps): Promise<Result> {
  const { project } = ctx;
  const now = deps.now();
  const since = parseSince(body.since, now, 7);
  const limit = intParam(body.limit, 20, 1, 100);
  const offset = intParam(body.offset, 0, 0, 10_000);
  const status = str(body.status) || undefined;
  const { list, name } = await agentNameMap(deps.store, project.id);
  let agentId: string | undefined;
  const agent = str(body.agent);
  if (agent) {
    const found = list.find((a) => a.name === agent);
    if (!found) {
      return fail(`No agent named "${agent.slice(0, 80)}" in this repository. Agents: ${list.map((a) => a.name).join(", ") || "none"}.`);
    }
    agentId = found.id;
  }
  // One extra row says whether there is a next page.
  const rows = await deps.listRunRows({
    projectIds: [project.id],
    since,
    agentId,
    status,
    limit: limit + 1,
    offset,
  });
  const more = rows.length > limit;
  const runs = rows.slice(0, limit).map((r) => ({
    id: r.id,
    agent: r.agentId ? (name.get(r.agentId) ?? null) : null,
    channel: r.channel,
    status: r.status,
    error: excerpt(r.error, ERROR_CHARS),
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    peakContext: r.peakContext,
    window: r.window,
    compactions: r.compactions ?? r.compactionsRequested,
    calls: r.calls,
    toolCalls: r.toolCalls,
    toolErrors: r.toolErrors,
    inputTokens: r.input,
    deploymentId: r.deploymentId,
    link: runLink(project.id, r.id),
  }));
  const { body: out } = fitItems(runs, (kept) => {
    const cutShort = kept.length < runs.length;
    return {
      ok: true,
      since: since.toISOString(),
      runs: kept,
      truncated: cutShort || more,
      nextOffset: cutShort || more ? offset + kept.length : null,
    };
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// run-trace
// ---------------------------------------------------------------------------------------------

type StepEntry =
  | {
      seq: number;
      kind: "model";
      turn: string | null;
      subagent: string | null;
      context: number | null;
      window: number | null;
      output: number | null;
      status: string;
      error: string | null;
    }
  | {
      seq: number;
      kind: "tool";
      tool: string | null;
      input: string | null;
      resultTokens: number | null;
      error: string | null;
      withheld: { tokens: number; limitTokens: number } | null;
      childRunId: string | null;
    }
  | { seq: number; kind: "compaction"; atContext: number | null; completed: boolean };

/** Big results, errors, withheld results, compactions and failed model calls. */
function isProblem(step: TraceStepRow, bigTokens: number): boolean {
  if (step.type === "compaction") return true;
  if (step.isError || step.withheld) return true;
  return step.type === "tool_call" && (step.resultTokens ?? 0) >= bigTokens;
}

export async function runTraceAction(ctx: AssistantContext, body: Body, deps: DebugDeps): Promise<Result> {
  const { project } = ctx;
  const ref = parseRunRef(body.run, project.id);
  if (!ref.ok) return fail(ref.error);
  const run = await deps.getRunRow(project.id, ref.runId);
  if (!run) return fail(`Run ${ref.runId} was not found in this repository.`);

  if (body.step != null) return stepOutput(run.id, body, deps);

  const steps = await deps.traceSteps(run.id);
  const childIds = [...new Set(steps.map((s) => s.childSessionId).filter((v): v is string => !!v))];
  const [gateway, children, { name }] = await Promise.all([
    deps.traceGatewayRows(project.orgId, project.id, steps),
    deps.childRuns(project.id, childIds),
    agentNameMap(deps.store, project.id),
  ]);
  const trace = buildTrace(steps, gateway);
  const callBySeq = new Map(trace.calls.map((c) => [c.seq, c]));
  const limitTokens = toolResultLimitTokens(trace.metrics.window);

  const only = str(body.only) === "problems" ? "problems" : "all";
  const bigTokens = Math.max(1000, Math.floor(limitTokens / 4));
  const ordered = steps.filter((s) => only === "all" || isProblem(s, bigTokens));
  const offset = intParam(body.offset, 0, 0, Math.max(0, ordered.length));
  const pageSize = intParam(body.limit, 80, 1, 200);
  const page = ordered.slice(offset, offset + pageSize);

  const tools = steps.filter((s) => s.type === "tool_call");
  const largest = [...tools]
    .filter((s) => (s.resultTokens ?? 0) > 0)
    .sort((a, b) => (b.resultTokens ?? 0) - (a.resultTokens ?? 0))
    .slice(0, 5);
  const evidenceFor = [...page.filter((s) => s.type === "tool_call"), ...largest];
  const evidence = await deps.stepEvidence(
    [...new Set(evidenceFor.map((s) => s.seq))].map((seq) => ({ runId: run.id, seq })),
  );
  const ev = (seq: number) => evidence.get(`${run.id}:${seq}`);

  const entries: StepEntry[] = page.map((s): StepEntry => {
    if (s.type === "model_call") {
      const call = callBySeq.get(s.seq);
      return {
        seq: s.seq,
        kind: "model",
        turn: s.turnId,
        subagent: s.subagentName,
        context: call?.input ?? s.tokensInput,
        window: call?.window ?? s.contextWindow,
        output: call?.output ?? s.tokensOutput,
        status: call?.status ?? (s.isError ? "error" : "ok"),
        error: call?.errorCode ?? s.errorCode,
      };
    }
    if (s.type === "compaction") {
      return {
        seq: s.seq,
        kind: "compaction",
        atContext: s.compaction?.usageInputTokens ?? null,
        completed: s.compaction?.completed === true,
      };
    }
    const e = ev(s.seq);
    return {
      seq: s.seq,
      kind: "tool",
      tool: s.toolName,
      input: excerpt(e?.inputPreview ?? s.summary, INPUT_CHARS),
      resultTokens: s.resultTokens,
      error: s.isError && !s.withheld ? excerpt(e?.message, ERROR_CHARS) || "error" : null,
      withheld: s.withheld,
      childRunId: s.childSessionId ? (children.get(s.childSessionId) ?? null) : null,
    };
  });

  const m = trace.metrics;
  const header = {
    ok: true,
    run: {
      id: run.id,
      agent: run.agentId ? (name.get(run.agentId) ?? null) : null,
      status: run.status,
      channel: run.channel,
      error: excerpt(run.error, ERROR_CHARS),
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      link: runLink(project.id, run.id),
    },
    summary: {
      modelCalls: m.calls,
      toolCalls: m.toolCalls,
      peakContext: m.peakContext,
      medianContext: m.medianContext,
      window: m.window,
      toolResultLimitTokens: limitTokens,
      compactionsRequested: m.compactionsRequested,
      compactionsCompleted: m.compactionsDone,
      toolResultTokens: m.toolResultTokens,
      withheld: m.withheld,
      toolErrors: m.toolErrors,
      modelCallErrors: m.callErrors,
    },
    largestToolResults: largest.map((s) => ({
      seq: s.seq,
      tool: s.toolName,
      resultTokens: s.resultTokens,
      input: excerpt(ev(s.seq)?.inputPreview ?? s.summary, INPUT_CHARS),
    })),
    repeatedCalls: trace.repeats.slice(0, 5).map((r) => ({ tool: r.toolName, count: r.count, firstSeq: r.firstSeq })),
    subagentRuns: [...children.values()].slice(0, 20),
    only,
    totalSteps: ordered.length,
    offset,
  };
  const { body: out } = fitItems(entries, (kept) => {
    const end = offset + kept.length;
    return {
      ...header,
      steps: kept,
      truncated: end < ordered.length,
      nextOffset: end < ordered.length ? end : null,
    };
  });
  return out;
}

/** One tool step's stored input and output, the output in chunks. */
async function stepOutput(runId: string, body: Body, deps: DebugDeps): Promise<Result> {
  const seq = intParam(body.step, -1, -1, Number.MAX_SAFE_INTEGER);
  if (seq < 0) return fail("step must be a step seq from this run's trace.");
  const [payload] = await deps.toolPayloads(runId, seq - 1, seq + 1);
  if (!payload || payload.seq !== seq) {
    return fail(`Step ${seq} is not a tool call in run ${runId}. Only tool steps have stored output.`);
  }
  const asText = (v: unknown) =>
    v == null ? "" : typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  const output = redactText(asText(payload.output));
  const offset = intParam(body.chunkOffset, 0, 0, Number.MAX_SAFE_INTEGER);
  const input = offset === 0 ? cut(redactText(asText(payload.input)), 2000) : undefined;
  return fitChunk(output, offset, CHUNK_CHARS, (chunk, nextOffset) => ({
    ok: true,
    runId,
    seq,
    tool: payload.toolName,
    ...(input !== undefined ? { input } : {}),
    isError: payload.isError,
    withheld: payload.withheld,
    resultTokens: payload.resultTokens,
    /** The stored copy was cut at ingest (fields over 16KB, steps over 64KB). */
    storedTruncated: payload.truncated || payload.capped,
    totalChars: output.length,
    chunkOffset: Math.min(offset, output.length),
    output: chunk,
    nextChunkOffset: nextOffset,
  }));
}

// ---------------------------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------------------------

export async function usageAction(ctx: AssistantContext, body: Body, deps: DebugDeps): Promise<Result> {
  const { project } = ctx;
  const since = parseSince(body.since, deps.now(), 7);
  const { list, name } = await agentNameMap(deps.store, project.id);
  const agent = str(body.agent);
  const agentId = agent ? list.find((a) => a.name === agent)?.id : undefined;
  if (agent && !agentId) {
    return fail(`No agent named "${agent.slice(0, 80)}" in this repository. Agents: ${list.map((a) => a.name).join(", ") || "none"}.`);
  }
  const [aggregates, warnings] = await Promise.all([
    deps.runAggregates({ projectIds: [project.id], since, agentId }),
    deps.loadWarnings({
      orgId: project.orgId,
      projects: [{ id: project.id, name: project.name }],
      since,
      agentId,
      connections: false,
    }),
  ]);
  const byInput = [...aggregates].sort((a, b) => (b.input ?? 0) - (a.input ?? 0)).slice(0, 10);
  const agents = await Promise.all(
    byInput.map(async (a) => {
      const tools = a.agentId
        ? await deps.toolRanking({ projectId: project.id, agentId: a.agentId, since })
        : [];
      return {
        agent: a.agentId ? (name.get(a.agentId) ?? null) : null,
        runs: a.runs,
        failedRuns: a.failed,
        modelCalls: a.calls,
        inputTokens: a.input,
        cachedTokens: a.cached,
        outputTokens: a.output,
        peakContext: a.peakContext,
        compactions: a.compactions,
        compactedRuns: a.compactedRuns,
        withheldResults: tools.reduce((n, t) => n + t.withheld, 0),
        topToolsByTokens: tools.slice(0, 8).map((t) => ({
          tool: t.toolName,
          calls: t.calls,
          resultTokens: t.tokens,
          maxResultTokens: t.maxTokens,
          errors: t.errors,
          withheld: t.withheld,
        })),
      };
    }),
  );
  const shownWarnings = warnings.slice(0, 20).map((w) => ({
    severity: w.severity,
    rule: w.rule,
    agent: w.agentName,
    title: w.title,
    summary: cut(redactText(w.summary), 400),
    suggestedFix: w.fix,
    runId: w.worst.runId,
    runs: w.runs,
    lastSeen: w.lastSeen,
  }));
  const { body: out } = fitItems(shownWarnings, (kept) => ({
    ok: true,
    since: since.toISOString(),
    agents,
    warnings: kept,
    warningsTotal: warnings.length,
    truncated: kept.length < warnings.length,
  }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// deployments
// ---------------------------------------------------------------------------------------------

/** The log tail's share of the response budget, in serialized bytes. */
const LOG_BYTES = 24_000;
const STATUS_ORDER = ["live", "draining", "building", "pending", "stopped", "failed"];

/**
 * Log text safe to show: terminal colour codes dropped, each known secret value (6+ characters)
 * masked wherever it appears, then the usual credential patterns.
 */
export function scrubLogs(text: string, secretValues: string[]): string {
  let out = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const values = secretValues.filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join("[redacted]");
  return redactText(out);
}

export async function deploymentsAction(ctx: AssistantContext, body: Body, deps: DebugDeps): Promise<Result> {
  const { project } = ctx;
  const [{ name }, envs] = await Promise.all([
    agentNameMap(deps.store, project.id),
    deps.store.environments.listByProject(project.id),
  ]);
  const rows = (
    await Promise.all(
      envs.map(async (env) =>
        (await deps.store.deployments.listByEnvironment(env.id)).map((d) => ({ d, env })),
      ),
    )
  ).flat();
  const rank = (s: string) => {
    const i = STATUS_ORDER.indexOf(s);
    return i < 0 ? STATUS_ORDER.length : i;
  };
  rows.sort((a, b) => rank(a.d.status) - rank(b.d.status) || b.d.createdAt.getTime() - a.d.createdAt.getTime());
  const deployments = rows.slice(0, 40).map(({ d, env }) => ({
    id: d.id,
    agent: name.get(env.agentId) ?? null,
    environment: env.name,
    status: d.status,
    version: d.version,
    gitSha: d.gitSha.slice(0, 12),
    createdAt: d.createdAt.toISOString(),
    error: excerpt(d.errorDetail, ERROR_CHARS),
  }));

  let logs: Record<string, unknown> | undefined;
  const wanted = str(body.logs);
  if (wanted) {
    const hit = rows.find((r) => r.d.id === wanted);
    if (!hit) return fail(`Deployment ${wanted.slice(0, 40)} is not one of this repository's deployments.`);
    if (!deps.logsTail) {
      logs = { deploymentId: wanted, available: false, reason: "This harnesst host's deploy target has no container log access." };
    } else {
      const lines = intParam(body.lines, 100, 1, 300);
      const [raw, secrets] = await Promise.all([
        deps.logsTail(wanted, lines),
        deps
          .secretValues({ projectId: project.id, agentId: hit.env.agentId, environmentId: hit.env.id })
          .catch(() => []),
      ]);
      const text = scrubLogs(raw, secrets);
      // Keep the tail: the newest lines are the ones that explain a failure.
      let kept = text;
      while (byteSize(kept) > LOG_BYTES) kept = `…${kept.slice(Math.ceil(kept.length / 4))}`;
      logs = { deploymentId: wanted, available: true, lines, truncated: kept !== text, text: kept };
    }
  }

  const { body: out } = fitItems(deployments, (kept) => ({
    ok: true,
    deployments: kept,
    truncated: kept.length < rows.length,
    ...(logs ? { logs } : {}),
  }));
  return out;
}
