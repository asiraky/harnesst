/**
 * One model connection (issue #418), for workspace admins. For Codex: plan headroom and the
 * hourly burn on one time axis, who burned it, and every 429. Other providers have no
 * per-connection call log, so the page says so instead of showing zeros.
 */
import { Activity, AlertTriangle, Gauge, Users } from "lucide-react";
import { Link, data, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { LocalizedDateTime } from "~/components/localized-values";
import { AppShell, PageHeader } from "~/components/shell";
import {
  ConnectionChart,
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
import { noindexMeta } from "~/lib/seo";
import { WarningsPanel } from "~/components/usage-warnings";
import { resolveUsageViewer } from "~/usage/access.server";
import { formatPercent, parseWindowDays, planWindowLabel, ratio, windowSince } from "~/usage/format";
import {
  connectionBurn,
  connectionTotals,
  getConnection,
  headroomSamples,
  latestHeadroom,
  projectNames,
  rateLimitedCalls,
} from "~/usage/queries.server";
import { attribute, burnBy, hourlySeries, type BurnShare } from "~/usage/rollup";
import { loadWarnings } from "~/usage/warnings.server";
import type { Route } from "./+types/usage.connections.$connectionId";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const viewer = await resolveUsageViewer(auth, args.request);
      // Same rule as Settings → Connections: plan headroom is the workspace's, admins only.
      if (!viewer.isAdmin) throw data("Not found", { status: 404 });
      const connection = await getConnection(viewer.orgId, args.params.connectionId!);
      if (!connection) throw data("Not found", { status: 404 });
      const days = parseWindowDays(new URL(args.request.url).searchParams.get("days"));
      const now = new Date();
      const since = windowSince(days, now);
      const base = {
        days,
        since: since.toISOString(),
        now: now.toISOString(),
        connection,
      };
      if (connection.provider !== "codex") return { ...base, codex: null };

      const [burn, samples, limited, totals, headroom, names, warnings] = await Promise.all([
        connectionBurn(viewer.orgId, connection.id, since),
        headroomSamples(viewer.orgId, connection.id, since),
        rateLimitedCalls(viewer.orgId, connection.id, since),
        connectionTotals(viewer.orgId, since),
        latestHeadroom(viewer.orgId),
        projectNames(viewer.orgId, [...viewer.visible]),
        loadWarnings({ orgId: viewer.orgId, projects: [], since, connections: connection.id }),
      ]);
      const byRepo = burnBy(burn, "project", viewer.visible, names);
      const byAgent = burnBy(burn, "agent", viewer.visible, names);
      const keyOf = (row: (typeof burn)[number]) => attribute(row, "agent", viewer.visible, names).key;
      const series = hourlySeries(burn, since, now, keyOf, byAgent.map((g) => g.key));
      const HOUR = 60 * 60 * 1000;
      const limitedHours = [
        ...new Set(
          burn
            .filter((r) => r.rateLimited > 0)
            .map((r) => Math.floor(Date.parse(r.hour) / HOUR) * HOUR),
        ),
      ];
      return {
        ...base,
        codex: {
          warnings,
          totals: totals.find((t) => t.connectionId === connection.id) ?? null,
          headroom: headroom.get(connection.id) ?? null,
          samples,
          series,
          labels: { ...Object.fromEntries(byAgent.map((g) => [g.key, g.label])), __rest: "Everything else" },
          limitedHours,
          byRepo,
          byAgent,
          // A 429 from a repository the viewer can't open is shown without its identity.
          limitedMore: limited.length > 50,
          limited: limited.slice(0, 50).map((r) => {
            const who = attribute(r, "agent", viewer.visible, names);
            return {
              startedAt: r.startedAt,
              label: who.label,
              projectId: who.projectId,
              agentName: who.agentName,
              model: who.kind === "hidden" ? null : r.model,
              errorCode: who.kind === "hidden" ? null : r.errorCode,
              errorMessage: who.kind === "hidden" ? null : r.errorMessage,
            };
          }),
        },
      };
    },
    { ensureSignedIn: true },
  );

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: `Usage · ${data?.connection.label ?? "Connection"} · harnesst` }, ...noindexMeta];
}

