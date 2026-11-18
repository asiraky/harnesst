/**
 * The run trace (issue #418): one run's model calls in order, each joined to its gateway call-log
 * row, with the tool results it fed back and the compactions between them. Pure, so the joining
 * and grouping rules are unit-tested; the loader hands it scalar step columns only (no payloads).
 *
 * Joins and their limits:
 *   - A model call joins `gateway_calls` on eve's (session, turn, step index). Rows recorded before
 *     those ids existed, and calls that did not go through the harnesst gateway, have no row: they
 *     still render, with the gateway-only fields (time, TTFT, reasoning, composition) unavailable.
 *   - Tool calls carry no step index; a tool call belongs to the model call before it in `seq`
 *     order (that is how `turnToSteps` writes them).
 *   - Only gateway rows carry a start time, so wall-clock order covers joined calls only.
 */
import { median } from "./format";

export interface WithheldMark {
  tokens: number;
  limitTokens: number;
}

/** A `run_steps` row as the trace loader selects it: scalar columns plus small extracts. */
export interface TraceStepRow {
  seq: number;
  type: string;
  model: string | null;
  toolName: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  costUsd: number | null;
  contextWindow: number | null;
  eveSessionId: string | null;
  turnId: string | null;
  stepIndex: number | null;
  subagentName: string | null;
  callId: string | null;
  childSessionId: string | null;
  resultTokens: number | null;
  resultCapped: boolean | null;
  durationMs: number | null;
  isError: boolean;
  startedAt: string | null;
  /** `data.withheld`, set when the gateway withheld the result for size. */
  withheld: WithheldMark | null;
  /** A compaction step's `data`. */
  compaction: { usageInputTokens?: number; completed?: boolean } | null;
  /** A failed model call's `data.code`. */
  errorCode: string | null;
  /** A tool call's short `data.summary`. */
  summary: string | null;
  /** md5 of a tool call's `data.input`: equal hashes are identical calls. */
  inputHash: string | null;
}

/** The parts of a gateway call-log row the trace uses. */
export interface TraceGatewayRow {
  sessionId: string | null;
  turnId: string | null;
  stepIndex: number | null;
  startedAt: string;
  ttftMs: number | null;
  durationMs: number;
  httpStatus: number | null;
  errorCode: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  contextWindow: number | null;
  composition: Record<string, unknown> | null;
  connectionId: string;
  planType: string | null;
  reasoningEffort: string | null;
  model: string;
}

export interface TraceTool {
  seq: number;
  toolName: string | null;
  resultTokens: number | null;
  capped: boolean;
  durationMs: number | null;
  isError: boolean;
  withheld: WithheldMark | null;
  summary: string | null;
  childSessionId: string | null;
}

export interface CompositionPart {
  key: "system" | "tools" | "messages" | "toolResults";
  label: string;
  tokens: number;
}

export interface TraceCall {
  seq: number;
  /** 1-based position among the run's model calls. */
  index: number;
  turnId: string | null;
  stepIndex: number | null;
  sessionId: string | null;
  subagentName: string | null;
  model: string | null;
  input: number | null;
  cached: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  window: number | null;
  costUsd: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  startedAt: string | null;
  status: "ok" | "error" | "rate_limited";
  httpStatus: number | null;
  errorCode: string | null;
  /** Estimated parts of the input, when the gateway recorded them. */
  composition: CompositionPart[] | null;
  connectionId: string | null;
  planType: string | null;
  reasoningEffort: string | null;
  /** Gateway attempts beyond the one shown (retries of the same step). */
  retries: number;
  /** Any attempt for this step was refused with a 429. */
  hit429: boolean;
  tools: TraceTool[];
}

export interface TraceCompaction {
  seq: number;
  /** The context size that triggered it. */
  usageInputTokens: number | null;
  completed: boolean;
  startedAt: string | null;
  model: string | null;
  /** Index of the model call it came after (0 = before the first). */
  afterIndex: number;
}

export type TraceItem =
  | { kind: "call"; call: TraceCall }
  | { kind: "compaction"; compaction: TraceCompaction };

export interface TraceTurn {
  turnId: string | null;
  /** The turn's items split at each compaction: cycle n+1 starts with the compaction. */
  cycles: TraceItem[][];
}

export interface RepeatedCall {
  toolName: string | null;
  count: number;
  firstSeq: number;
}

export interface TraceMetrics {
  calls: number;
  turns: number;
  input: number | null;
  cached: number | null;
  output: number | null;
  reasoning: number | null;
  peakContext: number | null;
  medianContext: number | null;
  window: number | null;
  compactionsDone: number;
  compactionsRequested: number;
  toolCalls: number;
  toolResultTokens: number | null;
  withheld: number;
  toolErrors: number;
  callErrors: number;
  rateLimited: number;
  /** Summed model-call and tool durations: time spent working, not waiting between turns. */
  activeMs: number | null;
  connectionIds: string[];
  /** Calls that have a gateway start time, for wall-clock mode. */
  timedCalls: number;
}

