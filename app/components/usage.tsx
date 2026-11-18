/**
 * Building blocks for the usage views (issue #418): breadcrumb + window picker, stat tiles,
 * "not available" chips, context bars, and the hand-drawn SVG charts (no chart library: the
 * shapes are simple and the app ships none).
 */
import { ChevronRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import { LocalizedDateTime } from "~/components/localized-values";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import {
  COMPACTION_THRESHOLD,
  WINDOW_DAYS,
  contextLevel,
  formatPercent,
  formatTokens,
  ratio,
  type WindowDays,
} from "~/usage/format";
import type { TraceCall, TraceCompaction } from "~/usage/trace";

export const SERIES_COLORS = [
  "#6366f1",
  "#06b6d4",
  "#f59e0b",
  "#10b981",
  "#ec4899",
  "#8b5cf6",
  "#94a3b8",
];

export const PART_COLORS: Record<string, string> = {
  system: "#64748b",
  tools: "#06b6d4",
  messages: "#6366f1",
  toolResults: "#f59e0b",
};

/** Usage path with the current window kept. */
export function usageHref(path: string, days: WindowDays): string {
  return days === 7 ? path : `${path}?days=${days}`;
}

export function UsageCrumbs({
  items,
  days,
}: {
  items: { label: ReactNode; to?: string }[];
  days: WindowDays;
}) {
  const { pathname } = useLocation();
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
        {items.map((item, i) => (
          <span key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />}
            {item.to ? (
              <Link
                to={usageHref(item.to, days)}
                className="truncate text-muted-foreground hover:text-foreground"
              >
                {item.label}
              </Link>
            ) : (
              <span className="truncate font-medium">{item.label}</span>
            )}
          </span>
        ))}
      </nav>
      <div className="flex items-center gap-1 text-xs" role="group" aria-label="Time window">
        {WINDOW_DAYS.map((d) => (
          <Link
            key={d}
            to={usageHref(pathname, d)}
            preventScrollReset
            className={cn(
              "rounded-md border px-2 py-1 text-muted-foreground hover:text-foreground",
              d === days && "bg-muted font-medium text-foreground",
            )}
          >
            {d === 1 ? "24h" : `${d} days`}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function NotAvailable({ short, title }: { short?: boolean; title?: string }) {
  return (
    <span
      className="inline-flex items-center rounded border border-dashed px-1 text-[11px] font-normal italic text-muted-foreground"
      title={title ?? "This provider or this row does not report the figure"}
    >
      {short ? "n/a" : "not available"}
    </span>
  );
}

/** A token figure, or "not available" when it is unknown. */
export function Tokens({ value, short }: { value: number | null | undefined; short?: boolean }) {
  if (value == null) return <NotAvailable short={short} />;
  return <span title={value.toLocaleString("en-US")}>{formatTokens(value)}</span>;
}

export function Pct({ value, short }: { value: number | null | undefined; short?: boolean }) {
  if (value == null) return <NotAvailable short={short} />;
  return <span>{formatPercent(value)}</span>;
}

export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "warn" | "crit" | "good" | null;
}) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums",
          tone === "warn" && "text-amber-600 dark:text-amber-500",
          tone === "crit" && "text-red-600 dark:text-red-500",
          tone === "good" && "text-emerald-600 dark:text-emerald-500",
        )}
      >
        {value}
      </div>
      {sub != null && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function TileGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{children}</div>;
}

export function Panel({
  title,
  icon,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-6 rounded-xl border", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </h2>
        {aside && <div className="text-xs text-muted-foreground">{aside}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const levelBar = {
  ok: "bg-indigo-500",
  warn: "bg-amber-500",
  crit: "bg-red-500",
} as const;

/** One plan window's used percentage as a gauge (Codex connections). */
export function PlanGauge({ label, pct, resetsAt }: { label: string; pct: number | null; resetsAt: string | null }) {
  const tone = pct == null ? "" : pct >= 80 ? "text-red-600" : pct >= 50 ? "text-amber-600" : "";
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>
        {pct == null ? <NotAvailable /> : `${Math.round(pct)}%`}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        {pct != null && (
          <div
            className={pct >= 80 ? "h-full bg-red-500" : pct >= 50 ? "h-full bg-amber-500" : "h-full bg-indigo-500"}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        )}
      </div>
      {resetsAt && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          resets <LocalizedDateTime value={resetsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "numeric" }} />
        </div>
      )}
    </div>
  );
}

