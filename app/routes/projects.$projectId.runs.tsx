/**
 * Run list (Observe pillar, M3 — PRD §7.6). A health-at-a-glance header (success rate, errors,
 * p50/p95 wall-clock, tokens + an activity sparkline) computed in SQL over the CURRENT filter
 * window, then a faceted, sortable table that surfaces the interesting run — not just reverse-
 * chronological noise. Filters (release, status, channel, time range) and sort compose as GET
 * params and auto-submit. When a release is selected we also show the all-releases baseline so
 * "is this version better?" is answerable inline (compare-by-version — the emergent A/B, D10).
 * Member-scoped (M5.8): team members' runs live at /repos/:id/agents/:name/runs.
 */
import { sessionLoader } from "~/auth/session.server";
import { Activity, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import {
  Link,
  redirect,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";

import {
  AgentNav,
  AppShell,
  PageHeader,
  accentText,
  repoCrumbs,
  type Accent,
} from "~/components/shell";
import {
  LocalizedDateTime,
  LocalizedNumber,
} from "~/components/localized-values";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { listReleases } from "~/db/queries.server";
import { contextPath } from "~/lib/paths";
import {
  listRunChannels,
  listRuns,
  runStats,
  type RunFilter,
  type RunSort,
  type RunStats,
} from "~/observability/store.server";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
  requireActiveAgent,
} from "~/project/agent-context.server";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.runs";

/** Time-range facet → lower bound on startedAt (undefined = all time). */
const RANGES: Record<string, number | undefined> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: undefined,
};

const SORTS: RunSort[] = ["newest", "slowest", "tokens", "errors"];
const STATUSES = ["all", "completed", "failed", "running"] as const;

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId, {
        request: args.request,
      });
      const agentName = agentFromParams(args.params);
      if (!agentName) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentName,
      );
      requireActiveAgent(active, project.id);
      // Teams have no repo-level Runs — the tab exists only at the member level.
      if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);

      const params = new URL(args.request.url).searchParams;
      // "all" is the picker's explicit no-filter sentinel (Radix items can't be empty).
      const rawRelease = params.get("release");
      const releaseId =
        rawRelease && rawRelease !== "all" ? rawRelease : undefined;
      const rawStatus = params.get("status");
      const status =
        rawStatus === "completed" ||
        rawStatus === "failed" ||
        rawStatus === "running"
          ? rawStatus
          : undefined;
      const rawChannel = params.get("channel");
      const channel =
        rawChannel && rawChannel !== "all" ? rawChannel : undefined;
      const range = params.get("range") ?? "7d";
      const rangeMs = RANGES[range];
      const since = rangeMs ? new Date(Date.now() - rangeMs) : undefined;
      const rawSort = params.get("sort");
      const sort: RunSort = SORTS.includes(rawSort as RunSort)
        ? (rawSort as RunSort)
        : "newest";

      const filter: RunFilter = {
        releaseId,
        agentId: active.id,
        status,
        channel,
        since,
        sort,
      };

      const [runsList, stats, releasesList, channels] = await Promise.all([
        listRuns(project.id, filter),
        runStats(project.id, filter),
        listReleases(project.id),
        listRunChannels(project.id, active.id),
      ]);
      // Compare-by-version: when a release is selected, the all-releases baseline (same window,
      // no release filter) answers "is this release better?" inline.
      const baseline = releaseId
        ? await runStats(project.id, { ...filter, releaseId: undefined })
        : null;

      return {
        project: { id: project.id, name: project.name },
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        runs: runsList,
        stats,
        baseline,
        channels,
        releases: releasesList.filter(
          (r) => !isTeam || r.agentId === active.id,
        ),
        filters: { releaseId, status, channel, range, sort },
      };
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Runs · harnesst" }];
}

