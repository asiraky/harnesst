/**
 * The Publish control + panel (issue #225 §4.1/§4.2) — the ONE way changes go live.
 *
 * PublishControl mounts in AppShell on every back-of-house page. It is project-scoped (derives
 * the projectId from the URL, like WorkspaceTasksIndicator), self-fetches the
 * `repos/:projectId/publish` resource route with a keyed fetcher (data survives in-workspace
 * navigation), and polls — 3s while a publish runs, 10s otherwise, paused while the tab is
 * hidden.
 *
 * It renders TWO things. (1) PublishNudgeBanner: a dismissible strip below the header, the same
 * shape as the workspace task strip, and ONLY for the states that have no task backing them —
 * saved-but-unpublished changes, and a never-deployed repo. Running/failed/succeeded publishes
 * are already task rows in WorkspaceTasksIndicator, so surfacing them here too would double them
 * up. (2) PublishPanel, always mounted, so any `?publish=1` link on any page opens it. A completed
 * task's result link uses `?publish=<taskId>` so a fresh Overview load can render that exact
 * success instead of relying on in-memory knowledge of the publish it watched.
 *
 * The permanent, never-dismissible entry point is PublishDeploymentButton on the repo-level
 * Deployment tab. The header carries no Publish button at all: it was competing with the
 * wordmark, breadcrumbs, primary nav and account controls inside one max-w-5xl row, and lost.
 *
 * PublishPanel is the control's dialog. Review mode shows every saved change before anything
 * goes live: grouped by owning member (+ shared), per-file action badge (Edited/New/Deleted),
 * who saved it and when (the assistant is visually distinct from teammates), an expandable
 * diff per file, discard per file / discard all, and the environment question ONLY when §2.8
 * resolution has to ask (answered once, then persisted). Pipeline mode renders the task's
 * `steps` as the full §4.3 vertical stepper: on failure the failed step auto-expands its
 * output with the two recovery actions ("Ask the assistant to fix this" hands the error to
 * the assistant as pre-filled context; "Back to changes" returns to review mode). When the
 * watched publish completes, the panel shows "Live · vN" with a link to the running agents
 * and auto-dismisses after a short delay.
 *
 * The assistant page links here with `?publish=1` — the control opens its panel when that param
 * is present and clears it on close.
 */
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleSlash,
  Loader2,
  Rocket,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Link, useFetcher, useLocation, useSearchParams } from "react-router";

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
  publishedVersion,
  type ChangeAction,
  type PublishChangeRow,
  type PublishControlState,
  type PublishDiffPayload,
  type PublishGroup,
  type PublishStatePayload,
} from "~/publish/publish-panel";

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 10000;
/** How long the §4.3 success state lingers before the panel auto-dismisses. */
const SUCCESS_DISMISS_MS = 4000;

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
  const [searchParams, setSearchParams] = useSearchParams();
  const publishParam = searchParams.get("publish");
  const resultTaskId = publishParam && publishParam !== "1" ? publishParam : null;
  useEffect(() => {
    if (!projectId) return;
    const url = `/repos/${projectId}/publish${
      resultTaskId ? `?result=${encodeURIComponent(resultTaskId)}` : ""
    }`;
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
  }, [projectId, resultTaskId, load, running]);

  const [open, setOpen] = useState(false);
  // `1` opens review; a task id opens that publish's completed result.
  const wantsOpen = publishParam !== null;
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
      <PublishNudgeBanner
        state={state}
        projectId={projectId}
        onOpen={() => handleOpenChange(true)}
      />
      <PublishPanel
        projectId={projectId}
        data={data}
        open={open}
        onOpenChange={handleOpenChange}
        resultTaskId={resultTaskId}
      />
    </>
  );
}

/**
 * A link target that opens the publish panel: `publish=1` added ON TOP of the params already in
 * the URL. A bare `to="?publish=1"` replaces the whole query string, which drops the params the
 * page is keyed on — the `file` a code or schedule editor is showing, the conversation on the
 * assistant page — so the route bounces elsewhere and takes `publish=1` with it. Every
 * "Review & publish →" link goes through here.
 */
export function usePublishHref(): string {
  const [searchParams] = useSearchParams();
  const params = new URLSearchParams(searchParams);
  params.set("publish", "1");
  return `?${params.toString()}`;
}

