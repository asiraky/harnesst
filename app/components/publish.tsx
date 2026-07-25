/**
 * The Publish control + panel (issue #225 §4.1/§4.2) — the ONE way changes go live.
 *
 * PublishControl sits in AppShell's header on every back-of-house page. It is project-scoped
 * (derives the projectId from the URL, like WorkspaceTasksIndicator), self-fetches the
 * `repos/:projectId/publish` resource route with a keyed fetcher (data survives in-workspace
 * navigation), and polls — 3s while a publish runs, 10s otherwise, paused while the tab is
 * hidden. It renders one of five states: quiet "Live · v12", "Not deployed yet" + a Publish
 * button (deploys HEAD), "Publish N changes", a live running status, or "Publish failed".
 *
 * PublishPanel is the control's dialog, in two modes. Review mode shows every saved change
 * before anything goes live: grouped by owning member (+ shared), per-file action badge
 * (Edited/New/Deleted), who saved it and when (the assistant is visually distinct from
 * teammates), an expandable diff per file, discard per file / discard all, and the environment
 * question ONLY when §2.8 resolution has to ask (answered once, then persisted). Pipeline mode
 * renders the task's `steps` as a vertical list — the full §4.3 stepper treatment (auto-expand
 * animation, assistant handoff, success auto-dismiss) lands with the pipeline-UI stage; this
 * renders every step, substep, skip reason, and failure output so nothing is ever invisible.
 *
 * The assistant page links here with `?publish=1` — the control opens its panel when that param
 * is present and clears it on close.
 */
import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  CircleSlash,
  Loader2,
  Rocket,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLocation, useSearchParams } from "react-router";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { DiffView } from "~/components/diff-view";
import { RelativeTime } from "~/components/localized-values";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { PipelineStep, PipelineStepStatus } from "~/data/ports";
import { cn } from "~/lib/utils";
import {
  initialPublishSteps,
  publishControlState,
  publishDisabledReason,
  type ChangeAction,
  type PublishChangeRow,
  type PublishControlState,
  type PublishDiffPayload,
  type PublishGroup,
  type PublishStatePayload,
} from "~/publish/publish-panel";

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 10000;

/** Extract the current workspace's projectId from the path, or null off a workspace page. */
function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/repos\/([^/]+)/);
  return match ? match[1] : null;
}

export function PublishControl() {
  const location = useLocation();
  const projectId = projectIdFromPath(location.pathname);
  // Keyed so data + state survive in-workspace navigation (no flash back to nothing).
  const fetcher = useFetcher<PublishStatePayload>({ key: "publish-state" });
  const { load } = fetcher;
  const data = fetcher.data;

  const running = !!data?.running;
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    if (!projectId) return;
    const url = `/repos/${projectId}/publish`;
    load(url);
    let timer: ReturnType<typeof setInterval>;
    const schedule = () => {
      const ms = runningRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        load(url);
      }, ms);
    };
    schedule();
    return () => clearInterval(timer);
    // Re-run when the running state flips so the cadence switches between 3s and 10s.
  }, [projectId, load, running]);

  const [open, setOpen] = useState(false);
  // The assistant page's "review and publish" link opens the panel via ?publish=1 (§4.6).
  const [searchParams, setSearchParams] = useSearchParams();
  const wantsOpen = searchParams.get("publish") === "1";
  useEffect(() => {
    if (wantsOpen) setOpen(true);
  }, [wantsOpen]);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && wantsOpen) {
      const params = new URLSearchParams(searchParams);
      params.delete("publish");
      setSearchParams(params, { replace: true, preventScrollReset: true });
    }
  };

  if (!projectId || !data || !data.connected) return null;
  const state = publishControlState(data);
  return (
    <>
      <PublishControlButton state={state} onOpen={() => handleOpenChange(true)} />
      <PublishPanel
        projectId={projectId}
        data={data}
        open={open}
        onOpenChange={handleOpenChange}
      />
    </>
  );
}