function BurnTable({ rows, days, title }: { rows: BurnShare[]; days: Parameters<typeof usageHref>[1]; title: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No calls in this window.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr className="border-b">
          <th className="py-2 pr-3 font-medium">{title}</th>
          <th className="py-2 pr-3 font-medium">Share of input</th>
          <th className="py-2 pr-3 text-right font-medium">Calls</th>
          <th className="py-2 pr-3 text-right font-medium">Input</th>
          <th className="py-2 pr-3 text-right font-medium">Cache hit</th>
          <th className="py-2 text-right font-medium">429s</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((g) => {
          const to =
            g.kind !== "project" || !g.projectId
              ? null
              : g.agentName
                ? `/usage/repos/${g.projectId}/agents/${encodeURIComponent(g.agentName)}`
                : `/usage/repos/${g.projectId}`;
          return (
            <tr key={g.key} className="border-b last:border-0">
              <td className="py-2 pr-3">
                {to ? (
                  <Link to={usageHref(to, days)} className="hover:underline">{g.label}</Link>
                ) : (
                  <span className="text-muted-foreground">{g.label}</span>
                )}
              </td>
              <td className="py-2 pr-3">
                <span className="flex items-center gap-2">
                  <span className="inline-block h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full bg-indigo-500" style={{ width: `${g.share * 100}%` }} />
                  </span>
                  <span className="text-xs text-muted-foreground">{formatPercent(g.share)}</span>
                </span>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{g.calls.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={g.input} short /></td>
              <td className="py-2 pr-3 text-right tabular-nums"><Pct value={ratio(g.cached, g.input)} short /></td>
              <td className={`py-2 text-right tabular-nums ${g.rateLimited ? "text-red-600" : ""}`}>{g.rateLimited}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function ConnectionUsage({ loaderData }: Route.ComponentProps) {
  const { days, since, now, connection, codex } = loaderData;
  const crumbs = [{ label: "Usage", to: "/usage" }, { label: connection.label }];
  const header = (
    <PageHeader
      eyebrow="Connection"
      title={connection.label}
      description={connection.accountEmail ?? undefined}
      actions={
        <span className="flex items-center gap-1">
          <Badge variant="outline">{connection.provider}</Badge>
          {codex?.totals?.planType && <Badge variant="secondary">{codex.totals.planType}</Badge>}
        </span>
      }
    />
  );

  if (!codex) {
    return (
      <AppShell>
        <UsageCrumbs items={crumbs} days={days} />
        {header}
        <section className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          Per-connection usage is <NotAvailable short /> for {connection.provider}: only Codex calls go through the
          harnesst gateway's call log, so there are no plan windows, hourly burn or 429s to show. Costs this provider
          reports appear on each run.
        </section>
      </AppShell>
    );
  }

  const t = codex.totals;
  const h = codex.headroom;
  // Over calls that report cached tokens, so calls without the field don't drag the rate down.
  const cacheHit = ratio(t?.cached, t?.cacheInput);
  return (
    <AppShell>
      <UsageCrumbs items={crumbs} days={days} />
      {header}
      <div className="mb-2 grid gap-3 sm:grid-cols-2">
        <PlanGauge label={`${planWindowLabel(h?.primaryWindowMinutes ?? 300)} window`} pct={h?.primaryUsedPercent ?? null} resetsAt={h?.primaryResetsAt ?? null} />
        <PlanGauge label={`${planWindowLabel(h?.secondaryWindowMinutes ?? 10080)} window`} pct={h?.secondaryUsedPercent ?? null} resetsAt={h?.secondaryResetsAt ?? null} />
      </div>
      {h && (
        <p className="mb-2 text-xs text-muted-foreground">
          Last reported <LocalizedDateTime value={h.observedAt} />
        </p>
      )}
      <TileGrid>
        <StatTile label="Calls" value={(t?.calls ?? 0).toLocaleString()} sub={t?.lastAt ? <>last <LocalizedDateTime value={t.lastAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "numeric" }} /></> : undefined} />
        <StatTile label="Input" value={<Tokens value={t?.input ?? null} />} sub={<>output <Tokens value={t?.output ?? null} short /></>} />
        <StatTile label="Cache hit" value={<Pct value={cacheHit} />} tone={cacheHit != null && cacheHit < 0.2 && (t?.cacheCalls ?? 0) >= 50 ? "warn" : null} />
        <StatTile label="Reasoning" value={<Tokens value={t?.reasoning ?? null} />} />
        <StatTile label="429s" value={t?.rateLimited ?? 0} tone={t?.rateLimited ? "crit" : null} />
        <StatTile label="Other errors" value={t?.errors ?? 0} tone={t?.errors ? "warn" : null} />
      </TileGrid>

      <WarningsPanel warnings={codex.warnings} days={days} title="Warnings on this connection" emptyText="No warnings on this connection." />

      <Panel title="Plan headroom and burn, one time axis" icon={<Activity className="size-4" aria-hidden />} aside="Bars by repository · agent, hourly (UTC)">
        <ConnectionChart since={since} until={now} samples={codex.samples} series={codex.series} labels={codex.labels} limited={codex.limitedHours} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Burn by repository" icon={<Gauge className="size-4" aria-hidden />}>
          <BurnTable rows={codex.byRepo} days={days} title="Repository" />
        </Panel>
        <Panel title="Burn by agent" icon={<Users className="size-4" aria-hidden />}>
          <BurnTable rows={codex.byAgent} days={days} title="Agent" />
        </Panel>
      </div>

      <Panel title={`Rate limited (429) · ${codex.limited.length}${codex.limitedMore ? "+" : ""}`} icon={<AlertTriangle className="size-4" aria-hidden />}>
        {codex.limited.length === 0 ? (
          <p className="text-sm text-muted-foreground">No 429s in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="py-2 pr-3 font-medium">Model</th>
                  <th className="py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {codex.limited.map((r, i) => (
                  <tr key={`${r.startedAt}-${i}`} className="border-b align-top last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap"><LocalizedDateTime value={r.startedAt} /></td>
                    <td className="py-2 pr-3">{r.label}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{r.model ?? "—"}</td>
                    <td className="py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {r.errorCode && <span className="mr-1 font-mono">{r.errorCode}</span>}
                      {r.errorMessage}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </AppShell>
  );
}