/**
 * Which §4.1 states the nudge banner speaks for. Deliberately NOT all of them: running, failed
 * and just-succeeded publishes each own a workspace task, and WorkspaceTasksIndicator already
 * renders that task as a strip row directly above this one. Live and deploying are quiet status,
 * not a call to action — they belong on the Deployment tab, not in the app chrome. What is left
 * is the pair with no task and a real next step: changes saved but not live, and a repository
 * that has never been deployed.
 */
function nudgeCopy(
  state: PublishControlState,
): { headline: string; cta: string } | null {
  if (state.kind === "ready") {
    return {
      headline: `${state.count} saved change${state.count === 1 ? "" : "s"} ${
        state.count === 1 ? "isn't" : "aren't"
      } live yet`,
      cta: "Review & publish",
    };
  }
  if (state.kind === "never-deployed") {
    return {
      headline: "This repository hasn't been deployed yet",
      cta: "Publish it",
    };
  }
  return null;
}

/**
 * sessionStorage key for a dismissed nudge. Per project, and the VALUE is the change count that
 * was dismissed: saving another change moves the count, which un-dismisses the banner. Dismissing
 * is "I know, not now", not "never tell me about this repository again". sessionStorage (not
 * local) so it lasts the tab, not forever.
 */
function nudgeDismissKey(projectId: string): string {
  return `harnesst:publish-nudge:${projectId}`;
}

/** The signature a dismissal is remembered against — changes when the nudge's substance changes. */
function nudgeSignature(state: PublishControlState): string {
  return state.kind === "ready" ? `ready:${state.count}` : state.kind;
}

/**
 * The dismissible publish nudge (the strip under the header). Presentational apart from its own
 * dismissal memory; exported for unit tests.
 */
export function PublishNudgeBanner({
  state,
  projectId,
  onOpen,
}: {
  state: PublishControlState;
  projectId: string;
  onOpen: () => void;
}) {
  const signature = nudgeSignature(state);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(nudgeDismissKey(projectId));
  });
  // Re-read when the project changes — this component follows the URL, so navigating between
  // repositories must not carry the previous repository's dismissal across.
  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    setDismissed(sessionStorage.getItem(nudgeDismissKey(projectId)));
  }, [projectId]);

  const copy = nudgeCopy(state);
  if (!copy || dismissed === signature) return null;

  const dismiss = () => {
    setDismissed(signature);
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(nudgeDismissKey(projectId), signature);
    }
  };

  return (
    <div className="border-t bg-muted/30" role="status" aria-live="polite">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="flex items-center gap-2 py-1.5 text-xs sm:text-sm">
          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          <span className="min-w-0 truncate font-medium">{copy.headline}</span>
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {copy.cta} →
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The permanent Publish entry point, on the repo-level Deployment tab (§4.1). Unlike the header
 * nudge this is ALWAYS rendered — it is the answer to "where do I publish from?", so it cannot be
 * dismissed, and it cannot be absent while the publish state is still loading. It reads the state
 * from the same keyed fetcher PublishControl polls (AppShell mounts that on every page, including
 * this one), so it costs no extra request and never disagrees with the banner.
 *
 * Opening the panel goes through the URL (`?publish=1`), the same mechanism every other
 * "Review & publish →" link uses — the panel itself lives in AppShell, not here.
 */
export function PublishDeploymentButton({ className }: { className?: string }) {
  const data = useFetcher<PublishStatePayload>({ key: "publish-state" }).data;
  const publishHref = usePublishHref();
  const state = data?.connected ? publishControlState(data) : null;
  return (
    <div className={cn("flex items-center gap-3", className)}>
      {/* Never disabled, including mid-publish: the panel is also the pipeline view, so during a
          running publish this button is how you get to the live stepper. The panel's own primary
          action is what refuses to start a second publish. */}
      <Button asChild size="sm">
        <Link to={publishHref} prefetch="none">
          <Rocket className="h-4 w-4" aria-hidden />
          {state?.kind === "ready"
            ? `Publish ${state.count} change${state.count === 1 ? "" : "s"}`
            : "Publish"}
        </Link>
      </Button>
      <PublishStatusText state={state} />
    </div>
  );
}

/** The quiet status line beside the Deployment tab's Publish button. */
function PublishStatusText({ state }: { state: PublishControlState | null }) {
  if (!state) return null;
  if (state.kind === "live") {
    return (
      <span className="text-xs text-muted-foreground">
        Live{state.version ? ` · ${state.version}` : ""}
      </span>
    );
  }
  if (state.kind === "deploying") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Starting your agents
      </span>
    );
  }
  if (state.kind === "running") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        <span className="truncate">{state.summary ?? "Publishing…"}</span>
      </span>
    );
  }
  if (state.kind === "failed") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <XCircle className="h-3.5 w-3.5" aria-hidden />
        Last publish failed
      </span>
    );
  }
  if (state.kind === "never-deployed") {
    return <span className="text-xs text-muted-foreground">Not deployed yet</span>;
  }
  return null;
}