function ms(n: number | null) {
  return n == null ? "—" : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

function statusVariant(
  status: string,
): "default" | "outline" | "destructive" | "success" | "warning" {
  if (status === "failed") return "destructive";
  if (status === "completed" || status === "success") return "success";
  if (status === "running") return "default";
  if (status === "queued" || status === "pending") return "warning";
  return "outline";
}

const DOT: Record<string, string> = {
  completed: "bg-emerald-500",
  success: "bg-emerald-500",
  failed: "bg-destructive",
  running: "bg-primary animate-pulse",
  queued: "bg-amber-500",
  pending: "bg-amber-500",
};

type RunRow = Route.ComponentProps["loaderData"]["runs"][number];

export default function Runs({ loaderData }: Route.ComponentProps) {
  const {
    project,
    roster,
    activeAgent,
    isTeam,
    runs,
    stats,
    baseline,
    channels,
    releases,
    filters,
  } = loaderData;
  const ctx = contextPath(project.id, isTeam ? activeAgent : null);
  const [params, setParams] = useSearchParams();

  // Facets are GET params; changing one navigates (loader re-runs). "all"/default clears it.
  const setFacet = (key: string, value: string, clearWhen: string) => {
    setParams(
      (prev) => {
        if (value === clearWhen) prev.delete(key);
        else prev.set(key, value);
        return prev;
      },
      { preventScrollReset: true },
    );
  };

  const maxDuration = runs.reduce((m, r) => Math.max(m, r.wallClockMs ?? 0), 0);

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: "Runs" }],
      })}
    >
      <AgentNav
        base={ctx}
        level={isTeam ? "member" : "single"}
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />
      <PageHeader
        icon={Activity}
        accent="indigo"
        title={isTeam ? `Runs — ${activeAgent}` : "Runs"}
        description="Health at a glance, then a faceted, sortable list of every run."
      />

      {/* Health header — over the current filter window */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <StatCard
          label="Success rate"
          value={
            stats.successRate == null
              ? "—"
              : `${Math.round(stats.successRate * 100)}%`
          }
          accent={stats.successRate != null ? "emerald" : undefined}
          sub={
            baseline?.successRate != null
              ? `all: ${Math.round(baseline.successRate * 100)}%`
              : undefined
          }
        />
        <StatCard
          label="Errors"
          value={String(stats.failed)}
          tone={stats.failed > 0 ? "bad" : undefined}
          sub={baseline ? `all: ${baseline.failed}` : undefined}
        />
        <StatCard
          label="p50 wall"
          value={ms(stats.p50Ms)}
          accent="indigo"
          sub={
            baseline?.p50Ms != null ? `all: ${ms(baseline.p50Ms)}` : undefined
          }
        />
        <StatCard
          label="p95 wall"
          value={ms(stats.p95Ms)}
          accent="indigo"
          sub={
            baseline?.p95Ms != null ? `all: ${ms(baseline.p95Ms)}` : undefined
          }
        />
        <StatCard
          label="Tokens"
          value={<LocalizedNumber value={stats.tokens} />}
          accent="brand"
          sub={
            baseline ? (
              <>
                all: <LocalizedNumber value={baseline.tokens} />
              </>
            ) : undefined
          }
        />
      </div>
      <Card className="mb-6">
        <CardContent className="flex items-center justify-between gap-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Activity
            </p>
            <p className="text-sm text-muted-foreground">
              {stats.total} run{stats.total === 1 ? "" : "s"} in window
              {stats.running > 0 ? ` · ${stats.running} running` : ""}
            </p>
          </div>
          <Sparkline runs={runs} />
        </CardContent>
      </Card>

      {/* Faceted filters + sort (all GET params; auto-submit on change) */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <Facet
          label="Version"
          value={filters.releaseId ?? "all"}
          onChange={(v) => setFacet("release", v, "all")}
          options={[
            { value: "all", label: "All" },
            ...releases.map((r) => ({ value: r.id, label: r.version })),
          ]}
        />
        <Facet
          label="Status"
          value={filters.status ?? "all"}
          onChange={(v) => setFacet("status", v, "all")}
          options={STATUSES.map((s) => ({ value: s, label: s }))}
        />
        {channels.length > 0 && (
          <Facet
            label="Channel"
            value={filters.channel ?? "all"}
            onChange={(v) => setFacet("channel", v, "all")}
            options={[
              { value: "all", label: "All" },
              ...channels.map((c) => ({ value: c, label: c })),
            ]}
          />
        )}
        <Facet
          label="Range"
          value={filters.range}
          onChange={(v) => setFacet("range", v, "7d")}
          options={[
            { value: "24h", label: "24h" },
            { value: "7d", label: "7d" },
            { value: "30d", label: "30d" },
            { value: "all", label: "All" },
          ]}
        />
        <div className="ml-auto">
          <Facet
            label="Sort"
            value={filters.sort}
            onChange={(v) => setFacet("sort", v, "newest")}
            options={[
              { value: "newest", label: "Newest" },
              { value: "slowest", label: "Slowest" },
              { value: "tokens", label: "Most tokens" },
              { value: "errors", label: "Errors first" },
            ]}
          />
        </div>
      </div>

      {runs.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <div className="mx-auto mb-1 flex size-12 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <Inbox className="size-6" aria-hidden />
            </div>
            <CardTitle className="text-lg">No runs match</CardTitle>
            <CardDescription>
              Adjust the filters, or point an instance at{" "}
              <span className="font-mono">/api/ingest/runs</span> with an ingest
              token to start recording runs — tokens are created on the
              repository&rsquo;s Settings tab.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <RunTableRow
                    key={r.id}
                    run={r}
                    ctx={ctx}
                    maxDuration={maxDuration}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {runs.length >= 200 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the latest 200 runs in this window.
        </p>
      )}
    </AppShell>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "bad";
  /** Tints the metric number for a categorical/semantic accent (ignored when tone==="bad"). */
  accent?: Accent;
}) {
  const numberColor =
    tone === "bad" ? "text-destructive" : accent ? accentText[accent] : "";
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`mt-0.5 text-lg font-semibold ${numberColor}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Facet({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="min-w-28 capitalize">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="capitalize">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Runs-per-bucket over the shown window as inline SVG bars; error runs tinted. No chart lib. */
function Sparkline({ runs }: { runs: RunRow[] }) {
  if (runs.length === 0) return null;
  const times = runs.map((r) => new Date(r.startedAt).getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  const N = 24;
  const total = new Array(N).fill(0);
  const failed = new Array(N).fill(0);
  for (const r of runs) {
    const t = new Date(r.startedAt).getTime();
    const idx =
      max === min
        ? N - 1
        : Math.min(N - 1, Math.floor(((t - min) / (max - min)) * (N - 1)));
    total[idx] += 1;
    if (r.status === "failed") failed[idx] += 1;
  }
  const peak = Math.max(1, ...total);
  const W = 160;
  const H = 36;
  const bw = W / N;
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="shrink-0"
      role="img"
      aria-label="Run activity over the window"
    >
      {total.map((count, i) => {
        const h = (count / peak) * H;
        const fh = (failed[i] / peak) * H;
        return (
          <g key={i}>
            <rect
              x={i * bw + 1}
              y={H - h}
              width={Math.max(1, bw - 2)}
              height={h}
              className="fill-indigo-500/40"
              rx={1}
            />
            {fh > 0 && (
              <rect
                x={i * bw + 1}
                y={H - fh}
                width={Math.max(1, bw - 2)}
                height={fh}
                className="fill-destructive"
                rx={1}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function RunTableRow({
  run,
  ctx,
  maxDuration,
}: {
  run: RunRow;
  ctx: string;
  maxDuration: number;
}) {
  const tokens = (run.tokensInput ?? 0) + (run.tokensOutput ?? 0);
  const durPct =
    run.wallClockMs != null && maxDuration > 0
      ? Math.max(3, Math.round((run.wallClockMs / maxDuration) * 100))
      : 0;
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex items-center gap-2">
          <span
            className={`size-1.5 shrink-0 rounded-full ${DOT[run.status] ?? "bg-muted-foreground"}`}
            aria-hidden
          />
          <Link
            to={`${ctx}/runs/${run.id}`}
            className="font-mono underline-offset-4 hover:underline"
          >
            {run.externalRunId?.slice(0, 12) ?? run.id.slice(0, 8)}
          </Link>
          {run.channel && (
            <span className="text-muted-foreground">{run.channel}</span>
          )}
        </div>
        {run.status === "failed" && run.error && (
          <p className="mt-1 max-w-md truncate pl-3.5 text-xs text-destructive/80">
            {run.error}
          </p>
        )}
      </TableCell>
      <TableCell className="align-top">{run.version ?? "—"}</TableCell>
      <TableCell className="align-top">
        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
      </TableCell>
      <TableCell
        className="align-top text-muted-foreground"
        title={`${run.tokensInput ?? 0} in / ${run.tokensOutput ?? 0} out`}
      >
        {tokens || "—"}
      </TableCell>
      <TableCell className="align-top text-muted-foreground">
        <div className="flex items-center gap-2">
          {durPct > 0 && (
            <span className="hidden h-1 w-12 overflow-hidden rounded-full bg-muted sm:inline-block">
              <span
                className="block h-full rounded-full bg-muted-foreground/50"
                style={{ width: `${durPct}%` }}
              />
            </span>
          )}
          {ms(run.wallClockMs)}
        </div>
      </TableCell>
      <TableCell className="align-top text-muted-foreground">
        <LocalizedDateTime value={run.startedAt} />
      </TableCell>
    </TableRow>
  );
}
