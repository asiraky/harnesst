/**
 * Roll-ups for the usage views (issue #418), pure so the attribution rules are unit-tested.
 *
 * Attribution: a gateway call-log row names its repository only when the agent sent the identity
 * headers (images built after #420). Rows without one land in "Unattributed". Rows from a
 * repository the viewer cannot open are folded into one "Other repositories" row, so a viewer
 * never learns another repository's name or agent names from a shared connection.
 */

export interface RunAggregate {
  projectId: string;
  agentId: string | null;
  runs: number;
  failed: number;
  input: number | null;
  /** Input summed over the runs that reported cached input: the denominator of the cache hit rate. */
  inputWithCacheInfo: number | null;
  cached: number | null;
  output: number | null;
  costUsd: number | null;
  peakContext: number | null;
  compactions: number | null;
  compactedRuns: number;
  calls: number;
}

export type RunTotals = Omit<RunAggregate, "projectId" | "agentId">;

const addNullable = (a: number | null, b: number | null) =>
  a == null ? b : b == null ? a : a + b;
const maxNullable = (a: number | null, b: number | null) =>
  a == null ? b : b == null ? a : Math.max(a, b);

export function emptyTotals(): RunTotals {
  return {
    runs: 0,
    failed: 0,
    input: null,
    inputWithCacheInfo: null,
    cached: null,
    output: null,
    costUsd: null,
    peakContext: null,
    compactions: null,
    compactedRuns: 0,
    calls: 0,
  };
}

export function addTotals(into: RunTotals, row: RunTotals): RunTotals {
  return {
    runs: into.runs + row.runs,
    failed: into.failed + row.failed,
    input: addNullable(into.input, row.input),
    inputWithCacheInfo: addNullable(into.inputWithCacheInfo, row.inputWithCacheInfo),
    cached: addNullable(into.cached, row.cached),
    output: addNullable(into.output, row.output),
    costUsd: addNullable(into.costUsd, row.costUsd),
    peakContext: maxNullable(into.peakContext, row.peakContext),
    compactions: addNullable(into.compactions, row.compactions),
    compactedRuns: into.compactedRuns + row.compactedRuns,
    calls: into.calls + row.calls,
  };
}

/** Group run aggregates by a key, summing each group. */
export function rollupRuns<K>(
  rows: RunAggregate[],
  keyOf: (row: RunAggregate) => K,
): Map<K, RunTotals> {
  const out = new Map<K, RunTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    out.set(key, addTotals(out.get(key) ?? emptyTotals(), row));
  }
  return out;
}

/** One hour of one (repository, agent) on a connection, from `gateway_calls`. */
export interface BurnHour {
  hour: string;
  projectId: string | null;
  agentName: string | null;
  calls: number;
  input: number;
  cached: number;
  output: number;
  rateLimited: number;
}

export const UNATTRIBUTED = "unattributed";
export const HIDDEN = "hidden";

export interface Attribution {
  key: string;
  label: string;
  projectId: string | null;
  agentName: string | null;
  kind: "project" | "unattributed" | "hidden";
}

export function attribute(
  row: { projectId: string | null; agentName: string | null },
  by: "project" | "agent",
  visible: ReadonlySet<string>,
  projectNames: ReadonlyMap<string, string>,
): Attribution {
  if (!row.projectId)
    return {
      key: UNATTRIBUTED,
      label: "Unattributed",
      projectId: null,
      agentName: null,
      kind: "unattributed",
    };
  if (!visible.has(row.projectId))
    return {
      key: HIDDEN,
      label: "Other repositories",
      projectId: null,
      agentName: null,
      kind: "hidden",
    };
  const repo = projectNames.get(row.projectId) ?? row.projectId;
  if (by === "project")
    return { key: row.projectId, label: repo, projectId: row.projectId, agentName: null, kind: "project" };
  const agent = row.agentName ?? "unknown agent";
  return {
    key: `${row.projectId}/${agent}`,
    label: `${repo} · ${agent}`,
    projectId: row.projectId,
    agentName: row.agentName,
    kind: "project",
  };
}

export interface BurnShare extends Attribution {
  calls: number;
  input: number;
  cached: number;
  output: number;
  rateLimited: number;
  /** Share of all input tokens in the window. */
  share: number;
}

export function burnBy(
  rows: BurnHour[],
  by: "project" | "agent",
  visible: ReadonlySet<string>,
  projectNames: ReadonlyMap<string, string>,
): BurnShare[] {
  const groups = new Map<string, BurnShare>();
  let total = 0;
  for (const row of rows) {
    const a = attribute(row, by, visible, projectNames);
    const g =
      groups.get(a.key) ??
      { ...a, calls: 0, input: 0, cached: 0, output: 0, rateLimited: 0, share: 0 };
    g.calls += row.calls;
    g.input += row.input;
    g.cached += row.cached;
    g.output += row.output;
    g.rateLimited += row.rateLimited;
    groups.set(a.key, g);
    total += row.input;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, share: total > 0 ? g.input / total : 0 }))
    .sort((a, b) => b.input - a.input);
}

/**
 * Hourly input per group, on a continuous axis from `since` to `until` (hours with no calls are
 * zero, so the chart's x axis is real time). Groups beyond `maxGroups` merge into "Everything else".
 */
export function hourlySeries(
  rows: BurnHour[],
  since: Date,
  until: Date,
  keyOf: (row: BurnHour) => string,
  order: string[],
  maxGroups = 6,
): { keys: string[]; buckets: { hour: number; values: Record<string, number> }[] } {
  const HOUR = 60 * 60 * 1000;
  const keep = new Set(order.slice(0, maxGroups));
  const rest = "__rest";
  const start = Math.floor(since.getTime() / HOUR) * HOUR;
  const end = Math.floor(until.getTime() / HOUR) * HOUR;
  const buckets = new Map<number, Record<string, number>>();
  for (let h = start; h <= end; h += HOUR) buckets.set(h, {});
  for (const row of rows) {
    const h = Math.floor(Date.parse(row.hour) / HOUR) * HOUR;
    const values = buckets.get(h);
    if (!values) continue;
    const key = keep.has(keyOf(row)) ? keyOf(row) : rest;
    values[key] = (values[key] ?? 0) + row.input;
  }
  const keys = order.slice(0, maxGroups);
  if (order.length > maxGroups) keys.push(rest);
  return {
    keys,
    buckets: [...buckets.entries()].map(([hour, values]) => ({ hour, values })),
  };
}