export function PublishPanel({
  projectId,
  data,
  open,
  onOpenChange,
  resultTaskId = null,
}: {
  projectId: string;
  data: PublishStatePayload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An explicit completed task requested by a `?publish=<taskId>` result link. */
  resultTaskId?: string | null;
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

  // §4.3 success: when the publish this panel WATCHED completes, show "Live · vN" with the
  // final all-green steps, then auto-dismiss. Watched = the running task we polled (or the one
  // our POST returned) — a succeeded task lingering in the 24h window never re-celebrates.
  const watchedTaskId = useRef<string | null>(null);
  const prevOpen = useRef(open);
  useEffect(() => {
    if (resultTaskId) {
      watchedTaskId.current = resultTaskId;
      // A result URL can arrive while this mounted panel is closed. Mark that transition as
      // already handled so the ordinary reopen reset below cannot erase the requested result.
      prevOpen.current = true;
    }
  }, [resultTaskId]);
  useEffect(() => {
    if (data.running && !resultTaskId) watchedTaskId.current = data.running.taskId;
  }, [data.running, resultTaskId]);
  useEffect(() => {
    if (publish.data?.taskId) watchedTaskId.current = publish.data.taskId;
  }, [publish.data]);
  const [success, setSuccess] = useState<{
    steps: PipelineStep[];
    version: string | null;
  } | null>(null);
  useEffect(() => {
    // A different publish may already be running when an older result row is opened. Only the
    // ordinary watched-publish flow waits for `running` to clear; an explicit result selects
    // its own succeeded payload independently.
    if (!open || (data.running && !resultTaskId)) return;
    const done = data.succeeded;
    if (done && watchedTaskId.current === done.taskId) {
      watchedTaskId.current = null;
      setAwaitingStart(false);
      setSuccess({ steps: done.steps ?? [], version: publishedVersion(done.steps) });
    }
  }, [open, data.running, data.succeeded, resultTaskId]);
  const closeAfterSuccess = useEffectEvent(() => onOpenChange(false));
  useEffect(() => {
    // An explicitly requested result is a destination, not a transient celebration. Leave it
    // open until the user closes it so a fresh navigation cannot make the result disappear.
    if (!success || !open || resultTaskId) return;
    const timer = setTimeout(closeAfterSuccess, SUCCESS_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [success, open, resultTaskId]);
  // Reset the celebration on the next open (not on close — the dialog's exit animation would
  // flash review mode) so a reopened panel starts from the live state.
  useEffect(() => {
    if (open && !prevOpen.current) setSuccess(null);
    prevOpen.current = open;
  }, [open]);

  // Never-deployed repos with nothing saved publish the branch HEAD instead (§4.1). A HEAD
  // publish has no pipeline task — close the panel when the POST comes back clean.
  const headMode = data.changeCount === 0 && !data.deployed;
  // Which intent the in-flight POST actually carried. Re-deriving headMode when the fetcher
  // settles doesn't work: shipRepoHead inserts the deployment rows before that, so the next
  // revalidation flips `deployed` true and headMode false — which used to strand the panel
  // showing five pending steps that no task would ever advance.
  const submittedHead = useRef(false);
  const wasPublishing = useRef(false);
  useEffect(() => {
    const finished = wasPublishing.current && !publishing;
    wasPublishing.current = publishing;
    if (!finished) return;
    if (submittedHead.current) {
      submittedHead.current = false;
      if (!publish.data?.error) onOpenChange(false);
      return;
    }
    // A publish that came back without a task id never started one — don't wait on it.
    if (!publish.data?.taskId) setAwaitingStart(false);
  }, [publishing, publish.data, onOpenChange]);

  const handleOpenChange = (next: boolean) => {
    if (next) setErrorStale(true);
    onOpenChange(next);
  };

  const submit = () => {
    setErrorStale(false);
    submittedHead.current = headMode;
    // Only a pipeline publish has a task to wait for; a HEAD publish must never show one.
    setAwaitingStart(!headMode);
    publish.submit(
      {
        intent: headMode ? "publish-head" : "publish",
        ...(env ? { env } : {}),
      },
      { method: "post", action },
    );
  };

  const mode: "success" | "pipeline" | "review" = success
    ? "success"
    : data.running || failed || awaitingStart
      ? "pipeline"
      : "review";
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
        {mode === "success" && success ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2
                  className="size-5 text-emerald-600 dark:text-emerald-400"
                  aria-hidden
                />
                Live{success.version ? ` · ${success.version}` : ""}
              </DialogTitle>
              <DialogDescription>
                Your changes are live.{" "}
                <Link
                  to={`/repos/${projectId}`}
                  className="underline underline-offset-4 hover:text-foreground"
                  onClick={() => onOpenChange(false)}
                >
                  See your running agents →
                </Link>
              </DialogDescription>
            </DialogHeader>
            <PipelineStepList steps={success.steps} />
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : mode === "pipeline" ? (
          <>
            <DialogHeader>
              <DialogTitle>{failed ? "Publish failed" : "Publishing"}</DialogTitle>
              <DialogDescription>
                {failed
                  ? "One step failed — nothing you saved was lost."
                  : "Your changes are going live. You can close this — progress stays in the header."}
              </DialogDescription>
            </DialogHeader>
            <PipelineStepList
              steps={steps}
              assistantFixHref={
                failed ? `/repos/${projectId}/assistant?fix=${failed.taskId}` : undefined
              }
              onAskAssistant={failed ? () => onOpenChange(false) : undefined}
              onBackToChanges={failed ? backToChanges : undefined}
            />
            <DialogFooter>
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
 * §4.3's vertical stepper — the pipeline UI at full density (the header control and task strip
 * derive their one-liners from the same steps). Every step is visible from the start (pending
 * greyed) so the whole shape is legible before anything happens; the running step shows a
 * spinner and its live detail; build/deploy substeps render inline, one per member; skipped
 * steps stay visible, greyed, with their reason (an absent step reads as a bug). On failure
 * the failed step turns red and auto-expands: the full output renders in a monospace block
 * preserving newlines, with the two recovery actions beneath it — "Ask the assistant to fix
 * this" (hands the error to the assistant as pre-filled context) and "Back to changes"
 * (returns to review mode; nothing was lost). Steps after a failure stay pending — only one
 * step ever fails. role="list" with aria-live="polite" on the running step's row announces
 * transitions without spamming. Exported for unit tests.
 */
export function PipelineStepList({
  steps,
  assistantFixHref,
  onAskAssistant,
  onBackToChanges,
}: {
  steps: PipelineStep[];
  /** On failure: link that opens the assistant with the failure pre-filled as context. */
  assistantFixHref?: string;
  /** Called when the assistant handoff link is followed (the panel closes itself). */
  onAskAssistant?: () => void;
  /** On failure: returns the panel to review mode — nothing was lost. */
  onBackToChanges?: () => void;
}) {
  return (
    <ol role="list" className="min-w-0 space-y-2 text-sm">
      {steps.map((step) => (
        <li key={step.key} data-step={step.key} data-status={step.status} className="min-w-0">
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
            {step.detail && (step.status === "running" || step.status === "succeeded") && (
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
          {step.status === "failed" && (
            <div className="mt-1.5 space-y-2">
              {step.error && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-xs text-destructive">
                  {step.error}
                </pre>
              )}
              {(assistantFixHref || onBackToChanges) && (
                <div className="flex flex-wrap items-center gap-2">
                  {assistantFixHref && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={assistantFixHref} onClick={onAskAssistant}>
                        <Sparkles className="h-3.5 w-3.5" aria-hidden />
                        Ask the assistant to fix this
                      </Link>
                    </Button>
                  )}
                  {onBackToChanges && (
                    <Button size="sm" variant="ghost" onClick={onBackToChanges}>
                      Back to changes
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
