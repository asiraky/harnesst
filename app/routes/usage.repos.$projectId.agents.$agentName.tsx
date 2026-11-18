/**
 * Usage for one agent (issue #418): its runs on one time axis, the tools whose results fill its
 * context, its subagents, and every run as a row that opens the run trace.
 */
import { Bot, ListOrdered, ScatterChart, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { data, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { AppShell, PageHeader } from "~/components/shell";
import {
  NotAvailable,
  Panel,
  Pct,
  RunDots,
  StatTile,
  TileGrid,
  Tokens,
  UsageCrumbs,
  usageHref,
} from "~/components/usage";
import { RunTable } from "~/components/usage-run-table";
import { WarningsPanel } from "~/components/usage-warnings";
import { Button } from "~/components/ui/button";
import { listAllAgents } from "~/db/queries.server";
import { noindexMeta } from "~/lib/seo";
import { requireProject } from "~/project/guard.server";
import {
  contextLevel,
  formatPercent,
  formatTokens,
  parseWindowDays,
  ratio,
  windowSince,
} from "~/usage/format";
import {
  listRunRows,
  runAggregates,
  subagentUsage,
  toolRanking,
} from "~/usage/queries.server";
import { addTotals, emptyTotals } from "~/usage/rollup";
import { loadWarnings } from "~/usage/warnings.server";
import type { Route } from "./+types/usage.repos.$projectId.agents.$agentName";

/** The most runs the page loads for its chart and table. */
const RUN_LIMIT = 500;

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId, { request: args.request });
      // Any agent row, the built-in assistant included: its runs spend the same tokens.
      const roster = await listAllAgents(project.id);
      const agent = roster.find((a) => a.name === args.params.agentName);
      if (!agent) throw data("Agent not found", { status: 404 });
      const days = parseWindowDays(new URL(args.request.url).searchParams.get("days"));
      const now = new Date();
      const since = windowSince(days, now);
      const scope = { projectId: project.id, agentId: agent.id, since };
      const [aggs, runRows, tools, subagents, warnings] = await Promise.all([
        runAggregates({ projectIds: [project.id], since, agentId: agent.id }),
        listRunRows({ projectIds: [project.id], since, agentId: agent.id, limit: RUN_LIMIT + 1 }),
        toolRanking(scope),
        subagentUsage(scope),
        loadWarnings({ orgId: project.orgId, projects: [project], since, agentId: agent.id }),
      ]);
      return {
        days,
        since: since.toISOString(),
        now: now.toISOString(),
        project: { id: project.id, name: project.name, isTeam: project.layout === "team" },
        agent: { id: agent.id, name: agent.name },
        totals: aggs.reduce((acc, g) => addTotals(acc, g), emptyTotals()),
        window: runRows.find((r) => r.window != null)?.window ?? null,
        runs: runRows.slice(0, RUN_LIMIT),
        truncated: runRows.length > RUN_LIMIT,
        tools,
        subagents,
        warnings,
      };
    },
    { ensureSignedIn: true },
  );

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: `Usage · ${data?.agent.name ?? "Agent"} · harnesst` }, ...noindexMeta];
}

type SortKey = "recent" | "input" | "calls" | "peak" | "compactions";

