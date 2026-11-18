/**
 * Usage warnings (issue #419): the rules that turn recorded usage into warnings, how occurrences
 * group into one warning, and the message drafted for the agent's assistant. Pure and
 * client-safe; the loaders feed it rows from `warnings.server.ts`.
 *
 * Severity:
 *   - compaction: one in a turn warns, three or more in one turn is critical;
 *   - median context over half the window warns, from the compaction threshold it is critical;
 *   - a plan window over 80% warns, at 100% it is critical; any 429 is critical;
 *   - the rest warn.
 * Low cache and plan warnings are platform warnings: no agent's assistant owns the fix, so they
 * offer a copyable draft and no send.
 */
import { COMPACTION_THRESHOLD, formatPercent, formatTokens, ratio } from "./format";

export type WarningRule =
  | "compaction"
  | "tool_error"
  | "withheld"
  | "repeated_call"
  | "context_high"
  | "low_cache"
  | "plan"
  | "stale_sweep";

export type Severity = "warn" | "critical";

export const RULE_LABELS: Record<WarningRule, { label: string; short: string }> = {
  compaction: { label: "Compaction", short: "compaction" },
  tool_error: { label: "Tool errors", short: "tool error" },
  withheld: { label: "Results withheld (too large)", short: "withheld" },
  repeated_call: { label: "Repeated identical tool calls", short: "repeat calls" },
  context_high: { label: "Context over 50% (median)", short: "context >50%" },
  low_cache: { label: "Low cache hit rate", short: "low cache" },
  plan: { label: "Plan over 80% / 429", short: "plan" },
  stale_sweep: { label: "Settled by stale sweep", short: "stale sweep" },
};

/** Repeated identical calls warn from this many in one run. */
export const REPEAT_THRESHOLD = 3;
/** Low cache warns below this hit rate ... */
export const LOW_CACHE_RATE = 0.2;
/** ... over at least this many calls. */
export const LOW_CACHE_MIN_CALLS = 50;
/** A plan window warns past this percentage. */
export const PLAN_WARN_PCT = 80;

export interface Evidence {
  tool?: string | null;
  /** Error kind: `exit 1`, an error code, or `error`. */
  kind?: string | null;
  count?: number;
  /** A result's size, and the limit it was withheld against. */
  tokens?: number | null;
  limitTokens?: number | null;
  requested?: number;
  completed?: number;
  median?: number | null;
  window?: number | null;
  peak?: number | null;
  calls?: number;
  hitRate?: number | null;
  input?: number | null;
  cached?: number | null;
  planWindow?: string;
  pct?: number;
  resetsAt?: string | null;
  rateLimited?: number;
  /** A short excerpt of the tool input and the error, filled in for the warning's worst case. */
  inputPreview?: string | null;
  message?: string | null;
}

export interface Occurrence {
  rule: WarningRule;
  severity: Severity;
  projectId: string | null;
  agentId: string | null;
  connectionId: string | null;
  runId: string | null;
  /** The model call to open; null opens the run. */
  callSeq: number | null;
  /** The step that tripped the rule (a tool call), for its evidence. */
  stepSeq: number | null;
  at: string;
  /** What separates warnings of one rule for one agent: the tool, tool and error kind, or window. */
  group: string;
  evidence: Evidence;
}

