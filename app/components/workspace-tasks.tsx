/**
 * Persistent workspace task-progress indicator (issue #142).
 *
 * A discreet, project-scoped strip in the app header that survives navigation within a workspace.
 * It self-fetches this project's running + recent terminal tasks from the
 * `/repos/:projectId/tasks` resource route (keyed fetcher, so it reuses its data across page
 * navigations) and polls: 3s while any task is running, 10s otherwise, paused while the tab is
 * hidden. A running task's one-liner is DERIVED from its pipeline `steps` via the same
 * `runningStepSummary` the publish panel's full stepper state uses — one source of truth, two
 * densities (issue #225 §4.3). Terminal tasks linger with a back-link and a dismiss (×) until
 * the user clears them; dismissal is optimistic, so the row goes on click rather than on the
 * next poll. Renders nothing off a workspace page or with no tasks — the queue is the ops
 * primitive; this is only its small user-facing projection.
 */
import { Loader2, CheckCircle2, XCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useFetcher, useLocation } from "react-router";

import type { PipelineStep } from "~/data/ports";
import { cn } from "~/lib/utils";
import { runningStepSummary } from "~/publish/publish-panel";

export interface WorkspaceTask {
  id: string;
  kind: string;
  subjectKey: string;
  label: string;
  steps: PipelineStep[] | null;
  status: string;
  originUrl: string;
  resultUrl: string | null;
  error: string | null;
  createdAt: string;
}

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 10000;

/** Extract the current workspace's projectId from the path, or null off a workspace page. */
function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/repos\/([^/]+)/);
  return match ? match[1] : null;
}

export function WorkspaceTasksIndicator() {
  const location = useLocation();
  const projectId = projectIdFromPath(location.pathname);
  // Keyed so the fetcher's data + state persist across in-workspace navigations (the strip doesn't
  // flash empty when the page changes).
  const fetcher = useFetcher<{ tasks: WorkspaceTask[] }>({ key: "workspace-tasks" });
  const { load } = fetcher;

  const tasks = fetcher.data?.tasks ?? [];
  const anyRunning = tasks.some((t) => t.status === "running");

  // Poll while mounted on a workspace page. The cadence follows whether anything is running, and
  // pauses while the tab is hidden (a background tab can't show the update anyway).
  const anyRunningRef = useRef(anyRunning);
  anyRunningRef.current = anyRunning;
  useEffect(() => {
    if (!projectId) return;
    const url = `/repos/${projectId}/tasks`;
    load(url);
    let timer: ReturnType<typeof setInterval>;
    const schedule = () => {
      const ms = anyRunningRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        load(url);
      }, ms);
    };
    schedule();
    return () => clearInterval(timer);
    // Re-run when the running state flips so the cadence switches between 3s and 10s.
  }, [projectId, load, anyRunning]);

  // Optimistic dismissal. The × POSTs and then waits on the next poll for the row to actually
  // go — up to a full IDLE_POLL_MS of a row sitting there refusing to leave. The server call
  // still happens (dismissedAt is what makes it stick across reloads); this just stops the UI
  // waiting for it. Held HERE rather than in TaskRow because dismissing the last row has to
  // collapse the whole strip: a row that hides itself would leave an empty bordered band.
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(new Set());
  const dismissLocally = useCallback((id: string) => {
    setDismissedIds((prev) => new Set(prev).add(id));
  }, []);
  const visible = tasks.filter((t) => !dismissedIds.has(t.id));

  if (!projectId || visible.length === 0) return null;

  return (
    <div
      className="border-t bg-muted/30"
      role="status"
      aria-live="polite"
      aria-label="Background task progress"
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <ul className="divide-y divide-border/60">
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              projectId={projectId}
              onDismissed={dismissLocally}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** One slim row per task. Exported for unit testing without the polling fetcher. */
export function TaskRow({
  task,
  projectId,
  onDismissed,
}: {
  task: WorkspaceTask;
  projectId: string;
  /** Called the moment × is hit, so the list can drop the row without awaiting the server. */
  onDismissed?: (taskId: string) => void;
}) {
  const dismisser = useFetcher();
  const dismiss = () => {
    onDismissed?.(task.id);
    dismisser.submit(
      { intent: "dismiss", taskId: task.id },
      { method: "post", action: `/repos/${projectId}/tasks` },
    );
  };

  return (
    <li className="flex items-center gap-2 py-1.5 text-xs sm:text-sm">
      {task.status === "running" && (
        <>
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 truncate">
            <span className="font-medium">{task.label}</span>
            {runningStepSummary(task.steps) && (
              <span className="text-muted-foreground">
                {" "}
                — {runningStepSummary(task.steps)}
              </span>
            )}
          </span>
        </>
      )}

      {task.status === "succeeded" && (
        <>
          <CheckCircle2
            className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
          <span className="min-w-0 truncate font-medium">{task.label}</span>
          <Link
            to={task.resultUrl ?? task.originUrl}
            className="shrink-0 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            View result →
          </Link>
          <DismissButton onDismiss={dismiss} />
        </>
      )}

      {task.status === "failed" && (
        <>
          <XCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 truncate">
            <span className="font-medium">{task.label}</span>{" "}
            <span className="text-destructive">failed</span>
            {task.error && (
              <span
                className="text-muted-foreground"
                title={task.error}
              >
                {" "}
                — {firstLine(task.error)}
              </span>
            )}
          </span>
          <Link
            to={task.originUrl}
            className="shrink-0 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            View →
          </Link>
          <DismissButton onDismiss={dismiss} />
        </>
      )}
    </li>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss"
      className={cn(
        "ml-auto flex size-5 shrink-0 items-center justify-center rounded",
        "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
      )}
    >
      <X className="size-3.5" aria-hidden />
    </button>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0];
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