export default function AgentUsage({ loaderData }: Route.ComponentProps) {
  const { days, since, now, project, agent, totals, window, runs, truncated, tools, subagents, warnings } = loaderData;
  const [status, setStatus] = useState<"all" | "failed" | "completed" | "running">("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [shown, setShown] = useState(25);
  const base = `/usage/repos/${project.id}`;

  const filtered = useMemo(() => {
    const list = runs.filter((r) => status === "all" || r.status === status);
    const key: Record<SortKey, (r: (typeof runs)[number]) => number> = {
      recent: (r) => Date.parse(r.startedAt),
      input: (r) => r.input ?? -1,
      calls: (r) => r.calls,
      peak: (r) => r.peakContext ?? -1,
      compactions: (r) => r.compactions ?? r.compactionsRequested,
    };
    return [...list].sort((a, b) => key[sort](b) - key[sort](a));
  }, [runs, status, sort]);

  const peakFrac = ratio(totals.peakContext, window);
  const toolTokens = tools.reduce((a, t) => a + (t.tokens ?? 0), 0);
  const crumbs = project.isTeam
    ? [{ label: "Usage", to: "/usage" }, { label: project.name, to: base }, { label: agent.name }]
    : [{ label: "Usage", to: "/usage" }, { label: agent.name }];

  return (
    <AppShell>
      <UsageCrumbs items={crumbs} days={days} />
      <PageHeader
        eyebrow={project.isTeam ? `Agent · ${project.name}` : "Agent · single"}
        title={agent.name}
        description={window ? `Context window ${formatTokens(window)}` : undefined}
      />
      <TileGrid>
        <StatTile label="Runs" value={totals.runs.toLocaleString()} sub={`${totals.failed} failed`} tone={totals.failed ? "warn" : null} />
        <StatTile label="Model calls" value={totals.calls.toLocaleString()} sub={totals.runs ? `${Math.round(totals.calls / totals.runs)} per run avg` : undefined} />
        <StatTile label="Input" value={<Tokens value={totals.input} />} sub={totals.input != null && totals.runs ? `${formatTokens(totals.input / totals.runs)} per run` : undefined} />
        <StatTile
          label="Cache hit"
          value={<Pct value={ratio(totals.cached, totals.inputWithCacheInfo)} />}
          sub={totals.cached == null ? undefined : <><Tokens value={totals.cached} /> cached</>}
        />
        <StatTile
          label="Peak context"
          value={peakFrac == null ? <Tokens value={totals.peakContext} /> : formatPercent(peakFrac)}
          sub={peakFrac == null ? undefined : `${formatTokens(totals.peakContext)} of ${formatTokens(window)}`}
          tone={contextLevel(peakFrac) === "crit" ? "crit" : contextLevel(peakFrac) === "warn" ? "warn" : null}
        />
        <StatTile label="Compactions" value={totals.compactions ?? <NotAvailable />} sub={`${totals.compactedRuns} runs affected`} tone={totals.compactedRuns ? "warn" : null} />
      </TileGrid>

      <WarningsPanel warnings={warnings} days={days} title={`Warnings for ${agent.name}`} max={4} emptyText={null} />

      <Panel
        title="Per run, on one time axis"
        icon={<ScatterChart className="size-4" aria-hidden />}
        aside="Each dot is a run · larger = 3+ compactions or closed by the stale sweep · red = failed · click to open its trace"
      >
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs in this window.</p>
        ) : (
          <RunDots
            since={since}
            until={now}
            runs={runs.map((r) => ({
              id: r.id,
              startedAt: r.startedAt,
              input: r.input,
              calls: r.calls,
              failed: r.status === "failed",
              heavy: (r.compactions ?? r.compactionsRequested) >= 3 || r.settledBy === "stale-run-sweep",
            }))}
            runHref={(id) => usageHref(`${base}/runs/${id}`, days)}
          />
        )}
      </Panel>

      <Panel title="Tools, ranked by tokens fed back" icon={<Wrench className="size-4" aria-hidden />} aside="Tool results become input on every later call">
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tool calls in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">Tool</th>
                  <th className="py-2 pr-3 font-medium">Share</th>
                  <th className="py-2 pr-3 text-right font-medium">Tokens fed</th>
                  <th className="py-2 pr-3 text-right font-medium">Calls</th>
                  <th className="py-2 pr-3 text-right font-medium">Avg result</th>
                  <th className="py-2 pr-3 text-right font-medium">Largest</th>
                  <th className="py-2 pr-3 text-right font-medium">Withheld</th>
                  <th className="py-2 text-right font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => {
                  const share = toolTokens > 0 && t.tokens != null ? t.tokens / toolTokens : null;
                  return (
                    <tr key={t.toolName} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-mono text-xs">{t.toolName}</td>
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-2">
                          <span className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full bg-amber-500" style={{ width: `${(share ?? 0) * 100}%` }} />
                          </span>
                          <span className="text-xs text-muted-foreground">{share == null ? "" : formatPercent(share)}</span>
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={t.tokens} short /></td>
                      <td className="py-2 pr-3 text-right tabular-nums">{t.calls.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={t.avgTokens} short /></td>
                      <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={t.maxTokens} short /></td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${t.withheld ? "text-red-600" : ""}`}>{t.withheld}</td>
                      <td className={`py-2 text-right tabular-nums ${t.errors ? "text-red-600" : ""}`}>{t.errors}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {subagents.length > 0 && (
        <Panel title="Subagents" icon={<Bot className="size-4" aria-hidden />}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">Subagent</th>
                <th className="py-2 pr-3 text-right font-medium">Runs</th>
                <th className="py-2 pr-3 text-right font-medium">Calls</th>
                <th className="py-2 pr-3 text-right font-medium">Input</th>
                <th className="py-2 text-right font-medium">Peak context</th>
              </tr>
            </thead>
            <tbody>
              {subagents.map((s) => (
                <tr key={s.name} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-mono text-xs">{s.name}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{s.runs}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{s.calls}</td>
                  <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={s.input} short /></td>
                  <td className="py-2 text-right tabular-nums"><Tokens value={s.peak} short /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel
        title="Runs"
        icon={<ListOrdered className="size-4" aria-hidden />}
        aside={
          <span className="flex flex-wrap items-center gap-2">
            <select aria-label="Status" className="rounded-md border bg-background px-2 py-1 text-xs" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setShown(25); }}>
              <option value="all">All statuses</option>
              <option value="failed">Failed</option>
              <option value="completed">Completed</option>
              <option value="running">Running</option>
            </select>
            <select aria-label="Sort" className="rounded-md border bg-background px-2 py-1 text-xs" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="recent">Newest</option>
              <option value="input">Most input</option>
              <option value="calls">Most calls</option>
              <option value="peak">Peak context</option>
              <option value="compactions">Most compactions</option>
            </select>
          </span>
        }
      >
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs match.</p>
        ) : (
          <>
            <RunTable runs={filtered.slice(0, shown)} days={days} />
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                Showing {Math.min(shown, filtered.length)} of {filtered.length}
                {truncated && ` (the ${runs.length} most recent runs in the window)`}
              </span>
              {shown < filtered.length && (
                <Button variant="outline" size="sm" onClick={() => setShown((s) => s + 25)}>
                  Show 25 more
                </Button>
              )}
            </div>
          </>
        )}
      </Panel>
    </AppShell>
  );
}