export interface Warning {
  id: string;
  rule: WarningRule;
  severity: Severity;
  projectId: string | null;
  agentId: string | null;
  connectionId: string | null;
  group: string;
  count: number;
  runs: number;
  firstSeen: string;
  lastSeen: string;
  worst: Occurrence;
  /** No agent's assistant owns the fix: copy the draft, don't send it. */
  platform: boolean;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export interface RunSignal {
  runId: string;
  projectId: string;
  agentId: string | null;
  startedAt: string;
  settledBy: string | null;
  finishedAt: string | null;
  medianContext: number | null;
  window: number | null;
  peakContext: number | null;
  calls: number;
  /** `runs.metadata.toolRepeats`, written at ingest. */
  repeats: ToolRepeat[] | null;
}

export interface StepSignal {
  runId: string;
  projectId: string;
  agentId: string | null;
  startedAt: string;
  kind: "compaction" | "tool_error" | "withheld";
  /** Turn id for compactions; tool name otherwise. */
  group: string;
  /** Error kind for tool errors. */
  errorKind: string | null;
  count: number;
  completed: number;
  firstSeq: number;
  maxTokens: number | null;
  limitTokens: number | null;
}

export function compactionSeverity(inOneTurn: number): Severity | null {
  if (inOneTurn >= 3) return "critical";
  return inOneTurn >= 1 ? "warn" : null;
}

export function contextSeverity(median: number | null, window: number | null): Severity | null {
  const frac = ratio(median, window);
  if (frac == null || frac <= 0.5) return null;
  return frac >= COMPACTION_THRESHOLD ? "critical" : "warn";
}

export function lowCache(calls: number, cached: number | null, input: number | null): boolean {
  const rate = ratio(cached, input);
  return rate != null && calls >= LOW_CACHE_MIN_CALLS && rate < LOW_CACHE_RATE;
}

const base = (s: { runId: string; projectId: string; agentId: string | null; startedAt: string }) => ({
  projectId: s.projectId,
  agentId: s.agentId,
  connectionId: null,
  runId: s.runId,
  at: s.startedAt,
});

/** Occurrences from per-run signals and grouped step signals. */
export function runOccurrences(runsIn: RunSignal[], steps: StepSignal[]): Occurrence[] {
  const out: Occurrence[] = [];
  const runBy = new Map(runsIn.map((r) => [r.runId, r]));

  // Compactions: one occurrence per run, at the severity of its worst turn.
  const compactions = new Map<string, { worst: StepSignal; requested: number; completed: number }>();
  for (const s of steps) {
    if (s.kind !== "compaction") continue;
    const c = compactions.get(s.runId);
    if (!c) compactions.set(s.runId, { worst: s, requested: s.count, completed: s.completed });
    else {
      c.requested += s.count;
      c.completed += s.completed;
      if (s.count > c.worst.count) c.worst = s;
    }
  }
  for (const [, c] of compactions) {
    const severity = compactionSeverity(c.worst.count);
    if (!severity) continue;
    const run = runBy.get(c.worst.runId);
    out.push({
      ...base(c.worst),
      rule: "compaction",
      severity,
      callSeq: null,
      stepSeq: null,
      group: "",
      evidence: {
        count: c.worst.count,
        requested: c.requested,
        completed: c.completed,
        window: run?.window ?? null,
        peak: run?.peakContext ?? null,
      },
    });
  }

  for (const s of steps) {
    if (s.kind === "tool_error") {
      out.push({
        ...base(s),
        rule: "tool_error",
        severity: "warn",
        callSeq: null,
        stepSeq: s.firstSeq,
        group: `${s.group}\u0000${s.errorKind ?? "error"}`,
        evidence: { tool: s.group, kind: s.errorKind ?? "error", count: s.count },
      });
    } else if (s.kind === "withheld") {
      out.push({
        ...base(s),
        rule: "withheld",
        severity: "warn",
        callSeq: null,
        stepSeq: s.firstSeq,
        group: s.group,
        evidence: { tool: s.group, count: s.count, tokens: s.maxTokens, limitTokens: s.limitTokens },
      });
    }
  }

  for (const r of runsIn) {
    for (const rep of r.repeats ?? []) {
      if (rep.count < REPEAT_THRESHOLD) continue;
      out.push({
        ...base(r),
        rule: "repeated_call",
        severity: "warn",
        callSeq: null,
        stepSeq: rep.firstSeq,
        group: rep.tool,
        evidence: { tool: rep.tool, count: rep.count, inputPreview: rep.input },
      });
    }
    const ctx = contextSeverity(r.medianContext, r.window);
    if (ctx) {
      out.push({
        ...base(r),
        rule: "context_high",
        severity: ctx,
        callSeq: null,
        stepSeq: null,
        group: "",
        evidence: { median: r.medianContext, window: r.window, peak: r.peakContext, calls: r.calls },
      });
    }
    if (r.settledBy === "stale-run-sweep") {
      out.push({
        ...base(r),
        at: r.finishedAt ?? r.startedAt,
        rule: "stale_sweep",
        severity: "warn",
        callSeq: null,
        stepSeq: null,
        group: "",
        evidence: {},
      });
    }
  }
  return out;
}

export interface ConnectionSignal {
  connectionId: string;
  calls: number;
  input: number | null;
  cached: number | null;
  rateLimited: number;
  lastAt: string | null;
  lastRateLimitedAt: string | null;
  windows: { label: string; pct: number | null; resetsAt: string | null; observedAt: string }[];
}

/** Platform occurrences for connections: plan windows over 80%, 429s, low cache. */
export function connectionOccurrences(list: ConnectionSignal[]): Occurrence[] {
  const out: Occurrence[] = [];
  const conn = (c: ConnectionSignal) => ({
    projectId: null,
    agentId: null,
    connectionId: c.connectionId,
    runId: null,
    callSeq: null,
    stepSeq: null,
  });
  for (const c of list) {
    for (const w of c.windows) {
      if (w.pct == null || w.pct <= PLAN_WARN_PCT) continue;
      out.push({
        ...conn(c),
        rule: "plan",
        severity: w.pct >= 100 ? "critical" : "warn",
        at: w.observedAt,
        group: w.label,
        evidence: { planWindow: w.label, pct: w.pct, resetsAt: w.resetsAt },
      });
    }
    if (c.rateLimited > 0) {
      out.push({
        ...conn(c),
        rule: "plan",
        severity: "critical",
        at: c.lastRateLimitedAt ?? c.lastAt ?? new Date(0).toISOString(),
        group: "429",
        evidence: { rateLimited: c.rateLimited, calls: c.calls },
      });
    }
    if (lowCache(c.calls, c.cached, c.input)) {
      out.push({
        ...conn(c),
        rule: "low_cache",
        severity: "warn",
        at: c.lastAt ?? new Date(0).toISOString(),
        group: "",
        evidence: { hitRate: ratio(c.cached, c.input), calls: c.calls, input: c.input, cached: c.cached },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------

const worstScore = (o: Occurrence): number => {
  const e = o.evidence;
  switch (o.rule) {
    case "compaction":
      return (e.count ?? 0) * 1000 + (e.requested ?? 0);
    case "tool_error":
    case "withheld":
    case "repeated_call":
      return e.count ?? 0;
    case "context_high":
      return ratio(e.median, e.window) ?? 0;
    default:
      return Date.parse(o.at);
  }
};

/** A short stable id for a warning key (used in React keys and the sheet). */
function hashKey(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return `w${(h >>> 0).toString(36)}`;
}

/**
 * One warning per (rule, repository, agent, connection, group). Severity is the worst occurrence's;
 * the worst occurrence is the evidence. Critical first, then most recent.
 */
export function groupWarnings(occurrences: Occurrence[]): Warning[] {
  const groups = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const key = [o.rule, o.projectId ?? "", o.agentId ?? "", o.connectionId ?? "", o.group].join("|");
    const list = groups.get(key);
    if (list) list.push(o);
    else groups.set(key, [o]);
  }
  const out: Warning[] = [];
  for (const [key, list] of groups) {
    const worst = list.reduce((a, b) => (worstScore(b) > worstScore(a) ? b : a));
    const times = list.map((o) => Date.parse(o.at));
    const first = list[0];
    out.push({
      id: hashKey(key),
      rule: first.rule,
      severity: list.some((o) => o.severity === "critical") ? "critical" : "warn",
      projectId: first.projectId,
      agentId: first.agentId,
      connectionId: first.connectionId,
      group: first.group,
      count: list.length,
      runs: new Set(list.map((o) => o.runId).filter(Boolean)).size,
      firstSeen: new Date(Math.min(...times)).toISOString(),
      lastSeen: new Date(Math.max(...times)).toISOString(),
      worst,
      platform: first.rule === "low_cache" || first.rule === "plan" || first.projectId == null,
    });
  }
  const rank = (w: Warning) => (w.severity === "critical" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}

/** Where a warning's evidence lives: the call that made the step, else the run. */
export function warningLink(w: Pick<Warning, "projectId" | "worst">): string | null {
  const { projectId, worst } = w;
  if (!projectId || !worst.runId) return null;
  const run = `/usage/repos/${projectId}/runs/${worst.runId}`;
  return worst.callSeq != null ? `${run}/calls/${worst.callSeq}` : run;
}

// ---------------------------------------------------------------------------------------------
// Words: title, summary, suggested fix and the draft
// ---------------------------------------------------------------------------------------------

export interface WarningNames {
  agentName: string | null;
  projectName: string | null;
  connectionLabel: string | null;
}

export interface WarningText {
  title: string;
  summary: string;
  fix: string;
  draft: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const dt = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function describeWarning(w: Warning, names: WarningNames): WarningText {
  const e = w.worst.evidence;
  const who = names.agentName ?? names.projectName ?? "Unattributed runs";
  const conn = names.connectionLabel ?? "Connection";
  const runRef = w.worst.runId ? `run ${w.worst.runId}` : "";
  let title = "";
  let summary = "";
  let fix = "";
  switch (w.rule) {
    case "compaction":
      title =
        w.severity === "critical"
          ? `${who}: ${e.count} compactions in one turn`
          : `${who}: compaction in ${plural(w.runs, "run")}`;
      summary = `Compaction fired in ${plural(w.runs, "run")}. Worst: ${runRef}, ${e.count} in one turn (${e.requested} requested, ${e.completed} completed in the run)${e.peak && e.window ? `, peak ${formatTokens(e.peak)} of a ${formatTokens(e.window)} window` : ""}.`;
      fix = "Find what fills the context before each compaction (the largest tool results in the turn) and read less: bounded ranges, summaries, or state kept between runs instead of re-reading everything.";
      break;
    case "tool_error":
      title = `${who}: ${e.tool} failing (${e.kind})`;
      summary = `${plural(w.runs, "run")} with ${e.tool} errors (${e.kind}); ${e.count} in the worst, ${runRef}.`;
      fix = "Look at the failing input and the error. Change the instructions or the tool so the agent calls it correctly, or stops retrying when it cannot succeed.";
      break;
    case "withheld":
      title = `${who}: ${e.tool} results withheld as too large`;
      summary = `${e.tool} results were withheld for size in ${plural(w.runs, "run")}${e.tokens ? `; the largest was about ${formatTokens(e.tokens)} tokens` : ""}${e.limitTokens ? ` against a ${formatTokens(e.limitTokens)} limit` : ""}.`;
      fix = "Ask for less: a bounded range, a filter or a summary, so the result stays under the limit. Don't retry the same request after a withheld result.";
      break;
    case "repeated_call":
      title = `${who}: identical ${e.tool} call repeated ×${e.count}`;
      summary = `The same ${e.tool} call with the same input ran ${e.count} times in ${runRef}. ${plural(w.runs, "run")} affected.`;
      fix = "Replace sleep-and-poll or blind retries with one blocking call, or keep the first result and reuse it.";
      break;
    case "context_high": {
      const frac = ratio(e.median, e.window);
      title = `${who}: median context ${formatPercent(frac)} of the window`;
      summary = `${plural(w.runs, "run")} with median context over 50%. Worst: ${runRef}, median ${formatTokens(e.median)} of ${formatTokens(e.window)}, peak ${formatTokens(e.peak)} over ${plural(e.calls ?? 0, "call")}.`;
      fix = "Large early results ride along on every later call. Read less up front, or summarise before continuing.";
      break;
    }
    case "low_cache":
      title = `${conn}: cache hit rate ${formatPercent(e.hitRate)}`;
      summary = `${formatTokens(e.cached)} of ${formatTokens(e.input)} input tokens cached over ${plural(e.calls ?? 0, "call")} in this window.`;
      fix = "Platform fix, not an agent change: check that the gateway sends the provider a stable session and prompt cache key, so repeated context is served from cache.";
      break;
    case "plan":
      if (w.group === "429") {
        title = `${conn}: ${e.rateLimited} × HTTP 429`;
        summary = `${plural(e.rateLimited ?? 0, "call")} rejected with 429 in this window, out of ${e.calls}.`;
      } else {
        title = `${conn}: ${e.planWindow} window at ${Math.round(e.pct ?? 0)}%`;
        summary = `The ${e.planWindow} plan window passed ${PLAN_WARN_PCT}%.${e.resetsAt ? ` It resets ${dt(e.resetsAt)}.` : ""}`;
      }
      fix = "Find the agent burning the window (burn by agent on the connection page) and slow it, or move it to another connection.";
      break;
    case "stale_sweep":
      title = `${who}: ${plural(w.count, "run")} settled by the stale sweep`;
      summary = `${w.count === 1 ? "A run" : "Runs"} never reported completion and the stale-run sweep settled ${w.count === 1 ? "it" : "them"} as failed. Latest: ${runRef}.`;
      fix = "Usually a symptom: the turn died mid-stream. Look at the last calls of the run.";
      break;
  }
  return { title, summary, fix, draft: draftFor(w, { title, summary, fix }, names) };
}

function evidenceLines(w: Warning, names: WarningNames): string[] {
  const e = w.worst.evidence;
  const L: string[] = [];
  if (w.worst.runId) {
    L.push(
      `- Run ${w.worst.runId}${names.agentName ? ` (${names.agentName})` : ""}, ${dt(w.worst.at)}${w.worst.callSeq != null ? `, step ${w.worst.callSeq}` : ""}`,
    );
  }
  if (e.tool) L.push(`- Tool: ${e.tool}${e.inputPreview ? `  input: ${e.inputPreview}` : ""}`);
  if (e.kind) L.push(`- Error kind: ${e.kind}`);
  if (e.message) L.push(`- Error: ${e.message}`);
  if (e.tokens) L.push(`- Result size: ~${e.tokens.toLocaleString("en-US")} tokens${e.limitTokens ? `; limit ${e.limitTokens.toLocaleString("en-US")}` : ""}`);
  if (e.count && w.rule !== "compaction") L.push(`- Count in that run: ${e.count}`);
  if (e.requested) L.push(`- Compactions: ${e.count} in one turn; ${e.requested} requested, ${e.completed} completed in the run`);
  if (w.rule === "context_high") L.push(`- Median context ${formatTokens(e.median)} of ${formatTokens(e.window)}, peak ${formatTokens(e.peak)}`);
  if (e.hitRate != null) L.push(`- Cache hit rate ${formatPercent(e.hitRate)} over ${plural(e.calls ?? 0, "call")}`);
  if (e.pct != null) L.push(`- ${e.planWindow} window at ${Math.round(e.pct)}%`);
  if (e.rateLimited) L.push(`- ${e.rateLimited} × 429 out of ${e.calls} calls`);
  if (w.runs > 0) L.push(`- Seen in ${plural(w.runs, "run")} between ${dt(w.firstSeen)} and ${dt(w.lastSeen)}`);
  const link = warningLink(w);
  if (link) L.push(`- Link: ${link}`);
  return L;
}

function draftFor(w: Warning, t: Omit<WarningText, "draft">, names: WarningNames): string {
  const head = w.platform ? "Platform issue" : "Warning";
  const lines = [
    `${head} (${w.severity}): ${t.title}`,
    "",
    t.summary,
    "",
    "Evidence:",
    ...evidenceLines(w, names),
    "",
    `Suggested fix: ${t.fix}`,
    "",
    w.platform
      ? "This is a harnesst platform change, not an agent change."
      : "Please look at the run, confirm the cause, and propose the change to the instructions or tools. Show me the diff before deploying.",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Ingest: repeated identical tool calls per run
// ---------------------------------------------------------------------------------------------

export interface ToolRepeat {
  tool: string;
  count: number;
  firstSeq: number;
  /** The repeated input, cut to a preview. */
  input: string;
}

/** JSON with object keys sorted, so equal inputs compare equal whatever their key order. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

/**
 * Tool calls with an identical tool and input, `REPEAT_THRESHOLD` or more times in one run, most
 * repeated first (at most `max`). Stored on the run at ingest so the warning pages never read
 * tool payloads.
 */
export function toolRepeats(
  steps: { seq: number; type: string; toolName?: string | null; data?: Record<string, unknown> | null }[],
  max = 5,
): ToolRepeat[] {
  const groups = new Map<string, ToolRepeat>();
  for (const s of steps) {
    if (s.type !== "tool_call" || !s.toolName) continue;
    const input = s.data?.input;
    if (input === undefined) continue;
    const json = stableJson(input);
    const key = `${s.toolName}\u0000${json}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      g.firstSeq = Math.min(g.firstSeq, s.seq);
    } else {
      groups.set(key, { tool: s.toolName, count: 1, firstSeq: s.seq, input: json.length > 300 ? `${json.slice(0, 300)}…` : json });
    }
  }
  return [...groups.values()]
    .filter((g) => g.count >= REPEAT_THRESHOLD)
    .sort((a, b) => b.count - a.count || a.firstSeq - b.firstSeq)
    .slice(0, max);
}

/** Parse `runs.metadata.toolRepeats` defensively (old rows have none; shapes may drift). */
export function parseToolRepeats(value: unknown): ToolRepeat[] | null {
  if (!Array.isArray(value)) return null;
  const out: ToolRepeat[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.tool !== "string" || typeof r.count !== "number" || typeof r.firstSeq !== "number") continue;
    out.push({ tool: r.tool, count: r.count, firstSeq: r.firstSeq, input: typeof r.input === "string" ? r.input : "" });
  }
  return out;
}
