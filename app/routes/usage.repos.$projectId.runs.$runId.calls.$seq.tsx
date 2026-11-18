/**
 * One model call (issue #418): its tokens, what it cost on the subscription, timing, identity,
 * the estimated context composition, and the tool results it fed back. This is the only usage
 * page that reads step payloads, and only for this call's own tool calls.
 */
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link, data, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { LocalizedDateTime } from "~/components/localized-values";
import { AppShell } from "~/components/shell";
import {
  CompositionBar,
  CtxBar,
  NotAvailable,
  PART_COLORS,
  PositionStrip,
  Tokens,
  UsageCrumbs,
  usageHref,
} from "~/components/usage";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { noindexMeta } from "~/lib/seo";
import { formatMs } from "~/lib/time";
import { requireProject } from "~/project/guard.server";
import {
  formatPercent,
  formatTokens,
  formatUsd,
  parseWindowDays,
  ratio,
  runLabel,
} from "~/usage/format";
import {
  agentNames,
  getConnection,
  getRunRow,
  headroomAround,
  toolPayloads,
  traceGatewayRows,
  traceSteps,
} from "~/usage/queries.server";
import { buildTrace } from "~/usage/trace";
import type { Route } from "./+types/usage.repos.$projectId.runs.$runId.calls.$seq";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId, { request: args.request });
      const run = await getRunRow(project.id, args.params.runId!);
      if (!run) throw data("Run not found", { status: 404 });
      const seq = Number(args.params.seq);
      const days = parseWindowDays(new URL(args.request.url).searchParams.get("days"));
      const steps = await traceSteps(run.id);
      const trace = buildTrace(steps, await traceGatewayRows(project.orgId, steps));
      const at = trace.calls.findIndex((c) => c.seq === seq);
      if (at < 0) throw data("Call not found", { status: 404 });
      const call = trace.calls[at];
      const nextSeq = trace.calls[at + 1]?.seq ?? null;
      const started = call.startedAt ? new Date(call.startedAt) : null;
      const [tools, names, connection, headroom] = await Promise.all([
        toolPayloads(run.id, call.seq, nextSeq),
        agentNames([project.id]),
        call.connectionId ? getConnection(project.orgId, call.connectionId) : Promise.resolve(null),
        call.connectionId && started
          ? headroomAround(project.orgId, call.connectionId, started, new Date(started.getTime() + (call.durationMs ?? 0)))
          : Promise.resolve(null),
      ]);
      const turnIds = [...new Set(trace.calls.map((c) => c.turnId ?? ""))];
      return {
        days,
        project: { id: project.id, name: project.name, isTeam: project.layout === "team" },
        agentName: run.agentId ? (names.get(run.agentId)?.name ?? null) : null,
        run: { id: run.id, externalRunId: run.externalRunId, startedAt: run.startedAt.toISOString() },
        call,
        turnNumber: turnIds.indexOf(call.turnId ?? "") + 1,
        total: trace.calls.length,
        prevSeq: trace.calls[at - 1]?.seq ?? null,
        nextSeq,
        strip: trace.calls.map((c) => ({ seq: c.seq, input: c.input, window: c.window, isError: c.status !== "ok" })),
        tools,
        connection,
        headroom,
      };
    },
    { ensureSignedIn: true },
  );

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: `Call #${data?.call.index ?? ""} · Usage · harnesst` }, ...noindexMeta];
}

