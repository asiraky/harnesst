/**
 * Run transcript (Observe pillar, M3 — PRD §7.6). A narrative, chat-shaped view of one run:
 * a header band of run health, then the ordered steps rendered as a conversation (user +
 * assistant bubbles, quiet model beats, foldable reasoning, expandable tool calls with
 * semantic rendering) instead of a JSON dump. Errors are first-class — a failed run surfaces
 * the real error with a jump-to-failing-step link. In-flight runs revalidate on an interval
 * so a live playground turn fills in as it goes. The exact system prompt stays reconstructable
 * from the Release commit linked here (link, not snapshot).
 */
import { sessionLoader } from "~/auth/session.server";
import { Activity, Users } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import {
  Link,
  data,
  redirect,
  useRevalidator,
  type LoaderFunctionArgs,
} from "react-router";

import { RunTranscript, type StepView } from "~/components/run-steps";
import { LocalizedDateTime } from "~/components/localized-values";
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { stripChannelContext } from "~/chat/channel-context";
import { contextPath } from "~/lib/paths";
import { formatMs } from "~/lib/time";
import { getRunWithSteps } from "~/observability/store.server";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
  requireActiveAgent,
} from "~/project/agent-context.server";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.runs.$runId";

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
      const [result, { roster, active, isTeam }] = await Promise.all([
        getRunWithSteps(project.id, args.params.runId!),
        resolveAgentContext(project.id, agentName),
      ]);
      requireActiveAgent(active, project.id);
      // Teams have no repo-level run pages — the transcript lives at the member level.
      if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);
      if (!result) throw data("Run not found", { status: 404 });
      return {
        project: {
          id: project.id,
          name: project.name,
          repoOwner: project.repoOwner,
          repoName: project.repoName,
        },
        ...result,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
      };
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Run · harnesst" }];
}

/** failed→destructive, completed→success (emerald), running→default (violet), else outline. */
function statusVariant(
  status: string,
): "default" | "outline" | "destructive" | "success" | "warning" {
  if (status === "failed") return "destructive";
  if (status === "completed" || status === "success") return "success";
  if (status === "running") return "default";
  if (status === "queued" || status === "pending") return "warning";
  return "outline";
}

/** GitHub commit URL when the repo coordinates are known, else null (link, not snapshot). */
function commitUrl(
  project: { repoOwner: string | null; repoName: string | null },
  gitSha: string,
): string | null {
  if (!project.repoOwner || !project.repoName) return null;
  return `https://github.com/${project.repoOwner}/${project.repoName}/commit/${gitSha}`;
}

export default function RunTranscriptRoute({
  loaderData,
}: Route.ComponentProps) {
  const { project, run, steps, release, roster, activeAgent, isTeam } =
    loaderData;
  const ctx = contextPath(project.id, isTeam ? activeAgent : null);
  const stepViews = steps as unknown as StepView[];

  // Live runs: revalidate every ~3s until the run settles, so a running turn fills in.
  const revalidator = useRevalidator();
  const live = run.status === "running";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [live, revalidator]);

  // The triggering input: prefer a captured user-message step; fall back to run metadata (a
  // running turn has metadata before any steps land).
  const hasUserStep = stepViews.some(
    (s) =>
      s.type === "message" && (s.data as { role?: string })?.role === "user",
  );
  const metaInput =
    typeof run.metadata?.input === "string"
      ? stripChannelContext(run.metadata.input) || null
      : null;

  // Linked traces (D6): a delegated run carries its caller on run metadata.
  const triggeredBy =
    run.metadata &&
    typeof run.metadata.delegationId === "string" &&
    typeof run.metadata.fromAgentName === "string"
      ? (run.metadata.fromAgentName as string)
      : null;

  const firstErrorSeq = stepViews.find((s) => s.isError)?.seq ?? null;

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: "Run" }],
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
        title={run.externalRunId ?? run.id}
        description="A readable, chat-shaped transcript of the run."
        actions={
          <Button variant="outline" asChild>
            <Link to={`${ctx}/runs`}>← Runs</Link>
          </Button>
        }
      />

      {/* Header band */}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric label="Status">
          <span className="flex items-center gap-2">
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
            {live && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                live
              </span>
            )}
          </span>
        </Metric>
        <Metric label="Tokens">
          {(run.tokensInput ?? 0) + (run.tokensOutput ?? 0) === 0 ? (
            "—"
          ) : (
            <span title="input / output">
              {run.tokensInput ?? 0}
              <span className="text-muted-foreground"> in</span> /{" "}
              {run.tokensOutput ?? 0}
              <span className="text-muted-foreground"> out</span>
            </span>
          )}
        </Metric>
        <Metric label="Wall clock">{formatMs(run.wallClockMs)}</Metric>
        <Metric label="Version">
          {release ? (
            <span className="flex items-center gap-2">
              {release.version}
              {commitUrl(project, release.gitSha) ? (
                <a
                  href={commitUrl(project, release.gitSha)!}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline"
                >
                  {release.gitSha.slice(0, 7)}
                </a>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">
                  {release.gitSha.slice(0, 7)}
                </span>
              )}
            </span>
          ) : (
            "—"
          )}
        </Metric>
      </dl>
      {triggeredBy && (
        <div className="mt-3">
          <Link
            to={`/repos/${project.id}/agents/${encodeURIComponent(triggeredBy)}/runs`}
            className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium underline-offset-4 hover:underline"
          >
            <Users className="size-3.5" aria-hidden />
            Triggered by {triggeredBy}
          </Link>
        </div>
      )}
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {run.channel && <span>Channel: {run.channel}</span>}
        <span>
          Started: <LocalizedDateTime value={run.startedAt} />
        </span>
        {release && (
          <span>
            The exact system prompt is reconstructable from the repo at this
            commit.
          </span>
        )}
      </p>

      {run.error && (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription className="space-y-2">
            <span className="block whitespace-pre-wrap">{run.error}</span>
            {firstErrorSeq != null && (
              <a
                href={`#step-${firstErrorSeq}`}
                className="inline-block text-sm font-medium underline underline-offset-4"
              >
                Jump to the failing step ↓
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Narrative transcript */}
      <div className="mt-6">
        {!hasUserStep && metaInput && (
          <div className="mb-3 ml-auto w-fit max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
            <p className="whitespace-pre-wrap">{metaInput}</p>
          </div>
        )}
        <RunTranscript steps={stepViews} />
      </div>
    </AppShell>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}