export interface Trace {
  items: TraceItem[];
  calls: TraceCall[];
  compactions: TraceCompaction[];
  turns: TraceTurn[];
  metrics: TraceMetrics;
  repeats: RepeatedCall[];
}

const gatewayKey = (session: string | null, turn: string | null, step: number | null) =>
  session && turn && step != null ? `${session}\u0000${turn}\u0000${step}` : null;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * The estimated composition, scaled so its parts add up to the call's real input when that is
 * known (the estimate and the provider's count use different tokenizers).
 */
export function compositionParts(
  composition: Record<string, unknown> | null | undefined,
  actualInput: number | null,
): CompositionPart[] | null {
  if (!composition) return null;
  const raw = {
    system: num(composition.instructions) + num(composition.system),
    tools: num(composition.tools),
    messages: num(composition.messages),
    toolResults: num(composition.toolResults),
  };
  const total = raw.system + raw.tools + raw.messages + raw.toolResults;
  if (total <= 0) return null;
  const scale = actualInput && actualInput > 0 ? actualInput / total : 1;
  const labels: Record<CompositionPart["key"], string> = {
    system: "System prompt",
    tools: "Tool definitions",
    messages: "Conversation",
    toolResults: "Tool results",
  };
  return (Object.keys(raw) as CompositionPart["key"][]).map((key) => ({
    key,
    label: labels[key],
    tokens: Math.round(raw[key] * scale),
  }));
}

/** The attempt to show for a step: the last one, since a retry supersedes what it retried. */
function pickAttempt(rows: TraceGatewayRow[]): TraceGatewayRow {
  return rows.reduce((a, b) => (Date.parse(b.startedAt) >= Date.parse(a.startedAt) ? b : a));
}

function sumOrNull(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** Tool calls with the same tool and input, two or more times, most repeated first. */
export function repeatedCalls(
  tools: { seq: number; toolName: string | null; inputHash: string | null }[],
): RepeatedCall[] {
  const groups = new Map<string, RepeatedCall>();
  for (const tool of tools) {
    if (!tool.inputHash) continue;
    const key = `${tool.toolName ?? ""}\u0000${tool.inputHash}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
      group.firstSeq = Math.min(group.firstSeq, tool.seq);
    } else groups.set(key, { toolName: tool.toolName, count: 1, firstSeq: tool.seq });
  }
  return [...groups.values()]
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.count - a.count || a.firstSeq - b.firstSeq);
}

/**
 * Turns in order of first appearance, each split into cycles at its compactions. A compaction
 * belongs to the turn of the call after it (it made room for that call), else the turn before.
 */
export function groupTurns(items: TraceItem[]): TraceTurn[] {
  const turns: TraceTurn[] = [];
  const turnOf = new Map<string, TraceTurn>();
  let pending: TraceItem[] = [];
  let lastTurn: TraceTurn | null = null;
  const turnFor = (id: string | null) => {
    const key = id ?? "";
    let turn = turnOf.get(key);
    if (!turn) {
      turn = { turnId: id, cycles: [[]] };
      turnOf.set(key, turn);
      turns.push(turn);
    }
    return turn;
  };
  const place = (turn: TraceTurn, item: TraceItem) => {
    if (item.kind === "compaction") turn.cycles.push([item]);
    else turn.cycles[turn.cycles.length - 1].push(item);
  };
  for (const item of items) {
    if (item.kind === "compaction") {
      pending.push(item);
      continue;
    }
    const turn = turnFor(item.call.turnId);
    for (const p of pending) place(turn, p);
    pending = [];
    place(turn, item);
    lastTurn = turn;
  }
  if (pending.length) {
    const turn = lastTurn ?? turnFor(null);
    for (const p of pending) place(turn, p);
  }
  for (const turn of turns) turn.cycles = turn.cycles.filter((c) => c.length > 0);
  return turns;
}

/** The trace's items back in step order, from its calls and compactions. */
export function traceItems(calls: TraceCall[], compactions: TraceCompaction[]): TraceItem[] {
  const items: TraceItem[] = [
    ...calls.map((call) => ({ kind: "call" as const, call })),
    ...compactions.map((compaction) => ({ kind: "compaction" as const, compaction })),
  ];
  const seqOf = (item: TraceItem) => (item.kind === "call" ? item.call.seq : item.compaction.seq);
  return items.sort((a, b) => seqOf(a) - seqOf(b));
}

export function buildTrace(steps: TraceStepRow[], gateway: TraceGatewayRow[]): Trace {
  const byKey = new Map<string, TraceGatewayRow[]>();
  for (const row of gateway) {
    const key = gatewayKey(row.sessionId, row.turnId, row.stepIndex);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  // Older eve kept stepIndex at 0, so several model calls share one key; joining any of them
  // would hand every call the turn's last attempt. Those calls go unjoined instead.
  const keyUses = new Map<string, number>();
  for (const step of ordered) {
    if (step.type !== "model_call") continue;
    const key = gatewayKey(step.eveSessionId, step.turnId, step.stepIndex);
    if (key) keyUses.set(key, (keyUses.get(key) ?? 0) + 1);
  }
  const items: TraceItem[] = [];
  const calls: TraceCall[] = [];
  const compactions: TraceCompaction[] = [];
  const allTools: TraceStepRow[] = [];
  let current: TraceCall | null = null;

  for (const step of ordered) {
    if (step.type === "model_call") {
      const key = gatewayKey(step.eveSessionId, step.turnId, step.stepIndex);
      const attempts = (key && keyUses.get(key) === 1 && byKey.get(key)) || [];
      const gw = attempts.length ? pickAttempt(attempts) : null;
      const hit429 = attempts.some((a) => a.httpStatus === 429);
      const input = step.tokensInput ?? gw?.inputTokens ?? null;
      const failed = step.isError || (gw?.httpStatus != null && gw.httpStatus >= 400);
      current = {
        seq: step.seq,
        index: calls.length + 1,
        turnId: step.turnId,
        stepIndex: step.stepIndex,
        sessionId: step.eveSessionId,
        subagentName: step.subagentName,
        model: step.model ?? gw?.model ?? null,
        input,
        cached: step.tokensCacheRead ?? gw?.cachedInputTokens ?? null,
        cacheWrite: step.tokensCacheWrite,
        output: step.tokensOutput ?? gw?.outputTokens ?? null,
        reasoning: gw?.reasoningTokens ?? null,
        window: step.contextWindow ?? gw?.contextWindow ?? null,
        costUsd: step.costUsd,
        durationMs: step.durationMs ?? gw?.durationMs ?? null,
        ttftMs: gw?.ttftMs ?? null,
        startedAt: gw?.startedAt ?? null,
        status: gw?.httpStatus === 429 ? "rate_limited" : failed ? "error" : "ok",
        httpStatus: gw?.httpStatus ?? null,
        errorCode: step.errorCode ?? gw?.errorCode ?? null,
        composition: compositionParts(gw?.composition, input),
        connectionId: gw?.connectionId ?? null,
        planType: gw?.planType ?? null,
        reasoningEffort: gw?.reasoningEffort ?? null,
        retries: Math.max(0, attempts.length - 1),
        hit429,
        tools: [],
      };
      calls.push(current);
      items.push({ kind: "call", call: current });
    } else if (step.type === "tool_call") {
      allTools.push(step);
      current?.tools.push({
        seq: step.seq,
        toolName: step.toolName,
        resultTokens: step.resultTokens,
        capped: step.resultCapped === true,
        durationMs: step.durationMs,
        isError: step.isError,
        withheld: step.withheld,
        summary: step.summary,
        childSessionId: step.childSessionId,
      });
    } else if (step.type === "compaction") {
      const compaction: TraceCompaction = {
        seq: step.seq,
        usageInputTokens: step.compaction?.usageInputTokens ?? null,
        completed: step.compaction?.completed === true,
        startedAt: step.startedAt,
        model: step.model,
        afterIndex: calls.length,
      };
      compactions.push(compaction);
      items.push({ kind: "compaction", compaction });
    }
  }

  const turns = groupTurns(items);

  const inputs = calls.map((c) => c.input).filter((v): v is number => v != null);
  const windows = calls.map((c) => c.window).filter((v): v is number => v != null);
  const tools = calls.flatMap((c) => c.tools);
  const durations = [
    ...calls.map((c) => c.durationMs),
    ...tools.map((t) => t.durationMs),
  ];
  const metrics: TraceMetrics = {
    calls: calls.length,
    turns: new Set(calls.map((c) => c.turnId ?? "")).size,
    input: sumOrNull(calls.map((c) => c.input)),
    cached: sumOrNull(calls.map((c) => c.cached)),
    output: sumOrNull(calls.map((c) => c.output)),
    reasoning: sumOrNull(calls.map((c) => c.reasoning)),
    peakContext: inputs.length ? Math.max(...inputs) : null,
    medianContext: median(inputs),
    window: windows.length ? Math.max(...windows) : null,
    compactionsDone: compactions.filter((c) => c.completed).length,
    compactionsRequested: compactions.length,
    toolCalls: tools.length,
    toolResultTokens: sumOrNull(tools.map((t) => t.resultTokens)),
    withheld: tools.filter((t) => t.withheld).length,
    toolErrors: tools.filter((t) => t.isError).length,
    callErrors: calls.filter((c) => c.status !== "ok").length,
    rateLimited: calls.filter((c) => c.hit429).length,
    activeMs: sumOrNull(durations),
    connectionIds: [
      ...new Set(calls.map((c) => c.connectionId).filter((v): v is string => !!v)),
    ],
    timedCalls: calls.filter((c) => c.startedAt).length,
  };

  return { items, calls, compactions, turns, metrics, repeats: repeatedCalls(allTools) };
}
