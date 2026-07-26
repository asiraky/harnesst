/**
 * Structured editor: markdown-form schedules (`agent/schedules/<name>.md`) — Author pillar.
 *
 * A schedule is two decisions: WHEN (cron, edited through the human-readable CronField) and
 * WHAT (the message the agent receives when it fires). This form owns exactly those; other
 * frontmatter keys are preserved verbatim. Advanced modes stay available: "edit raw markdown"
 * opens the code editor on the same file (?raw=1 skips the redirect back here), and
 * TypeScript schedules (`<name>.ts`, defineSchedule with a run() handler) always open in the
 * code editor. Save writes a draft like every other editor; publishing is the header
 * Publish control's job.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { CalendarClock } from "lucide-react";
import { useState } from "react";
import {
  Link,
  redirect,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { CronField } from "~/components/cron-field";
import { FileStateBanner } from "~/components/file-state-banner";
import {
  AgentNav,
  AppShell,
  PageHeader,
  accentText,
  repoCrumbs,
} from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { resolveFileView, stageDraft } from "~/drafts/drafts.server";
import { buildScheduleFile, parseScheduleFile } from "~/eve/scheduleFile";
import { isValidCron } from "~/lib/cron";
import { contextPath } from "~/lib/paths";
import {
  agentFromParams,
  agentParamRedirect,
  memberFromPath,
  requireActiveAgent,
  resolveAgentContext,
} from "~/project/agent-context.server";
import {
  normalizeAgentPath,
  requireProject,
  requireRepo,
} from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.edit.schedule";

/** This editor only understands markdown-form schedules (root agent or a team member). */
function schedulePath(raw: string): string | null {
  const path = normalizeAgentPath(raw);
  return path &&
    /^(?:agent|agents\/[^/]+\/agent)\/schedules\/[^/]+\.md$/.test(path)
    ? path
    : null;
}

const DEFAULT_CRON = "0 9 * * 1-5";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      // The member is the path segment when present (member-level route); otherwise the
      // schedule file's path implies it. Legacy ?agent= links 301 into the member path.
      const paramAgent = agentFromParams(args.params);
      if (!paramAgent) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const path = schedulePath(
        new URL(args.request.url).searchParams.get("path") ?? "",
      );
      if (!path) throw redirect(contextPath(project.id, paramAgent));

      const [view, { roster, active, isTeam }] = await Promise.all([
        resolveFileView(project, path),
        resolveAgentContext(project.id, paramAgent ?? memberFromPath(path)),
      ]);
      requireActiveAgent(active, project.id);
      const parsed = view.content ? parseScheduleFile(view.content) : null;
      return {
        project,
        path,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        cron: parsed?.cron || DEFAULT_CRON,
        message: parsed?.message ?? "",
        extraFrontmatter: parsed?.extraFrontmatter ?? [],
        exists: view.existsInRepo,
        isNew: view.content === null,
        source: view.source,
        stagedDeletion: view.stagedDeletion,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );

  const form = await args.request.formData();
  const path = schedulePath(String(form.get("path") ?? ""));
  if (!path) return { error: "Invalid schedule path." };
  const cron = String(form.get("cron") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();
  if (!isValidCron(cron)) return { error: "That cron expression isn't valid." };
  if (!message)
    return { error: "Say what the agent should do when this fires." };

  // Re-read the current file so frontmatter keys this form doesn't own survive the save.
  const view = await resolveFileView(project, path);
  const extraFrontmatter = view.content
    ? parseScheduleFile(view.content).extraFrontmatter
    : [];

  try {
    await stageDraft({
      projectId: project.id,
      path,
      content: buildScheduleFile({ cron, message, extraFrontmatter }),
      createdBy: auth.user.id,
    });
    return { ok: true as const };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Edit schedule · harnesst" }];
}

export default function EditSchedule({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  // Keyed by path so switching schedules remounts with fresh state.
  return (
    <ScheduleForm
      key={loaderData.path}
      loaderData={loaderData}
      actionData={actionData}
    />
  );
}

function ScheduleForm({
  loaderData,
  actionData,
}: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const { project, path, roster, activeAgent, isTeam, exists, isNew } =
    loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const saving = navigation.state !== "idle";

  const [cron, setCron] = useState(loaderData.cron);
  const [message, setMessage] = useState(loaderData.message);
  // Same route, different ?path (or a fresh save) — re-seed the form from the loader
  // inline instead of holding the previous file's values in state.
  const [prevSeed, setPrevSeed] = useState({
    path,
    cron: loaderData.cron,
    message: loaderData.message,
  });
  if (
    prevSeed.path !== path ||
    prevSeed.cron !== loaderData.cron ||
    prevSeed.message !== loaderData.message
  ) {
    setPrevSeed({ path, cron: loaderData.cron, message: loaderData.message });
    setCron(loaderData.cron);
    setMessage(loaderData.message);
  }

  const ctx = contextPath(project.id, isTeam ? activeAgent : null);
  const name = path.split("/").pop()!.replace(/\.md$/, "");

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: path.split("/").pop() }],
      })}
    >
      <AgentNav
        base={ctx}
        level={isTeam ? "member" : "single"}
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />
      <PageHeader
        icon={CalendarClock}
        accent="amber"
        title={
          <span className="flex items-center gap-3">
            Schedule: {name}
            {!exists && <Badge variant="secondary">new</Badge>}
          </span>
        }
        description="When the schedule fires, the agent receives the message below and acts on it."
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t save the change</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      <FileStateBanner
        saved={!!actionData?.ok}
        source={loaderData.source}
        stagedDeletion={loaderData.stagedDeletion}
      />

      <div className="max-w-2xl space-y-6">
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5">
            <CalendarClock
              className={`size-3.5 ${accentText.amber}`}
              aria-hidden
            />
            Runs
          </Label>
          <CronField value={cron} onChange={setCron} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="schedule-message">Message to the agent</Label>
          <Textarea
            id="schedule-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. Summarize yesterday's runs and flag anything unusual."
            className="min-h-32"
          />
          <p className="text-xs text-muted-foreground">
            Sent to the agent as a prompt each time the schedule fires
            (fire-and-forget).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => submit({ path, cron, message }, { method: "post" })}
            disabled={saving || !isValidCron(cron) || !message.trim()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" asChild>
            <Link to={ctx}>Cancel</Link>
          </Button>
          {!isNew && (
            <Link
              to={`${ctx}/edit?path=${encodeURIComponent(path)}&raw=1`}
              className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Advanced: edit raw markdown
            </Link>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Need logic instead of a message? Author the schedule as TypeScript
          (`agent/schedules/{name}.ts`) with a{" "}
          <span className="font-mono">run()</span> handler — code-file schedules
          open in the code editor.
        </p>
      </div>
    </AppShell>
  );
}
