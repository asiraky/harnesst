import { useEffect, useState } from "react";
import { useFetcher, useLocation } from "react-router";
import { Link } from "react-router";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { Button } from "~/components/ui/button";
import type { WorkspaceTask } from "~/components/workspace-tasks";
import { selectResetTask } from "~/models/reset-progress";
import type { ResetModelsResult } from "~/models/reset-model.server";

/** Explicit scope and progress for the application-managed model reset. */
export function ModelResetControl({
  projectId,
  workspaceDefaultModel,
  scope,
  team = false,
  nested = false,
  disabled = false,
  parentName,
}: {
  projectId: string;
  workspaceDefaultModel: string | null;
  scope: string[];
  team?: boolean;
  nested?: boolean;
  disabled?: boolean;
  parentName?: string;
}) {
  const reset = useFetcher<ResetModelsResult>();
  // The shell owns polling; sharing its keyed fetcher keeps deployment progress consistent.
  const tasks = useFetcher<{ tasks: WorkspaceTask[] }>({
    key: "workspace-tasks",
  });
  const result = reset.data;
  const location = useLocation();
  const restoredTask =
    result === undefined
      ? selectResetTask(
          tasks.data?.tasks ?? [],
          location.pathname,
          `/repos/${projectId}/settings`,
        )
      : undefined;
  const taskId =
    result?.ok && result.mode === "publishing"
      ? result.taskId
      : (restoredTask?.id ?? null);
  const currentTask = tasks.data?.tasks.find((row) => row.id === taskId);
  const [finishedTask, setFinishedTask] = useState<WorkspaceTask | null>(null);
  useEffect(() => {
    if (currentTask && currentTask.status !== "running")
      setFinishedTask(currentTask);
  }, [currentTask]);
  // Dismissing the shell's terminal task must not turn this completed reset back into a spinner.
  const task =
    currentTask ?? (finishedTask?.id === taskId ? finishedTask : null);
  const publishing = taskId !== null && (!task || task.status === "running");
  const busy = reset.state !== "idle" || publishing;
  const label = team
    ? "Reset all agents to workspace default"
    : nested
      ? `Reset to inherit from ${parentName ?? "parent"}`
      : "Reset to workspace default";
  const description = team
    ? `Applies to ${scope.join(", ")}. Clears every member and declared-subagent model and reasoning override, including legacy hardcoded models. Later workspace-default changes flow through automatically. Any necessary code changes are published and deployed by HARNESST.`
    : `Applies to ${scope.join(", ")} only. Clears this agent's model and reasoning choice and enables live ${nested ? "parent" : "workspace"} inheritance. Other agents and explicit subagent overrides are preserved. Subagents without their own override follow the new inherited model. Any necessary code changes are published and deployed by HARNESST.`;

  return (
    <div className="space-y-2">
      {team && (
        <p className="text-sm text-muted-foreground">
          Affected agents: {scope.join(", ")}.
        </p>
      )}
      {!workspaceDefaultModel ? (
        <p className="text-sm text-muted-foreground">
          <Link
            to="/settings/connections"
            className="underline underline-offset-4"
          >
            Configure a workspace default model
          </Link>{" "}
          before resetting agents.
        </p>
      ) : (
        <ConfirmDialog
          variant={team ? "destructive" : "default"}
          title={label}
          description={`${description} Workspace default: ${workspaceDefaultModel}.`}
          confirmLabel={team ? "Reset all agents" : "Reset agent"}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={disabled || busy}
              onClick={(event) => {
                if (disabled || busy) event.preventDefault();
              }}
            >
              {busy ? "Applying reset…" : label}
            </Button>
          }
          onConfirm={() => {
            if (disabled || busy) return;
            reset.submit(
              {
                intent: team
                  ? "reset-all-model-defaults"
                  : "reset-model-default",
              },
              { method: "post" },
            );
          }}
        />
      )}
      {result && !result.ok && (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      )}
      {task?.status === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          Reset deployment failed.{" "}
          {task.error ??
            "The previous runtime may still be active. Review the failure and retry."}{" "}
          <Link
            to={`/repos/${projectId}?publish=${taskId}`}
            className="underline underline-offset-4"
          >
            View deployment progress
          </Link>
        </p>
      )}
      <div aria-live="polite" aria-atomic="true">
        {reset.state !== "idle" && (
          <p className="text-sm text-muted-foreground">
            Checking agent configuration and preparing the reset…
          </p>
        )}
        {taskId && task?.status !== "failed" && (
          <p className="text-sm text-muted-foreground">
            {task?.status === "succeeded"
              ? "Reset published and deployed. Inherited selections refresh within 30 seconds."
              : "Reset is publishing and deploying. The previous configuration may remain active until deployment finishes."}{" "}
            <Link
              to={`/repos/${projectId}?publish=${taskId}`}
              className="underline underline-offset-4"
            >
              View deployment progress
            </Link>
          </p>
        )}
        {result?.ok && result.mode === "applied" && (
          <p className="text-sm text-muted-foreground">
            Reset saved. Running agents refresh the inherited model and
            reasoning selection within 30 seconds.
          </p>
        )}
      </div>
    </div>
  );
}
