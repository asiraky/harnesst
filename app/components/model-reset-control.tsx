import { useFetcher } from "react-router";
import { Link } from "react-router";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { Button } from "~/components/ui/button";
import type { WorkspaceTask } from "~/components/workspace-tasks";
import type { ResetModelsResult } from "~/models/reset-model.server";

/** Explicit scope and progress for the application-managed model reset. */
export function ModelResetControl({
  projectId,
  workspaceDefaultModel,
  scope,
  team = false,
  nested = false,
  disabled = false,
}: {
  projectId: string;
  workspaceDefaultModel: string | null;
  scope: string[];
  team?: boolean;
  nested?: boolean;
  disabled?: boolean;
}) {
  const reset = useFetcher<ResetModelsResult>();
  // The shell owns polling; sharing its keyed fetcher keeps deployment progress consistent.
  const tasks = useFetcher<{ tasks: WorkspaceTask[] }>({
    key: "workspace-tasks",
  });
  const result = reset.data;
  const taskId =
    result?.ok && result.mode === "publishing" ? result.taskId : null;
  const task = tasks.data?.tasks.find((row) => row.id === taskId);
  const publishing = taskId !== null && (!task || task.status === "running");
  const busy = reset.state !== "idle" || publishing;
  const label = team
    ? "Reset all agents to workspace default"
    : nested
      ? "Reset to parent default"
      : "Reset to workspace default";
  const description = team
    ? `Applies to ${scope.join(", ")}. Clears every member and declared-subagent model and reasoning override, including legacy hardcoded models. Later workspace-default changes flow through automatically. Any necessary code changes are published and deployed by HARNESST.`
    : `Applies to ${scope.join(", ")} only. Clears this agent's model and reasoning choice and enables live ${nested ? "parent" : "workspace"} inheritance. Other agents and explicit subagent overrides are preserved. Any necessary code changes are published and deployed by HARNESST.`;

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
          variant="default"
          title={label}
          description={description}
          confirmLabel={team ? "Reset all agents" : "Reset agent"}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
            >
              {busy ? "Applying reset…" : label}
            </Button>
          }
          onConfirm={() =>
            reset.submit(
              {
                intent: team
                  ? "reset-all-model-defaults"
                  : "reset-model-default",
              },
              { method: "post" },
            )
          }
        />
      )}
      {reset.state !== "idle" && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking agent configuration and preparing the reset…
        </p>
      )}
      {result && !result.ok && (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      )}
      {taskId && (
        <p
          role="status"
          className={
            task?.status === "failed"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {task?.status === "failed"
            ? `Reset deployment failed. ${task.error ?? "The previous runtime may still be active. Review the failure and retry the reset."}`
            : task?.status === "succeeded"
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
        <p role="status" className="text-sm text-muted-foreground">
          Reset saved. Running agents refresh the inherited model and reasoning
          selection within 30 seconds.
        </p>
      )}
    </div>
  );
}