/** The header rendering of one §4.1 state. Presentational; exported for unit tests. */
export function PublishControlButton({
  state,
  onOpen,
}: {
  state: PublishControlState;
  onOpen: () => void;
}) {
  if (state.kind === "live") {
    return (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        Live{state.version ? ` · ${state.version}` : ""}
      </span>
    );
  }
  if (state.kind === "never-deployed") {
    return (
      <span className="flex items-center gap-2">
        <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
          Not deployed yet
        </span>
        <Button size="sm" onClick={onOpen}>
          <Rocket className="h-4 w-4" aria-hidden />
          Publish
        </Button>
      </span>
    );
  }
  if (state.kind === "ready") {
    return (
      <Button size="sm" onClick={onOpen}>
        <Rocket className="h-4 w-4" aria-hidden />
        Publish {state.count} change{state.count === 1 ? "" : "s"}
      </Button>
    );
  }
  if (state.kind === "running") {
    return (
      <Button variant="outline" size="sm" onClick={onOpen}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span className="max-w-48 truncate">{state.summary ?? "Publishing…"}</span>
      </Button>
    );
  }
  return (
    <Button variant="destructive" size="sm" onClick={onOpen}>
      <XCircle className="h-4 w-4" aria-hidden />
      Publish failed
    </Button>
  );
}