/** Context used vs window, with a tick where eve compacts. */
export function CtxBar({
  value,
  window,
  className,
}: {
  value: number | null;
  window: number | null;
  className?: string;
}) {
  const frac = ratio(value, window);
  const level = contextLevel(frac);
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span
        className="relative inline-block h-1.5 w-20 overflow-hidden rounded-full bg-muted"
        aria-hidden
      >
        {frac != null && level && (
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", levelBar[level])}
            style={{ width: `${Math.min(100, frac * 100)}%` }}
          />
        )}
        <span
          className="absolute inset-y-0 w-px bg-foreground/50"
          style={{ left: `${COMPACTION_THRESHOLD * 100}%` }}
        />
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {frac == null ? (value == null ? <NotAvailable short /> : formatTokens(value)) : formatPercent(frac)}
      </span>
    </span>
  );
}

export function RunStatus({ status, settledBy }: { status: string; settledBy?: string | null }) {
  const variant =
    status === "failed"
      ? "destructive"
      : status === "completed"
        ? "success"
        : status === "running"
          ? "default"
          : "outline";
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant={variant}>{status}</Badge>
      {settledBy === "stale-run-sweep" && (
        <Badge variant="warning" title="Closed by the stale-run sweep: the run never reported its end">
          stale sweep
        </Badge>
      )}
    </span>
  );
}