function Group({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
        {aside && <div className="text-xs text-muted-foreground">{aside}</div>}
      </div>
      <dl className="divide-y text-sm">{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function Plan({ label, before, after, resetsAt }: { label: string; before: number | null | undefined; after: number | null | undefined; resetsAt: string | null | undefined }) {
  if (before == null && after == null) return <Row label={label}><NotAvailable /></Row>;
  return (
    <Row label={label}>
      {before == null ? "?" : `${Math.round(before)}%`} → <strong>{after == null ? "?" : `${Math.round(after)}%`}</strong>
      {resetsAt && (
        <span className="text-xs text-muted-foreground">
          {" "}· resets <LocalizedDateTime value={resetsAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "numeric" }} />
        </span>
      )}
    </Row>
  );
}

export default function CallPage({ loaderData }: Route.ComponentProps) {
  const { days, project, agentName, run, call: c, turnNumber, total, prevSeq, nextSeq, strip, tools, connection, headroom } = loaderData;
  const base = `/usage/repos/${project.id}`;
  const runHref = usageHref(`${base}/runs/${run.id}`, days);
  const callHref = (seq: number) => usageHref(`${base}/runs/${run.id}/calls/${seq}`, days);
  const frac = ratio(c.input, c.window);
  const compTotal = c.composition?.reduce((a, p) => a + p.tokens, 0) ?? 0;
  const crumbs = [
    { label: "Usage", to: "/usage" },
    ...(project.isTeam ? [{ label: project.name, to: base }] : []),
    ...(agentName ? [{ label: agentName, to: `${base}/agents/${encodeURIComponent(agentName)}` }] : []),
    { label: <span className="font-mono">{runLabel(run)}</span>, to: `${base}/runs/${run.id}` },
    { label: `Turn ${turnNumber} · call #${c.index}` },
  ];

  return (
    <AppShell>
      <UsageCrumbs items={crumbs} days={days} />
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Model call{agentName ? ` · ${agentName}` : ""}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Call #{c.index} <span className="text-base font-normal text-muted-foreground">of {total} · turn {turnNumber}, step {c.stepIndex ?? "?"}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            In run <Link to={runHref} className="font-mono text-primary hover:underline">{runLabel(run)}</Link>
            {c.startedAt && <> · <LocalizedDateTime value={c.startedAt} /></>}
          </p>
        </div>
        <div className="flex gap-2">
          {prevSeq == null ? (
            <Button variant="outline" size="sm" disabled><ArrowLeft className="size-3.5" /> Prev</Button>
          ) : (
            <Button variant="outline" size="sm" asChild><Link to={callHref(prevSeq)}><ArrowLeft className="size-3.5" /> Prev</Link></Button>
          )}
          {nextSeq == null ? (
            <Button variant="outline" size="sm" disabled>Next <ArrowRight className="size-3.5" /></Button>
          ) : (
            <Button variant="outline" size="sm" asChild><Link to={callHref(nextSeq)}>Next <ArrowRight className="size-3.5" /></Link></Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to={runHref}>Back to run</Link>
          </Button>
        </div>
      </div>

      <section className="mb-4 rounded-xl border p-4">
        <div className="mb-1 flex flex-wrap justify-between gap-2 text-xs">
          <span className="font-medium uppercase tracking-wide text-muted-foreground">Position in run</span>
          <span className="text-muted-foreground">context per call, in call order · red = failed · click to jump</span>
        </div>
        <PositionStrip calls={strip} current={c.seq} callHref={callHref} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Group title="Tokens">
            <Row label="Input (context size)">
              {c.input == null ? <NotAvailable /> : <><strong>{c.input.toLocaleString()}</strong>{frac != null && <span className="text-xs text-muted-foreground"> {formatPercent(frac)} of {c.window!.toLocaleString()} window</span>}</>}
            </Row>
            <Row label="Context bar"><CtxBar value={c.input} window={c.window} className="justify-end" /></Row>
            <Row label="Cached input">{c.cached == null ? <NotAvailable /> : c.cached.toLocaleString()}</Row>
            <Row label="Cache writes">{c.cacheWrite == null ? <NotAvailable short /> : c.cacheWrite.toLocaleString()}</Row>
            <Row label="Output">{c.output == null ? <NotAvailable /> : c.output.toLocaleString()}</Row>
            <Row label="Reasoning">{c.reasoning == null ? <NotAvailable /> : c.reasoning.toLocaleString()}</Row>
          </Group>
          <Group title="Subscription & cost">
            <Row label="Connection">{connection ? <>{connection.label} <Badge variant="outline">{connection.provider}</Badge></> : <NotAvailable />}</Row>
            <Row label="Plan type">{c.planType ? <Badge variant="secondary">{c.planType}</Badge> : <NotAvailable />}</Row>
            <Row label="Account">{connection?.accountEmail ?? <NotAvailable />}</Row>
            {connection?.provider === "codex" && (
              <>
                <Plan label="5h window" before={headroom?.before?.primary} after={headroom?.after?.primary} resetsAt={headroom?.after?.primaryResetsAt ?? headroom?.before?.primaryResetsAt} />
                <Plan label="Weekly window" before={headroom?.before?.secondary} after={headroom?.after?.secondary} resetsAt={headroom?.after?.secondaryResetsAt ?? headroom?.before?.secondaryResetsAt} />
              </>
            )}
            <Row label="Cost">{c.costUsd != null ? formatUsd(c.costUsd) : c.planType ? <span className="text-xs text-muted-foreground">subscription: see plan % above</span> : <NotAvailable />}</Row>
          </Group>
          <Group title="Timing & status">
            <Row label="Latency">{formatMs(c.durationMs)}</Row>
            <Row label="Time to first token">{c.ttftMs == null ? <NotAvailable /> : formatMs(c.ttftMs)}</Row>
            <Row label="Status">
              {c.status === "ok" ? <span className="text-emerald-600">ok</span> : <Badge variant="destructive">{c.status === "rate_limited" ? "429" : "error"}</Badge>}
              {c.httpStatus != null && <span className="ml-1 text-xs text-muted-foreground">HTTP {c.httpStatus}</span>}
            </Row>
            {c.errorCode && <Row label="Error code"><span className="font-mono text-xs">{c.errorCode}</span></Row>}
            {(c.retries > 0 || c.hit429) && <Row label="Attempts">{c.retries + 1}{c.hit429 && " (one or more 429)"}</Row>}
          </Group>
        </div>
        <div className="space-y-4">
          <Group title="Identity">
            <Row label="Agent">{agentName ?? <NotAvailable />}</Row>
            <Row label="Repository">{project.name}{project.isTeam ? " (team)" : " (single agent)"}</Row>
            <Row label="Subagent">{c.subagentName ?? "main agent"}</Row>
            <Row label="Session"><span className="font-mono text-xs">{c.sessionId ?? "—"}</span></Row>
            <Row label="Turn · step index"><span className="font-mono text-xs">{c.turnId ?? "—"} · {c.stepIndex ?? "—"}</span></Row>
            <Row label="Model"><span className="font-mono text-xs">{c.model ?? "—"}</span></Row>
            <Row label="Reasoning effort">{c.reasoningEffort ?? <NotAvailable />}</Row>
          </Group>
          {c.composition ? (
            <section className="rounded-xl border p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Context composition <Badge variant="outline">estimated</Badge>
                </h2>
                <span className="text-xs text-muted-foreground">
                  {formatTokens(compTotal)}{c.window ? ` of ${formatTokens(c.window)}` : ""}
                </span>
              </div>
              <CompositionBar parts={c.composition} window={c.window} />
              <ul className="mt-3 space-y-1.5 text-sm">
                {c.composition.map((p) => (
                  <li key={p.key} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="size-2.5 rounded-full" style={{ background: PART_COLORS[p.key] }} />
                      {p.label}
                    </span>
                    <span className="tabular-nums">
                      {p.tokens.toLocaleString()}
                      <span className="ml-2 inline-block w-12 text-right text-xs text-muted-foreground">{formatPercent(ratio(p.tokens, compTotal))}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                Estimated from the request at 4 bytes per token, scaled to the reported input. The red tick marks where eve compacts (90% of the window).
              </p>
            </section>
          ) : (
            <section className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              <h2 className="mb-1 text-xs font-medium uppercase tracking-wide">Context composition</h2>
              <NotAvailable />: only calls through the harnesst gateway with a recorded call-log row carry an estimate.
            </section>
          )}
        </div>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">Tool results fed back ({tools.length})</h2>
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">This call made no tool calls.</p>
        ) : (
          <div className="space-y-3">
            {tools.map((t) => (
              <details key={t.seq} className="rounded-xl border" open={tools.length <= 3}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-2 text-sm">
                  <span className="font-mono">{t.toolName ?? "tool"}</span>
                  {t.resultTokens != null && <span className="text-xs text-muted-foreground">+{formatTokens(t.resultTokens)} tokens</span>}
                  {t.durationMs != null && <span className="text-xs text-muted-foreground">{formatMs(t.durationMs)}</span>}
                  {t.withheld ? <Badge variant="destructive">withheld</Badge> : t.isError ? <Badge variant="destructive">error</Badge> : null}
                  {t.capped && <Badge variant="outline">capped</Badge>}
                </summary>
                <div className="space-y-2 border-t px-4 py-3">
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Input</div>
                    <pre className="max-h-60 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{asText(t.input) || "—"}</pre>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Output</div>
                    {t.withheld ? (
                      <p className="rounded-md bg-red-500/5 p-2 text-xs text-red-700 dark:text-red-400">
                        The gateway withheld this result: about {formatTokens(t.withheld.tokens)} tokens against a {formatTokens(t.withheld.limitTokens)} limit. The model saw an error in its place.
                      </p>
                    ) : (
                      <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{asText(t.output) || "—"}</pre>
                    )}
                    {(t.capped || t.truncated) && !t.withheld && (
                      <p className="mt-1 text-xs text-muted-foreground">Stored output was capped; the model saw the full {t.resultTokens != null ? `${formatTokens(t.resultTokens)}-token ` : ""}result.</p>
                    )}
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