export function PublishPanel({
  projectId,
  data,
  open,
  onOpenChange,
}: {
  projectId: string;
  data: PublishStatePayload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const action = `/repos/${projectId}/publish`;
  const publish = useFetcher<{ ok?: boolean; taskId?: string; error?: string }>();
  const publishing = publish.state !== "idle";
  // Stale-error gate: fetcher data survives close/reopen — a reopened panel must not
  // resurrect the previous attempt's error. Set on reopen, cleared on the next submit.
  const [errorStale, setErrorStale] = useState(false);
  const error = publishing || errorStale ? undefined : publish.data?.error;

  // §2.8: the one-time environment answer, kept only until the server persists it.
  const [env, setEnv] = useState("");

  // Bridge the gap between POSTing a publish and the next poll returning the running task —
  // the panel flips to pipeline mode immediately (pending steps) instead of flashing review.
  const [awaitingStart, setAwaitingStart] = useState(false);
  useEffect(() => {
    if (data.running || data.failed || publish.data?.error) setAwaitingStart(false);
  }, [data.running, data.failed, publish.data]);

  // "Back to changes" locally hides the failed task while its dismissal round-trips.
  const [dismissedFailedId, setDismissedFailedId] = useState<string | null>(null);
  const failed = data.failed && data.failed.taskId !== dismissedFailedId ? data.failed : null;
  const dismisser = useFetcher();
  const backToChanges = () => {
    if (failed) {
      dismisser.submit(
        { intent: "dismiss", taskId: failed.taskId },
        { method: "post", action: `/repos/${projectId}/tasks` },
      );
      setDismissedFailedId(failed.taskId);
    }
  };

  // Never-deployed repos with nothing saved publish the branch HEAD instead (§4.1). A HEAD
  // publish has no pipeline task — close the panel when the POST redirects home clean.
  const headMode = data.changeCount === 0 && !data.deployed;
  const wasPublishing = useRef(false);
  useEffect(() => {
    const finished = wasPublishing.current && !publishing && !publish.data?.error;
    wasPublishing.current = publishing;
    if (finished && headMode) onOpenChange(false);
  }, [publishing, publish.data, headMode, onOpenChange]);

  const handleOpenChange = (next: boolean) => {
    if (next) setErrorStale(true);
    onOpenChange(next);
  };

  const submit = () => {
    setErrorStale(false);
    setAwaitingStart(true);
    publish.submit(
      {
        intent: headMode ? "publish-head" : "publish",
        ...(env ? { env } : {}),
      },
      { method: "post", action },
    );
  };

  const mode: "pipeline" | "review" =
    data.running || failed || (awaitingStart && !headMode) ? "pipeline" : "review";
  const steps = data.running?.steps ?? failed?.steps ?? initialPublishSteps();
  const disabledReason = headMode
    ? data.needsEnvironmentChoice && !env
      ? "Choose which environment your agents run in."
      : null
    : publishDisabledReason({
        running: data.running,
        changeCount: data.changeCount,
        needsEnvironmentChoice: data.needsEnvironmentChoice,
        envAnswer: env,
      });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {mode === "pipeline" ? (
          <>
            <DialogHeader>
              <DialogTitle>{failed ? "Publish failed" : "Publishing"}</DialogTitle>
              <DialogDescription>
                {failed
                  ? "One step failed — nothing you saved was lost."
                  : "Your changes are going live. You can close this — progress stays in the header."}
              </DialogDescription>
            </DialogHeader>
            <PipelineStepList steps={steps} />
            <DialogFooter>
              {failed && (
                <Button variant="ghost" onClick={backToChanges}>
                  Back to changes
                </Button>
              )}
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {headMode
                  ? "Publish your repository"
                  : data.changeCount > 0
                    ? `Publish ${data.changeCount} change${data.changeCount === 1 ? "" : "s"}`
                    : "Publish"}
              </DialogTitle>
              <DialogDescription>
                {headMode
                  ? "Your repository hasn't been deployed yet. Publish creates a version from it as it is and starts your agents."
                  : data.changeCount > 0
                    ? "Everything below goes live together: Publish checks it, builds it, saves it to your repository, creates a version, and starts your agents."
                    : `Nothing to publish — everything you've saved is live${
                        data.liveVersion ? ` (${data.liveVersion})` : ""
                      }.`}
              </DialogDescription>
            </DialogHeader>

            {data.changeCount > 0 && (
              <PublishReviewChanges
                projectId={projectId}
                groups={data.groups}
                disabled={publishing}
              />
            )}

            {/* The environment question appears ONLY when §2.8 resolution must ask; the answer
                is persisted with the publish and never asked again. */}
            {data.needsEnvironmentChoice && (data.changeCount > 0 || headMode) && (
              <div className="space-y-1.5">
                <span className="text-xs font-medium">
                  Which environment do your agents run in?
                </span>
                <Select value={env} onValueChange={setEnv}>
                  <SelectTrigger className="h-8 font-mono text-xs" aria-label="Environment">
                    <SelectValue placeholder="Choose an environment" />
                  </SelectTrigger>
                  <SelectContent>
                    {data.envNames.map((name) => (
                      <SelectItem key={name} value={name} className="font-mono text-xs">
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  You'll only be asked once — Publish remembers your answer.
                </p>
              </div>
            )}

            {error && (
              <p className="min-w-0 break-words text-xs text-destructive">{error}</p>
            )}
            {disabledReason && (data.changeCount > 0 || headMode) && (
              <p className="text-xs text-muted-foreground">{disabledReason}</p>
            )}

            <DialogFooter>
              {data.changeCount > 0 && (
                <ConfirmDialog
                  trigger={
                    <Button variant="ghost" disabled={publishing}>
                      Discard all
                    </Button>
                  }
                  title="Discard all changes?"
                  description="Removes everything you've saved without publishing it. This can't be undone."
                  confirmLabel="Discard all"
                  onConfirm={() => {
                    dismisser.submit(
                      { intent: "discard-all" },
                      { method: "post", action },
                    );
                  }}
                />
              )}
              {(data.changeCount > 0 || headMode) && (
                <Button onClick={submit} disabled={publishing || disabledReason !== null}>
                  <Rocket className="h-4 w-4" aria-hidden />
                  {publishing ? "Publishing…" : "Publish"}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const ACTION_BADGE: Record<ChangeAction, { label: string; className: string }> = {
  edited: {
    label: "Edited",
    className: "bg-blue-500/10 text-blue-600 ring-1 ring-blue-500/20 dark:text-blue-400",
  },
  new: {
    label: "New",
    className:
      "bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-400",
  },
  deleted: {
    label: "Deleted",
    className: "bg-rose-500/10 text-rose-600 ring-1 ring-rose-500/20 dark:text-rose-400",
  },
};

/**
 * Review mode's change list: one block per owning member (+ shared last), one expandable row
 * per file with its action badge, who saved it (assistant vs teammate, visually distinct),
 * when, and a per-file discard. Exported for unit tests.
 */
export function PublishReviewChanges({
  projectId,
  groups,
  disabled,
}: {
  projectId: string;
  groups: PublishGroup[];
  disabled?: boolean;
}) {
  return (
    // min-w-0 everywhere: DialogContent is a grid, and grid items default to min-width auto,
    // so an unbroken mono path would otherwise push the dialog wider than its max.
    <div className="min-w-0 space-y-3">
      {groups.map((group) => {
        const shared = group.member === null;
        return (
          <div key={group.member ?? "__shared__"} className="min-w-0 text-xs">
            <div className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
              {shared ? (
                <span className="font-medium">Shared — affects all agents</span>
              ) : (
                <span className="font-mono font-medium">{group.member}</span>
              )}
            </div>
            <ul className="mt-1 min-w-0 space-y-0.5">
              {group.files.map((row) => (
                <ChangeRow
                  key={row.path}
                  projectId={projectId}
                  row={row}
                  disabled={disabled}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ChangeRow({
  projectId,
  row,
  disabled,
}: {
  projectId: string;
  row: PublishChangeRow;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const discard = useFetcher();
  const badge = ACTION_BADGE[row.action];
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 py-0.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={`Show what changed in ${row.path}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          <span className="min-w-0 break-all font-mono">{row.path}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
              badge.className,
            )}
          >
            {badge.label}
          </span>
        </button>
        {/* Who saved it: the assistant is visually distinct from a teammate (§2.7). */}
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
          {row.savedBy === null ? (
            <span className="flex items-center gap-1 text-violet-600 dark:text-violet-400">
              <Bot className="size-3" aria-hidden />
              Assistant
            </span>
          ) : (
            <span className="max-w-24 truncate">{row.savedBy}</span>
          )}
          <span aria-hidden>·</span>
          <RelativeTime value={row.savedAt} />
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            discard.submit(
              { intent: "discard", path: row.path },
              { method: "post", action: `/repos/${projectId}/publish` },
            )
          }
          aria-label={`Discard ${row.path}`}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>
      {expanded && <DiffPane projectId={projectId} path={row.path} />}
    </li>
  );
}

/** Lazily fetches one file's diff when its row expands. */
function DiffPane({ projectId, path }: { projectId: string; path: string }) {
  const fetcher = useFetcher<PublishDiffPayload>();
  const { load, state, data } = fetcher;
  useEffect(() => {
    if (state === "idle" && !data) {
      load(`/repos/${projectId}/publish?diff=${encodeURIComponent(path)}`);
    }
  }, [state, data, load, projectId, path]);
  if (!data) {
    return (
      <p className="flex items-center gap-1.5 py-1 pl-5 text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Loading what changed…
      </p>
    );
  }
  return (
    <div className="min-w-0 py-1 pl-5">
      {data.patch ? (
        <DiffView patch={data.patch} />
      ) : (
        <p className="text-muted-foreground">No preview available for this file.</p>
      )}
    </div>
  );
}

const STEP_ICON: Record<PipelineStepStatus, React.ReactNode> = {
  pending: <Circle className="size-3.5 text-muted-foreground/50" aria-hidden />,
  running: <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />,
  succeeded: (
    <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
  ),
  failed: <XCircle className="size-3.5 text-destructive" aria-hidden />,
  skipped: <CircleSlash className="size-3.5 text-muted-foreground/50" aria-hidden />,
};

/**
 * Pipeline mode's vertical step list: every step visible from the start, the running step's
 * label + detail live-announced, substeps inline, skipped reasons shown, and a failure's full
 * output in a monospace block. Exported for unit tests. (The full §4.3 stepper — auto-expand
 * animation, "Ask the assistant to fix this", success auto-dismiss — lands with the
 * pipeline-UI stage; this shape is what it refines.)
 */
export function PipelineStepList({ steps }: { steps: PipelineStep[] }) {
  return (
    <ol role="list" className="min-w-0 space-y-2 text-sm">
      {steps.map((step) => (
        <li key={step.key} className="min-w-0">
          <div
            className="flex items-center gap-2"
            aria-live={step.status === "running" ? "polite" : undefined}
          >
            <span className="shrink-0">{STEP_ICON[step.status]}</span>
            <span
              className={cn(
                "min-w-0 truncate",
                step.status === "pending" || step.status === "skipped"
                  ? "text-muted-foreground"
                  : "font-medium",
                step.status === "failed" && "text-destructive",
              )}
            >
              {step.label}
            </span>
            {step.status === "running" && step.detail && (
              <span className="shrink-0 truncate text-xs text-muted-foreground">
                {step.detail}
              </span>
            )}
          </div>
          {step.status === "skipped" && step.reason && (
            <p className="pl-5.5 text-xs text-muted-foreground">
              Skipped — {step.reason.replace(/^Skipped — /, "")}
            </p>
          )}
          {step.substeps && step.substeps.length > 0 && (
            <ul className="mt-1 space-y-0.5 pl-5.5 text-xs">
              {step.substeps.map((sub) => (
                <li key={sub.label} className="flex items-center gap-1.5">
                  <span className="shrink-0 [&_svg]:size-3">
                    {STEP_ICON[sub.status]}
                  </span>
                  <span className="min-w-0 truncate font-mono">{sub.label}</span>
                </li>
              ))}
            </ul>
          )}
          {step.status === "failed" && step.error && (
            <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-xs text-destructive">
              {step.error}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