/** One proportional bar of a composition. */
export function CompositionBar({
  parts,
  window,
  className,
}: {
  parts: { key: string; tokens: number }[];
  window?: number | null;
  className?: string;
}) {
  const total = parts.reduce((a, p) => a + p.tokens, 0);
  const scale = window && window > 0 ? window : total;
  return (
    <div className={cn("relative flex h-2.5 overflow-hidden rounded-full bg-muted", className)}>
      {parts.map((p) => (
        <span
          key={p.key}
          style={{ width: `${(p.tokens / Math.max(1, scale)) * 100}%`, background: PART_COLORS[p.key] }}
        />
      ))}
      {window ? (
        <span
          className="absolute inset-y-0 w-px bg-red-500"
          style={{ left: `${COMPACTION_THRESHOLD * 100}%` }}
          title="eve compacts at 90% of the window"
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Run trace chart
// ---------------------------------------------------------------------------------------------

const W = 1000;

/**
 * Context fill per model call: one bar per call (stacked by estimated composition when the
 * gateway recorded it), markers for compactions, errors, 429s and withheld results. In
 * wall-clock mode a bar spans the call's duration, which makes it a waterfall. Clicking a bar or
 * marker opens the call.
 */
export function ContextChart({
  calls,
  compactions,
  mode,
  range,
  callHref,
}: {
  calls: TraceCall[];
  compactions: TraceCompaction[];
  mode: "order" | "time";
  range: [number, number];
  callHref: (seq: number) => string;
}) {
  const navigate = useNavigate();
  const H = 180;
  const visible = calls.filter((c) => c.index >= range[0] && c.index <= range[1]);
  const window = Math.max(0, ...visible.map((c) => c.window ?? 0));
  const yMax = window > 0 ? window : Math.max(1, ...visible.map((c) => c.input ?? 0));

  const timed = visible.filter((c) => c.startedAt);
  const t0 = timed.length ? Math.min(...timed.map((c) => Date.parse(c.startedAt!))) : 0;
  const t1 = timed.length
    ? Math.max(...timed.map((c) => Date.parse(c.startedAt!) + (c.durationMs ?? 0)))
    : 1;
  const span = Math.max(1, t1 - t0);
  const slot = W / Math.max(1, range[1] - range[0] + 1);

  const xOf = (c: TraceCall): [number, number] | null => {
    if (mode === "order") return [(c.index - range[0]) * slot, Math.max(1, slot * 0.8)];
    if (!c.startedAt) return null;
    const x = ((Date.parse(c.startedAt) - t0) / span) * W;
    return [x, Math.max(1.5, ((c.durationMs ?? 0) / span) * W)];
  };
  const y = (tokens: number) => H - (tokens / yMax) * H;

  const compactionX = (c: TraceCompaction): number | null => {
    if (mode === "order") {
      if (c.afterIndex < range[0] - 1 || c.afterIndex > range[1]) return null;
      return (c.afterIndex - range[0] + 1) * slot - slot * 0.1;
    }
    if (!c.startedAt) return null;
    const t = Date.parse(c.startedAt);
    if (t < t0 || t > t1) return null;
    return ((t - t0) / span) * W;
  };

  return (
    <div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H + 14}`}
          preserveAspectRatio="none"
          className="h-56 w-full"
          role="img"
          aria-label="Context used by each model call"
        >
          {window > 0 && (
            <>
              <line x1={0} x2={W} y1={y(window * COMPACTION_THRESHOLD)} y2={y(window * COMPACTION_THRESHOLD)} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <line x1={0} x2={W} y1={y(window * 0.5)} y2={y(window * 0.5)} stroke="#f59e0b" strokeDasharray="2 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </>
          )}
          {visible.map((c) => {
            const pos = xOf(c);
            if (!pos) return null;
            const [x, w] = pos;
            const open = () => navigate(callHref(c.seq));
            const title = `Call #${c.index} · ${formatTokens(c.input)} input${c.window ? ` of ${formatTokens(c.window)}` : ""}${c.status !== "ok" ? ` · ${c.status}` : ""}`;
            let stack: ReactNode;
            if (c.composition && c.input != null) {
              let acc = 0;
              stack = c.composition.map((p) => {
                const top = y(acc + p.tokens);
                const h = y(acc) - top;
                acc += p.tokens;
                return <rect key={p.key} x={x} width={w} y={top} height={Math.max(0, h)} fill={PART_COLORS[p.key]} />;
              });
            } else {
              const tokens = c.input ?? 0;
              const level = contextLevel(ratio(c.input, c.window));
              stack = (
                <rect x={x} width={w} y={y(tokens)} height={H - y(tokens)} fill={level === "crit" ? "#ef4444" : level === "warn" ? "#f59e0b" : "#818cf8"} />
              );
            }
            const withheld = c.tools.some((t) => t.withheld);
            return (
              <g key={c.seq} className="cursor-pointer" onClick={open}>
                <title>{title}</title>
                <rect x={x} width={Math.max(w, 3)} y={0} height={H} fill="transparent" />
                {stack}
                {(c.status !== "ok" || withheld || c.hit429) && (
                  <rect x={x} width={Math.max(w, 3)} y={H + 4} height={8} fill="#ef4444" />
                )}
              </g>
            );
          })}
          {compactions.map((c) => {
            const x = compactionX(c);
            if (x == null) return null;
            return (
              <g key={`k${c.seq}`}>
                <title>{`Compaction${c.completed ? "" : " (not completed)"} at ${formatTokens(c.usageInputTokens)}`}</title>
                <line x1={x} x2={x} y1={0} y2={H} stroke="#f59e0b" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray={c.completed ? undefined : "3 3"} />
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute left-1 top-0 text-[10px] text-muted-foreground">
          {window > 0 ? `${formatTokens(window)} window · red 90% compaction · amber 50%` : `${formatTokens(yMax)} (window not reported)`}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {Object.entries({ system: "System prompt", tools: "Tool definitions", messages: "Conversation", toolResults: "Tool results" }).map(([k, label]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: PART_COLORS[k] }} /> {label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-indigo-400" /> Input (no composition recorded)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-0.5 bg-amber-500" /> Compaction
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1 w-2 bg-red-500" /> Error, 429 or withheld result
        </span>
      </div>
    </div>
  );
}

/** Context per call as a thin strip, for the call page's "position in run". */
export function PositionStrip({
  calls,
  current,
  callHref,
}: {
  calls: { seq: number; input: number | null; window: number | null; isError: boolean }[];
  current: number;
  callHref: (seq: number) => string;
}) {
  const navigate = useNavigate();
  const H = 40;
  const max = Math.max(1, ...calls.map((c) => c.window ?? c.input ?? 0));
  const slot = W / Math.max(1, calls.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-12 w-full" role="img" aria-label="Context per call in this run">
      {calls.map((c, i) => {
        const h = ((c.input ?? 0) / max) * H;
        const isCurrent = c.seq === current;
        return (
          <g key={c.seq} className="cursor-pointer" onClick={() => navigate(callHref(c.seq))}>
            <title>{`Call #${i + 1} · ${formatTokens(c.input)}`}</title>
            <rect x={i * slot} width={Math.max(slot, 2)} y={0} height={H} fill={isCurrent ? "rgba(99,102,241,0.15)" : "transparent"} />
            <rect x={i * slot} width={Math.max(slot * 0.8, 1)} y={H - h} height={h} fill={isCurrent ? "#4f46e5" : c.isError ? "#ef4444" : "#a5b4fc"} />
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Connection chart: plan % and hourly burn on one time axis
// ---------------------------------------------------------------------------------------------

export function ConnectionChart({
  since,
  until,
  samples,
  series,
  labels,
  limited,
}: {
  since: string;
  until: string;
  /** Hours (epoch ms) with at least one 429. */
  limited: number[];
  samples: { observedAt: string; primary: number | null; secondary: number | null }[];
  series: { keys: string[]; buckets: { hour: number; values: Record<string, number> }[] };
  labels: Record<string, string>;
}) {
  const t0 = Date.parse(since);
  const t1 = Date.parse(until);
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((Math.max(t0, t) - t0) / span) * W;
  const PH = 110;
  const BH = 110;
  const lineFor = (key: "primary" | "secondary") => {
    const pts = samples.filter((s) => s[key] != null);
    if (pts.length === 0) return null;
    let d = "";
    pts.forEach((s, i) => {
      const px = x(Date.parse(s.observedAt));
      const py = PH - ((s[key] as number) / 100) * PH;
      d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
    });
    const last = pts[pts.length - 1][key] as number;
    d += `H${W}`;
    return { d, last };
  };
  const primary = lineFor("primary");
  const secondary = lineFor("secondary");
  const maxBucket = Math.max(
    1,
    ...series.buckets.map((b) => Object.values(b.values).reduce((a, v) => a + v, 0)),
  );
  const bw = W / Math.max(1, series.buckets.length);
  const colorOf = (key: string, i: number) => (key === "__rest" ? SERIES_COLORS[6] : SERIES_COLORS[i % 6]);
  const days: number[] = [];
  for (let d = Math.ceil(t0 / 86400000) * 86400000; d <= t1; d += 86400000) days.push(d);

  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">Plan used (%)</div>
      <svg viewBox={`0 0 ${W} ${PH}`} preserveAspectRatio="none" className="h-28 w-full" role="img" aria-label="Plan percentage used over time">
        <line x1={0} x2={W} y1={PH * 0.2} y2={PH * 0.2} stroke="#ef4444" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        {days.map((d) => (
          <line key={d} x1={x(d)} x2={x(d)} y1={0} y2={PH} stroke="currentColor" className="text-border" vectorEffect="non-scaling-stroke" />
        ))}
        {primary && <path d={primary.d} fill="none" stroke="#6366f1" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        {secondary && <path d={secondary.d} fill="none" stroke="#f59e0b" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="h-0.5 w-3 bg-indigo-500" /> 5h window {primary ? `(now ${Math.round(primary.last)}%)` : "(no samples)"}</span>
        <span className="inline-flex items-center gap-1"><span className="h-0.5 w-3 bg-amber-500" /> Weekly window {secondary ? `(now ${Math.round(secondary.last)}%)` : "(no samples)"}</span>
        <span className="inline-flex items-center gap-1"><span className="h-0.5 w-3 border-t border-dashed border-red-500" /> 80%</span>
      </div>
      <div className="mb-1 mt-4 text-xs text-muted-foreground">Input tokens per hour</div>
      <svg viewBox={`0 0 ${W} ${BH + 10}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="Input tokens per hour by repository or agent">
        {days.map((d) => (
          <line key={d} x1={x(d)} x2={x(d)} y1={0} y2={BH} stroke="currentColor" className="text-border" vectorEffect="non-scaling-stroke" />
        ))}
        {series.buckets.map((b) => {
          let acc = 0;
          const bx = x(b.hour);
          return (
            <g key={b.hour}>
              {series.keys.map((key, i) => {
                const v = b.values[key] ?? 0;
                if (!v) return null;
                const h = (v / maxBucket) * BH;
                acc += h;
                return (
                  <rect key={key} x={bx} width={Math.max(bw * 0.85, 1)} y={BH - acc} height={h} fill={colorOf(key, i)}>
                    <title>{`${labels[key] ?? key}: ${formatTokens(v)} · ${new Date(b.hour).toISOString().slice(0, 13).replace("T", " ")}:00 UTC`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        {limited.map((h) => (
          <rect key={`l${h}`} x={x(h)} width={Math.max(bw, 3)} y={BH + 3} height={7} fill="#ef4444">
            <title>{`429 at ${new Date(h).toISOString().slice(0, 13).replace("T", " ")}:00 UTC`}</title>
          </rect>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        {series.keys.map((key, i) => (
          <span key={key} className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: colorOf(key, i) }} />
            {labels[key] ?? key}
          </span>
        ))}
        <span className="inline-flex items-center gap-1"><span className="h-1 w-2 bg-red-500" /> 429</span>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{new Date(t0).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
        <span>{new Date(t1).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Per-run dots on a time axis (agent page) and stacked day bars (team page)
// ---------------------------------------------------------------------------------------------

export function RunDots({
  since,
  until,
  runs,
  runHref,
}: {
  since: string;
  until: string;
  runs: { id: string; startedAt: string; input: number | null; calls: number; failed: boolean; heavy: boolean }[];
  runHref: (id: string) => string;
}) {
  const navigate = useNavigate();
  const t0 = Date.parse(since);
  const span = Math.max(1, Date.parse(until) - t0);
  const lane = (label: string, valueOf: (r: (typeof runs)[number]) => number | null) => {
    const values = runs.map(valueOf).filter((v): v is number => v != null && v > 0);
    const lo = Math.log10(Math.max(1, Math.min(...values, 10)));
    const hi = Math.log10(Math.max(10, ...values));
    const H = 70;
    const y = (v: number) => H - 6 - ((Math.log10(Math.max(1, v)) - lo) / Math.max(0.01, hi - lo)) * (H - 12);
    return (
      <div className="flex items-stretch gap-2">
        <div className="w-28 shrink-0 pt-1 text-xs">
          <div className="font-medium">{label}</div>
          <div className="text-[10px] text-muted-foreground">log scale · max {formatTokens(10 ** hi)}</div>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-20 min-w-0 flex-1 rounded bg-muted/30" role="img" aria-label={label}>
          {runs.map((r) => {
            const v = valueOf(r);
            if (v == null || v <= 0) return null;
            const cx = ((Date.parse(r.startedAt) - t0) / span) * W;
            return (
              <g key={r.id} className="cursor-pointer" onClick={() => navigate(runHref(r.id))}>
                <title>{`${new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ")} · ${formatTokens(v)}${r.failed ? " · failed" : ""}`}</title>
                <rect x={cx - (r.heavy ? 4 : 2.5)} y={y(v) - (r.heavy ? 4 : 2.5)} width={r.heavy ? 8 : 5} height={r.heavy ? 8 : 5} rx={r.heavy ? 4 : 2.5} fill={r.failed ? "#ef4444" : "#6366f1"} opacity={0.8} />
              </g>
            );
          })}
        </svg>
      </div>
    );
  };
  return (
    <div className="space-y-2">
      {lane("Input per run", (r) => r.input)}
      {lane("Calls per run", (r) => r.calls)}
      <div className="flex justify-between pl-30 text-[10px] text-muted-foreground">
        <span>{new Date(t0).toISOString().slice(0, 10)}</span>
        <span>{new Date(until).toISOString().slice(0, 10)}</span>
      </div>
    </div>
  );
}

export function StackedDays({
  days,
  keys,
  labels,
}: {
  days: { day: string; values: Record<string, number> }[];
  keys: string[];
  labels: Record<string, string>;
}) {
  const max = Math.max(1, ...days.map((d) => Object.values(d.values).reduce((a, v) => a + v, 0)));
  const H = 120;
  const bw = W / Math.max(1, days.length);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="Input tokens per day by agent">
        {days.map((d, i) => {
          let acc = 0;
          return (
            <g key={d.day}>
              {keys.map((k, ki) => {
                const v = d.values[k] ?? 0;
                if (!v) return null;
                const h = (v / max) * H;
                acc += h;
                return (
                  <rect key={k} x={i * bw + bw * 0.15} width={bw * 0.7} y={H - acc} height={h} fill={SERIES_COLORS[ki % SERIES_COLORS.length]}>
                    <title>{`${labels[k] ?? k} · ${d.day.slice(0, 10)}: ${formatTokens(v)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{days[0]?.day.slice(0, 10)}</span>
        <span>{days[days.length - 1]?.day.slice(0, 10)} (UTC days)</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        {keys.map((k, i) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {labels[k] ?? k}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Pager helper for long client-side lists. */
export function usePage<T>(items: T[], size: number, shown: number) {
  return useMemo(() => items.slice(0, Math.max(size, shown)), [items, size, shown]);
}
