/**
 * Run trace (issue #418): how full the context got on each model call, what filled it, where it
 * compacted, failed or hit a 429, and every call with the tool results it fed back. The loader
 * reads scalar step columns only; a call's payloads load on the call page.
 */
import { AlertTriangle, ChevronDown, ChevronRight, ListTree, Waves } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Link, data, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { AppShell, PageHeader } from "~/components/shell";
import {
  ContextChart,
  CtxBar,
  NotAvailable,
  Panel,
  RunStatus,
  StatTile,
  Tokens,
  UsageCrumbs,
  usageHref,
} from "~/components/usage";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { listAgents } from "~/db/queries.server";
import { contextPath } from "~/lib/paths";
import { noindexMeta } from "~/lib/seo";
import { WarningsPanel } from "~/components/usage-warnings";
import { loadWarnings } from "~/usage/warnings.server";
import { formatMs } from "~/lib/time";
import { requireProject } from "~/project/guard.server";
import {
  formatTokens,
  formatUsd,
  parseWindowDays,
  ratio,
  runLabel,
} from "~/usage/format";
import {
  agentNames,
  childRuns,
  getRunRow,
  listConnections,
  traceGatewayRows,
  traceSteps,
} from "~/usage/queries.server";
import { REPEAT_THRESHOLD, type Occurrence } from "~/usage/warnings";
import { buildTrace, groupTurns, traceItems, type TraceCall, type TraceItem } from "~/usage/trace";
import type { Route } from "./+types/usage.repos.$projectId.runs.$runId";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId, { request: args.request });
      const run = await getRunRow(project.id, args.params.runId!);
      if (!run) throw data("Run not found", { status: 404 });
      const days = parseWindowDays(new URL(args.request.url).searchParams.get("days"));
      const steps = await traceSteps(run.id);
      const childIds = [...new Set(steps.map((s) => s.childSessionId).filter((v): v is string => !!v))];
      const [gateway, names, roster, children, connections] = await Promise.all([
        traceGatewayRows(project.orgId, project.id, steps),
        agentNames([project.id]),
        listAgents(project.id),
        childRuns(project.id, childIds),
        listConnections(project.orgId),
      ]);
      const trace = buildTrace(steps, gateway);
      // Repeats from the trace cover runs ingested before repeats were stored at ingest.
      const repeatOccurrences: Occurrence[] = trace.repeats
        .filter((r) => r.count >= REPEAT_THRESHOLD)
        .slice(0, 5)
        .map((r) => ({
          rule: "repeated_call",
          severity: "warn",
          projectId: project.id,
          agentId: run.agentId,
          connectionId: null,
          runId: run.id,
          callSeq: null,
          stepSeq: r.firstSeq,
          at: run.startedAt.toISOString(),
          group: r.toolName ?? "(unnamed)",
          evidence: { tool: r.toolName ?? "(unnamed)", count: r.count },
        }));
      const warnings = await loadWarnings({
        orgId: project.orgId,
        projects: [project],
        since: run.startedAt,
        runId: run.id,
        overrideOccurrences: (occ) => [...occ.filter((o) => o.rule !== "repeated_call"), ...repeatOccurrences],
      });
      const agentName = run.agentId ? (names.get(run.agentId)?.name ?? null) : null;
      return {
        days,
        project: { id: project.id, name: project.name, isTeam: project.layout === "team" },
        agentName,
        agentInRoster: !!agentName && roster.some((a) => a.name === agentName),
        run: {
          ...run,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
        },
        calls: trace.calls,
        compactions: trace.compactions,
        metrics: trace.metrics,
        warnings,
        children: Object.fromEntries(children),
        connections: connections
          .filter((c) => trace.metrics.connectionIds.includes(c.id))
          .map((c) => ({ id: c.id, label: c.label, provider: c.provider })),
      };
    },
    { ensureSignedIn: true },
  );

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: `Run ${data ? runLabel(data.run) : ""} · Usage · harnesst` }, ...noindexMeta];
}

type CallSort = "order" | "context" | "latency" | "tokens";
const PAGE = 120;

export default function RunTrace({ loaderData }: Route.ComponentProps) {
  // Following a subagent link keeps this route mounted; a fresh body per run resets zoom and filters.
  return <RunTraceBody key={loaderData.run.id} loaderData={loaderData} />;
}

