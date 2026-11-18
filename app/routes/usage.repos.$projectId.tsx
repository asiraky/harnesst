/**
 * Usage for one repository (issue #418). A team gets its members side by side; a single-agent
 * repository is its agent, so it goes straight to the agent page.
 */
import { BarChart3, Flame, Users } from "lucide-react";
import { Link, redirect, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { AppShell, PageHeader } from "~/components/shell";
import {
  NotAvailable,
  Panel,
  Pct,
  StatTile,
  StackedDays,
  TileGrid,
  Tokens,
  UsageCrumbs,
  usageHref,
} from "~/components/usage";
import { RunTable } from "~/components/usage-run-table";
import { WarningsPanel } from "~/components/usage-warnings";
import { listAgents, listAllAgents } from "~/db/queries.server";
import { noindexMeta } from "~/lib/seo";
import { loadWarnings } from "~/usage/warnings.server";
import { requireProject } from "~/project/guard.server";
import { parseWindowDays, ratio, windowSince } from "~/usage/format";
import {
  agentNames,
  dailyInputByAgent,
  listRunRows,
  runAggregates,
} from "~/usage/queries.server";
import { addTotals, emptyTotals } from "~/usage/rollup";
import type { Route } from "./+types/usage.repos.$projectId";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId, { request: args.request });
      const days = parseWindowDays(new URL(args.request.url).searchParams.get("days"));
      const [roster, allAgents] = await Promise.all([listAgents(project.id), listAllAgents(project.id)]);
      if (project.layout !== "team" && roster.length === 1) {
        throw redirect(
          usageHref(`/usage/repos/${project.id}/agents/${encodeURIComponent(roster[0].name)}`, days),
        );
      }
      const now = new Date();
      const since = windowSince(days, now);
      const [aggs, daily, top, names, warnings] = await Promise.all([
        runAggregates({ projectIds: [project.id], since }),
        dailyInputByAgent(project.id, since),
        listRunRows({ projectIds: [project.id], since, limit: 10, orderBy: "input" }),
        agentNames([project.id]),
        loadWarnings({ orgId: project.orgId, projects: [project], since }),
      ]);
      const nameOf = (id: string | null) => (id ? (names.get(id)?.name ?? "removed agent") : "Unattributed");
      const members = [
        ...roster.map((a) => ({
          key: a.id,
          name: a.name,
          linked: true,
          totals: aggs.filter((g) => g.agentId === a.id).reduce((acc, g) => addTotals(acc, g), emptyTotals()),
        })),
        ...aggs
          .filter((g) => !roster.some((a) => a.id === g.agentId))
          .map((g) => ({
            key: g.agentId ?? "none",
            name: nameOf(g.agentId),
            // The built-in assistant is not a roster member but has its own agent page.
            linked: allAgents.some((a) => a.id === g.agentId),
            totals: addTotals(emptyTotals(), g),
          })),
      ].sort((a, b) => (b.totals.input ?? 0) - (a.totals.input ?? 0));

      // Day buckets over the whole window, so empty days show as gaps.
      const dayKeys: string[] = [];
      const start = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
      for (let d = start; d <= now.getTime(); d += 86400000) dayKeys.push(new Date(d).toISOString());
      const byDay = new Map(dayKeys.map((d) => [d, {} as Record<string, number>]));
      for (const row of daily) {
        const values = byDay.get(row.day);
        if (values) values[row.agentId ?? "none"] = (values[row.agentId ?? "none"] ?? 0) + row.input;
      }
      return {
        days,
        project: { id: project.id, name: project.name, layout: project.layout },
        totals: aggs.reduce((acc, g) => addTotals(acc, g), emptyTotals()),
        members,
        series: {
          days: dayKeys.map((day) => ({ day, values: byDay.get(day)! })),
          keys: members.map((m) => m.key),
          labels: Object.fromEntries(members.map((m) => [m.key, m.name])),
        },
        warnings,
        top: top.map((r) => ({ ...r, projectName: project.name, agentName: r.agentId ? (names.get(r.agentId)?.name ?? null) : null })),
      };
    },
    { ensureSignedIn: true },
  );

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: `Usage · ${data?.project.name ?? "Repository"} · harnesst` }, ...noindexMeta];
}

export default function RepoUsage({ loaderData }: Route.ComponentProps) {
  const { days, project, totals, members, series, top, warnings } = loaderData;
  return (
    <AppShell>
      <UsageCrumbs items={[{ label: "Usage", to: "/usage" }, { label: project.name }]} days={days} />
      <PageHeader eyebrow={project.layout === "team" ? "Team" : "Repository"} title={project.name} />
      <TileGrid>
        <StatTile label="Runs" value={totals.runs.toLocaleString()} sub={`${totals.failed} failed`} tone={totals.failed ? "warn" : null} />
        <StatTile label="Model calls" value={totals.calls.toLocaleString()} />
        <StatTile label="Input" value={<Tokens value={totals.input} />} sub={<>output <Tokens value={totals.output} short /></>} />
        <StatTile label="Cache hit" value={<Pct value={ratio(totals.cached, totals.inputWithCacheInfo)} />} />
        <StatTile label="Peak context" value={<Tokens value={totals.peakContext} />} />
        <StatTile label="Compactions" value={totals.compactions ?? <NotAvailable />} sub={`${totals.compactedRuns} runs affected`} tone={totals.compactedRuns ? "warn" : null} />
      </TileGrid>

      <WarningsPanel warnings={warnings} days={days} grid max={4} />

      <Panel title="Input tokens by member, per day" icon={<BarChart3 className="size-4" aria-hidden />}>
        <StackedDays days={series.days} keys={series.keys} labels={series.labels} />
      </Panel>

      <Panel title="Members" icon={<Users className="size-4" aria-hidden />}>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents in this repository yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">Agent</th>
                  <th className="py-2 pr-3 text-right font-medium">Runs</th>
                  <th className="py-2 pr-3 text-right font-medium">Calls</th>
                  <th className="py-2 pr-3 text-right font-medium">Input</th>
                  <th className="py-2 pr-3 text-right font-medium">Cache hit</th>
                  <th className="py-2 pr-3 text-right font-medium">Peak</th>
                  <th className="py-2 text-right font-medium">Compactions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.key} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      {m.linked ? (
                        <Link to={usageHref(`/usage/repos/${project.id}/agents/${encodeURIComponent(m.name)}`, days)} className="font-medium hover:underline">
                          {m.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{m.name}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {m.totals.runs}
                      {m.totals.failed > 0 && <span className="ml-1 text-xs text-red-600">{m.totals.failed} failed</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{m.totals.calls.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={m.totals.input} short /></td>
                    <td className="py-2 pr-3 text-right tabular-nums"><Pct value={ratio(m.totals.cached, m.totals.inputWithCacheInfo)} short /></td>
                    <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={m.totals.peakContext} short /></td>
                    <td className="py-2 text-right tabular-nums">{m.totals.compactions ?? <NotAvailable short />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Heaviest runs" icon={<Flame className="size-4" aria-hidden />} aside="by input tokens">
        {top.length === 0 ? <p className="text-sm text-muted-foreground">No runs in this window.</p> : <RunTable runs={top} days={days} showRepo />}
      </Panel>
    </AppShell>
  );
}
