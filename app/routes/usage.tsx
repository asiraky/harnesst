/**
 * Usage overview (issue #418): the top of the drill-down org → connection → repository → agent →
 * run → model call. Repositories are the ones the viewer can write to; connection cards (plan
 * headroom, calls on the subscription) are for workspace admins, like Settings → Connections.
 */
import { Activity, Gauge, Plug } from "lucide-react";
import { Link, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { AppShell, PageHeader } from "~/components/shell";
import {
  NotAvailable,
  Panel,
  Pct,
  PlanGauge,
  StatTile,
  TileGrid,
  Tokens,
  UsageCrumbs,
  usageHref,
} from "~/components/usage";
import { Badge } from "~/components/ui/badge";
import { RunTable } from "~/components/usage-run-table";
import { WarningsPanel } from "~/components/usage-warnings";
import { noindexMeta } from "~/lib/seo";
import { resolveUsageViewer } from "~/usage/access.server";
import {
  formatPercent,
  formatUsd,
  parseWindowDays,
  planWindowLabel,
  ratio,
  windowSince,
} from "~/usage/format";
import {
  agentNames,
  connectionTotals,
  latestHeadroom,
  listConnections,
  listRunRows,
  runAggregates,
} from "~/usage/queries.server";
import { addTotals, emptyTotals, rollupRuns } from "~/usage/rollup";
import { loadWarnings } from "~/usage/warnings.server";
import type { Route } from "./+types/usage";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const viewer = await resolveUsageViewer(auth, args.request);
      const days = parseWindowDays(new URL(args.request.url).searchParams.get("days"));
      const now = new Date();
      const since = windowSince(days, now);
      const ids = viewer.projects.map((p) => p.id);
      const [aggs, recent, names, connections, headroom, totals, warnings] = await Promise.all([
        runAggregates({ projectIds: ids, since }),
        listRunRows({ projectIds: ids, since, limit: 12 }),
        agentNames(ids),
        viewer.isAdmin ? listConnections(viewer.orgId) : Promise.resolve([]),
        viewer.isAdmin ? latestHeadroom(viewer.orgId) : Promise.resolve(new Map()),
        viewer.isAdmin ? connectionTotals(viewer.orgId, since) : Promise.resolve([]),
        loadWarnings({ orgId: viewer.orgId, projects: viewer.projects, since, connections: viewer.isAdmin }),
      ]);
      const byProject = rollupRuns(aggs, (a) => a.projectId);
      const org = aggs.reduce((acc, a) => addTotals(acc, a), emptyTotals());
      const totalsBy = new Map(totals.map((t) => [t.connectionId, t]));
      return {
        days,
        since: since.toISOString(),
        now: now.toISOString(),
        orgName: viewer.orgName,
        isAdmin: viewer.isAdmin,
        warnings,
        org,
        projects: viewer.projects
          .map((p) => ({ ...p, totals: byProject.get(p.id) ?? emptyTotals() }))
          .sort((a, b) => (b.totals.input ?? 0) - (a.totals.input ?? 0)),
        connections: connections.map((c) => ({
          ...c,
          headroom: headroom.get(c.id) ?? null,
          totals: totalsBy.get(c.id) ?? null,
        })),
        recent: recent.map((r) => ({
          ...r,
          agentName: r.agentId ? (names.get(r.agentId)?.name ?? null) : null,
          projectName: viewer.projects.find((p) => p.id === r.projectId)?.name ?? r.projectId,
        })),
      };
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Usage · harnesst" }, ...noindexMeta];
}