function RunTraceBody({ loaderData }: Pick<Route.ComponentProps, "loaderData">) {
  const { days, project, agentName, agentInRoster, run, calls, compactions, metrics, warnings, children, connections } = loaderData;
  const [mode, setMode] = useState<"order" | "time">("order");
  const [range, setRange] = useState<[number, number]>([1, Math.max(1, calls.length)]);
  const [statusFilter, setStatusFilter] = useState<"all" | "problems">("all");
  const [minContext, setMinContext] = useState(0);
  const [sort, setSort] = useState<CallSort>("order");
  const [shown, setShown] = useState(PAGE);
  const [openCycles, setOpenCycles] = useState<Set<string>>(new Set());

  const base = `/usage/repos/${project.id}`;
  const runBase = `${base}/runs/${run.id}`;
  const callHref = (seq: number) => usageHref(`${runBase}/calls/${seq}`, days);
  const transcript = `${contextPath(project.id, project.isTeam ? agentName : null)}/runs/${run.id}`;

  const keep = (c: TraceCall) => {
    if (statusFilter === "problems" && c.status === "ok" && !c.tools.some((t) => t.isError || t.withheld)) return false;
    if (minContext > 0) {
      const frac = ratio(c.input, c.window);
      if (frac == null || frac * 100 < minContext) return false;
    }
    return true;
  };
  const filtered = calls.filter(keep);
  const filtering = statusFilter !== "all" || minContext > 0;
  const sorted = useMemo(() => {
    if (sort === "order") return filtered;
    const key: Record<CallSort, (c: TraceCall) => number> = {
      order: (c) => -c.seq,
      context: (c) => c.input ?? -1,
      latency: (c) => c.durationMs ?? -1,
      tokens: (c) => (c.input ?? 0) + (c.output ?? 0),
    };
    return [...filtered].sort((a, b) => key[sort](b) - key[sort](a));
  }, [filtered, sort]);
  const turns = useMemo(() => groupTurns(traceItems(calls, compactions)), [calls, compactions]);

  const crumbs = [
    { label: "Usage", to: "/usage" },
    ...(project.isTeam ? [{ label: project.name, to: base }] : []),
    ...(agentName && agentInRoster ? [{ label: agentName, to: `${base}/agents/${encodeURIComponent(agentName)}` }] : []),
    { label: <span className="font-mono">{runLabel(run)}</span> },
  ];
  const planTypes = [...new Set(calls.map((c) => c.planType).filter(Boolean))];

  return (
    <AppShell>
      <UsageCrumbs items={crumbs} days={days} />
      <PageHeader
        eyebrow={`Run${agentName ? ` · ${agentName}` : ""}${run.channel ? ` · ${run.channel}` : ""}`}
        title={<span className="font-mono">{runLabel(run)}</span>}
        description={`Started ${new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`}
        actions={
          <Button variant="outline" asChild>
            <Link to={transcript}>Transcript</Link>
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <StatTile label="Status" value={<RunStatus status={run.status} settledBy={run.settledBy} />} />
        <StatTile label="Calls · turns" value={`${metrics.calls} · ${metrics.turns}`} />
        <StatTile label="Input" value={<Tokens value={run.tokensInput ?? metrics.input} />} />
        <StatTile label="Cached" value={<Tokens value={run.tokensCachedInput ?? metrics.cached} />} />
        <StatTile label="Output" value={<Tokens value={run.tokensOutput ?? metrics.output} />} />
        <StatTile label="Reasoning" value={<Tokens value={metrics.reasoning} />} sub={metrics.reasoning == null ? "gateway calls only" : undefined} />
        <StatTile
          label={planTypes.length ? "Plan" : "Cost"}
          value={planTypes.length ? planTypes.join(", ") : run.costUsd == null ? <NotAvailable /> : formatUsd(run.costUsd)}
          sub={planTypes.length ? "subscription" : undefined}
        />
        <StatTile label="Peak context" value={<CtxBar value={run.peakContextTokens ?? metrics.peakContext} window={metrics.window} />} sub={<Tokens value={run.peakContextTokens ?? metrics.peakContext} />} />
        <StatTile label="Median context" value={<CtxBar value={metrics.medianContext} window={metrics.window} />} sub={<Tokens value={metrics.medianContext} />} />
        <StatTile label="Compactions" value={`${metrics.compactionsDone} / ${metrics.compactionsRequested}`} sub="done / requested" tone={metrics.compactionsRequested >= 3 ? "crit" : metrics.compactionsRequested ? "warn" : null} />
        <StatTile label="Tool results fed" value={<Tokens value={metrics.toolResultTokens} />} sub={`${metrics.toolCalls} tool calls`} />
        <StatTile label="Withheld · errors" value={`${metrics.withheld} · ${metrics.toolErrors + metrics.callErrors}`} tone={metrics.withheld + metrics.toolErrors + metrics.callErrors ? "warn" : null} sub={metrics.rateLimited ? `${metrics.rateLimited} × 429` : undefined} />
        <StatTile label="Active time" value={formatMs(metrics.activeMs)} sub={run.wallClockMs != null ? `wall clock ${formatMs(run.wallClockMs)}` : undefined} />
        <StatTile
          label="Connection"
          value={connections.length ? <span className="text-sm">{connections.map((c) => c.label).join(", ")}</span> : <NotAvailable />}
          sub={connections.length ? undefined : "no gateway call log for this run"}
        />
      </div>

      {run.settledBy === "stale-run-sweep" && (
        <Alert className="mt-4">
          <AlertTriangle className="size-4" />
          <AlertTitle>Closed by the stale-run sweep</AlertTitle>
          <AlertDescription>
            This run never reported its end, so harnesst closed it. Its totals cover only the steps that were recorded.
          </AlertDescription>
        </Alert>
      )}
      {run.error && (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{run.error}</AlertDescription>
        </Alert>
      )}
      <WarningsPanel warnings={warnings} days={days} title="Warnings in this run" compact emptyText={null} />

      <Panel
        title="Context per call"
        icon={<Waves className="size-4" aria-hidden />}
        aside={
          <span className="flex flex-wrap items-center gap-2">
            <span className="inline-flex overflow-hidden rounded-md border">
              <button type="button" className={`px-2 py-1 ${mode === "order" ? "bg-muted font-medium text-foreground" : ""}`} onClick={() => setMode("order")}>
                Call order
              </button>
              <button
                type="button"
                disabled={metrics.timedCalls === 0}
                title={metrics.timedCalls === 0 ? "No call in this run has a gateway start time" : undefined}
                className={`border-l px-2 py-1 disabled:opacity-50 ${mode === "time" ? "bg-muted font-medium text-foreground" : ""}`}
                onClick={() => setMode("time")}
              >
                Wall clock
              </button>
            </span>
            {calls.length > 1 && (
              <span className="inline-flex items-center gap-1">
                Zoom
                <input type="number" aria-label="First call" className="w-14 rounded border bg-background px-1 py-0.5" min={1} max={range[1]} value={range[0]} onChange={(e) => setRange([Math.min(Math.max(1, Number(e.target.value) || 1), range[1]), range[1]])} />
                –
                <input type="number" aria-label="Last call" className="w-14 rounded border bg-background px-1 py-0.5" min={range[0]} max={calls.length} value={range[1]} onChange={(e) => setRange([range[0], Math.max(range[0], Math.min(calls.length, Number(e.target.value) || calls.length))])} />
                {(range[0] !== 1 || range[1] !== calls.length) && (
                  <button type="button" className="underline" onClick={() => setRange([1, calls.length])}>reset</button>
                )}
              </span>
            )}
          </span>
        }
      >
        {calls.length === 0 ? (
          <p className="text-sm text-muted-foreground">No model calls were recorded for this run.</p>
        ) : (
          <>
            <ContextChart calls={calls} compactions={compactions} mode={mode} range={range} callHref={callHref} />
            {mode === "time" && metrics.timedCalls < calls.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                {calls.length - metrics.timedCalls} of {calls.length} calls have no gateway start time and are left out of wall-clock mode.
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel
        title="Calls"
        icon={<ListTree className="size-4" aria-hidden />}
        aside={
          <span className="flex flex-wrap items-center gap-2">
            <select aria-label="Status" className="rounded-md border bg-background px-2 py-1" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="all">All calls</option>
              <option value="problems">Errors, 429s, withheld</option>
            </select>
            <select aria-label="Minimum context" className="rounded-md border bg-background px-2 py-1" value={minContext} onChange={(e) => setMinContext(Number(e.target.value))}>
              <option value={0}>Any context</option>
              <option value={50}>Context ≥ 50%</option>
              <option value={90}>Context ≥ 90%</option>
            </select>
            <select aria-label="Sort" className="rounded-md border bg-background px-2 py-1" value={sort} onChange={(e) => setSort(e.target.value as CallSort)}>
              <option value="order">Call order</option>
              <option value="context">Largest context</option>
              <option value="latency">Slowest</option>
              <option value="tokens">Most tokens</option>
            </select>
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-2 font-medium">#</th>
                <th className="py-2 pr-2 font-medium">Call</th>
                <th className="py-2 pr-2 font-medium">Context vs window</th>
                <th className="py-2 pr-2 text-right font-medium">Input</th>
                <th className="py-2 pr-2 text-right font-medium">Cached</th>
                <th className="py-2 pr-2 text-right font-medium">Output</th>
                <th className="py-2 pr-2 text-right font-medium">Reasoning</th>
                <th className="py-2 pr-2 text-right font-medium">Plan · $</th>
                <th className="py-2 pr-2 text-right font-medium">Latency · TTFT</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {sort === "order" && !filtering ? (
                <GroupedRows
                  turns={turns}
                  openCycles={openCycles}
                  toggle={(key) => setOpenCycles((s) => { const next = new Set(s); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
                  shown={shown}
                  callHref={callHref}
                  childHref={(sessionId) => (children[sessionId] ? usageHref(`${base}/runs/${children[sessionId]}`, days) : null)}
                />
              ) : (
                sorted.slice(0, shown).map((c) => (
                  <CallRows key={c.seq} call={c} callHref={callHref} childHref={(id) => (children[id] ? usageHref(`${base}/runs/${children[id]}`, days) : null)} />
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {Math.min(shown, filtered.length)} of {filtered.length} calls
            {filtering && ` (of ${calls.length})`}
          </span>
          {shown < filtered.length && (
            <Button variant="outline" size="sm" onClick={() => setShown((s) => s + PAGE)}>
              Show {Math.min(PAGE, filtered.length - shown)} more
            </Button>
          )}
        </div>
      </Panel>
    </AppShell>
  );
}

/**
 * Call order, grouped by turn, then by cycle (the calls between two compactions). In a long run
 * the middle cycles fold so the start and the end stay in view.
 */
function GroupedRows({
  turns,
  openCycles,
  toggle,
  shown,
  callHref,
  childHref,
}: {
  turns: ReturnType<typeof groupTurns>;
  openCycles: Set<string>;
  toggle: (key: string) => void;
  shown: number;
  callHref: (seq: number) => string;
  childHref: (sessionId: string) => string | null;
}) {
  let budget = shown;
  return (
    <>
      {turns.map((turn, ti) => (
        <Fragment key={turn.turnId ?? `t${ti}`}>
          {turns.length > 1 && (
            <tr className="bg-muted/40">
              <td colSpan={10} className="px-2 py-1 text-xs font-medium">
                Turn {ti + 1} {turn.turnId && <span className="font-mono text-muted-foreground">{turn.turnId}</span>}
              </td>
            </tr>
          )}
          {(() => {
            const key = String(ti);
            const fold = turn.cycles.length > 4 && !openCycles.has(key);
            const folded = fold ? turn.cycles.slice(1, -2) : [];
            const foldedCalls = folded.flat().filter((i) => i.kind === "call").length;
            return turn.cycles.map((cycle, ci) => {
              if (fold && ci >= 1 && ci < turn.cycles.length - 2) {
                if (ci !== 1) return null;
                return (
                  <tr key={`fold${ci}`}>
                    <td colSpan={10} className="px-2 py-1.5">
                      <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => toggle(key)}>
                        <ChevronRight className="size-3" />
                        {folded.length} cycles folded ({foldedCalls} calls, {folded.length} compactions) · show
                      </button>
                    </td>
                  </tr>
                );
              }
              return (
                <Fragment key={`${ti}:${ci}`}>
                  {ci === 1 && turn.cycles.length > 4 && !fold && (
                    <tr>
                      <td colSpan={10} className="px-2 py-1">
                        <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => toggle(key)}>
                          <ChevronDown className="size-3" /> Fold the middle cycles
                        </button>
                      </td>
                    </tr>
                  )}
                  {cycle.map((item: TraceItem) => {
                    if (budget <= 0) return null;
                    if (item.kind === "compaction") {
                      const c = item.compaction;
                      return (
                        <tr key={`k${c.seq}`} className="bg-amber-500/5">
                          <td colSpan={10} className="px-2 py-1 text-xs text-amber-700 dark:text-amber-500">
                            Compaction {c.completed ? "" : "(requested, not completed) "}at <Tokens value={c.usageInputTokens} />
                            {c.model && <span className="text-muted-foreground"> · {c.model}</span>}
                          </td>
                        </tr>
                      );
                    }
                    budget--;
                    return <CallRows key={item.call.seq} call={item.call} callHref={callHref} childHref={childHref} />;
                  })}
                </Fragment>
              );
            });
          })()}
        </Fragment>
      ))}
    </>
  );
}

function CallRows({
  call: c,
  callHref,
  childHref,
}: {
  call: TraceCall;
  callHref: (seq: number) => string;
  childHref: (sessionId: string) => string | null;
}) {
  // A call can carry dozens of tool calls: list them only on request, but always show the ones
  // that failed or were withheld.
  const [open, setOpen] = useState(false);
  const all = c.tools.length <= 3 || open;
  const tools = all ? c.tools : c.tools.filter((t) => t.isError || t.withheld || t.childSessionId);
  const hidden = c.tools.length - tools.length;
  const fed = c.tools.reduce((a, t) => a + (t.resultTokens ?? 0), 0);
  return (
    <>
      <tr className="border-t">
        <td className="py-1.5 pr-2 text-xs tabular-nums text-muted-foreground">{c.index}</td>
        <td className="py-1.5 pr-2">
          <Link to={callHref(c.seq)} className="text-xs font-medium hover:underline">
            {c.subagentName ? `${c.subagentName} · ` : ""}step {c.stepIndex ?? "?"}
          </Link>
          {c.model && <span className="ml-1 font-mono text-[11px] text-muted-foreground">{c.model}</span>}
        </td>
        <td className="py-1.5 pr-2"><CtxBar value={c.input} window={c.window} /></td>
        <td className="py-1.5 pr-2 text-right tabular-nums"><Tokens value={c.input} short /></td>
        <td className="py-1.5 pr-2 text-right tabular-nums"><Tokens value={c.cached} short /></td>
        <td className="py-1.5 pr-2 text-right tabular-nums"><Tokens value={c.output} short /></td>
        <td className="py-1.5 pr-2 text-right tabular-nums"><Tokens value={c.reasoning} short /></td>
        <td className="py-1.5 pr-2 text-right text-xs">{c.planType ?? (c.costUsd != null ? formatUsd(c.costUsd) : <NotAvailable short />)}</td>
        <td className="py-1.5 pr-2 text-right text-xs tabular-nums">
          {formatMs(c.durationMs)}
          <span className="text-muted-foreground"> · {c.ttftMs == null ? "n/a" : formatMs(c.ttftMs)}</span>
        </td>
        <td className="py-1.5 text-xs">
          {c.status === "ok" ? (
            <span className="text-emerald-600">ok</span>
          ) : (
            <Badge variant="destructive">{c.status === "rate_limited" ? "429" : (c.errorCode ?? "error")}</Badge>
          )}
          {c.retries > 0 && <span className="ml-1 text-muted-foreground">+{c.retries} retry</span>}
        </td>
      </tr>
      {tools.map((t) => {
        const child = t.childSessionId ? childHref(t.childSessionId) : null;
        return (
          <tr key={t.seq} className="text-xs text-muted-foreground">
            <td />
            <td colSpan={2} className="max-w-0 truncate whitespace-nowrap py-0.5 pl-4 pr-2">
              <span className="font-mono">↳ {t.toolName ?? "tool"}</span>
              {t.summary && <span className="ml-2">{t.summary.slice(0, 120)}</span>}
              {child && (
                <Link to={child} className="ml-2 text-primary hover:underline">
                  subagent run →
                </Link>
              )}
            </td>
            <td className="py-0.5 pr-2 text-right tabular-nums" title="Result tokens fed back">
              {t.resultTokens == null ? "" : `+${formatTokens(t.resultTokens)}`}
            </td>
            <td colSpan={4} />
            <td className="py-0.5 pr-2 text-right tabular-nums">{formatMs(t.durationMs)}</td>
            <td className="py-0.5">
              {t.withheld ? (
                <Badge variant="destructive">withheld</Badge>
              ) : t.isError ? (
                <span className="text-red-600">error</span>
              ) : t.capped ? (
                <span title="Output was capped for storage">capped</span>
              ) : null}
            </td>
          </tr>
        );
      })}
      {c.tools.length > 3 && (
        <tr className="text-xs text-muted-foreground">
          <td />
          <td colSpan={9} className="py-0.5 pl-4">
            <button type="button" className="hover:text-foreground" onClick={() => setOpen((v) => !v)}>
              {open
                ? "Hide tool calls"
                : `${hidden > 0 && hidden < c.tools.length ? `+${hidden} more` : c.tools.length} tool calls · +${formatTokens(fed)} tokens fed back · show`}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