export default function UsageOverview({ loaderData }: Route.ComponentProps) {
  const { days, org, projects, connections, recent, isAdmin, orgName, warnings } = loaderData;
  const cacheHit = ratio(org.cached, org.inputWithCacheInfo);
  return (
    <AppShell>
      <UsageCrumbs items={[{ label: "Usage" }]} days={days} />
      <PageHeader
        eyebrow="Usage"
        title={orgName}
        description="Token use, context and plan headroom across your repositories. Click through to a repository, an agent, a run and a single model call."
      />
      <TileGrid>
        <StatTile label="Runs" value={org.runs.toLocaleString()} sub={`${org.failed} failed`} tone={org.failed > 0 ? "warn" : null} />
        <StatTile label="Model calls" value={org.calls.toLocaleString()} sub={org.runs ? `${Math.round(org.calls / org.runs)} per run` : undefined} />
        <StatTile label="Input" value={<Tokens value={org.input} />} sub={<>output <Tokens value={org.output} short /></>} />
        <StatTile
          label="Cache hit"
          value={<Pct value={cacheHit} />}
          sub={cacheHit == null ? "no run reported cached input" : <><Tokens value={org.cached} /> cached</>}
          tone={cacheHit != null && cacheHit < 0.2 ? "warn" : null}
        />
        <StatTile label="Peak context" value={<Tokens value={org.peakContext} />} sub="largest single call" />
        <StatTile label="Compactions" value={org.compactions ?? <NotAvailable />} sub={`${org.compactedRuns} runs affected`} tone={org.compactedRuns > 0 ? "warn" : null} />
      </TileGrid>

      <WarningsPanel warnings={warnings} days={days} grid max={6} id="warnings" />

      {isAdmin ? (
        <Panel title="Connections" icon={<Plug className="size-4" aria-hidden />} aside="Plan headroom and calls through the harnesst gateway">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No model connections yet.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {connections.map((c) => {
                const t = c.totals;
                const hit = ratio(t?.cached, t?.cacheInput);
                return (
                  <Link
                    key={c.id}
                    to={usageHref(`/usage/connections/${c.id}`, days)}
                    className="block rounded-lg border p-3 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{c.label}</div>
                        <div className="truncate text-xs text-muted-foreground">{c.accountEmail ?? c.provider}</div>
                      </div>
                      <span className="flex items-center gap-1">
                        <Badge variant="outline">{c.provider}</Badge>
                        {t?.planType && <Badge variant="secondary">{t.planType}</Badge>}
                      </span>
                    </div>
                    {c.provider === "codex" ? (
                      <>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <PlanGauge label={`${planWindowLabel(c.headroom?.primaryWindowMinutes ?? 300)} window`} pct={c.headroom?.primaryUsedPercent ?? null} resetsAt={c.headroom?.primaryResetsAt ?? null} />
                          <PlanGauge label={`${planWindowLabel(c.headroom?.secondaryWindowMinutes ?? 10080)} window`} pct={c.headroom?.secondaryUsedPercent ?? null} resetsAt={c.headroom?.secondaryResetsAt ?? null} />
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                          <span>{(t?.calls ?? 0).toLocaleString()} calls</span>
                          <span>input <Tokens value={t?.input ?? null} short /></span>
                          <span>cache hit {hit == null ? <NotAvailable short /> : formatPercent(hit)}</span>
                          <span className={t?.rateLimited ? "text-red-600" : ""}>{t?.rateLimited ?? 0} × 429</span>
                        </div>
                      </>
                    ) : (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Per-connection usage is <NotAvailable short />: only Codex calls go through the harnesst gateway's call log.
                        Costs this provider reports show on runs.
                      </p>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </Panel>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">Connection plan headroom is visible to workspace admins.</p>
      )}

      <Panel title="Repositories" icon={<Gauge className="size-4" aria-hidden />} aside="Burn by repository, from recorded runs">
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repositories you can edit.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">Repository</th>
                  <th className="py-2 pr-3 text-right font-medium">Runs</th>
                  <th className="py-2 pr-3 text-right font-medium">Calls</th>
                  <th className="py-2 pr-3 text-right font-medium">Input</th>
                  <th className="py-2 pr-3 text-right font-medium">Cache hit</th>
                  <th className="py-2 pr-3 font-medium">Peak</th>
                  <th className="py-2 pr-3 text-right font-medium">Compactions</th>
                  <th className="py-2 text-right font-medium">Reported cost</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <Link to={usageHref(`/usage/repos/${p.id}`, days)} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                      <span className="ml-2 text-xs text-muted-foreground">{p.layout === "team" ? "team" : "single agent"}</span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {p.totals.runs}
                      {p.totals.failed > 0 && <span className="ml-1 text-xs text-red-600">{p.totals.failed} failed</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{p.totals.calls.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={p.totals.input} short /></td>
                    <td className="py-2 pr-3 text-right tabular-nums"><Pct value={ratio(p.totals.cached, p.totals.inputWithCacheInfo)} short /></td>
                    <td className="py-2 pr-3"><Tokens value={p.totals.peakContext} short /></td>
                    <td className="py-2 pr-3 text-right tabular-nums">{p.totals.compactions ?? <NotAvailable short />}</td>
                    <td className="py-2 text-right tabular-nums">{p.totals.costUsd == null ? <NotAvailable short title="Only Vercel AI Gateway reports cost; Codex is a subscription" /> : formatUsd(p.totals.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recent runs" icon={<Activity className="size-4" aria-hidden />}>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs in this window.</p>
        ) : (
          <RunTable runs={recent} days={days} showRepo />
        )}
      </Panel>
    </AppShell>
  );
}
