/**
 * The one place a publish task becomes what the user sees (issue #225 §4.3 — "one source of
 * truth, two densities"). Both readers go through here: the Publish panel's full stepper
 * (`repos/:projectId/publish`) and the compact header indicator (`repos/:projectId/tasks`), so
 * they can never tell different stories about the same publish.
 *
 * The resolution that matters is against the LIVE deployment rows. The pipeline's own work ends
 * when every member's deploy is QUEUED, so the task row goes `succeeded` while the agents are
 * still building — and a deploy that fails after the queue never touches the task at all. A
 * reader that trusts `task.status` alone therefore reports success for a publish that is still
 * coming up, or for one that has already failed.
 */
import { inArray } from "drizzle-orm";

import type { PipelineStep, WorkspaceTask } from "~/data/ports";
import { db } from "~/db/client.server";
import { deployments } from "~/db/schema";
import {
  deploymentIdsOf,
  resolveDeployProgress,
  stepsFailure,
  stepsSettled,
  type DeploymentSnapshot,
} from "~/publish/publish-panel";

/** A task as presented: its steps resolved against the deployment rows, and the status that follows. */
export interface PresentedTask {
  steps: PipelineStep[] | null;
  /** `running` while deploys are still coming up; `failed` when one of them failed. */
  status: string;
}

/**
 * Present every given task. One query reads the deployment rows all of their deploy substeps
 * recorded; each task's steps are then resolved against those rows and its status re-derived
 * from the result.
 */
export async function presentTasks(
  tasks: WorkspaceTask[],
): Promise<Map<string, PresentedTask>> {
  const ids = [...new Set(tasks.flatMap((t) => deploymentIdsOf(t.steps)))];
  const rows = ids.length
    ? await db
        .select({
          id: deployments.id,
          status: deployments.status,
          errorDetail: deployments.errorDetail,
        })
        .from(deployments)
        .where(inArray(deployments.id, ids))
    : [];
  const snapshots = new Map<string, DeploymentSnapshot>(
    rows.map((d) => [d.id, { status: d.status, errorDetail: d.errorDetail }]),
  );
  return new Map(tasks.map((t) => [t.id, presentOne(t, snapshots)]));
}

function presentOne(
  task: WorkspaceTask,
  snapshots: Map<string, DeploymentSnapshot>,
): PresentedTask {
  const steps = resolveDeployProgress(task.steps, snapshots);
  // A recorded failure always wins: the pipeline failed, or a deploy row did after the queue.
  if (stepsFailure(steps)) return { steps, status: "failed" };
  // The task finished its work but the agents it queued are not up yet — still running to a user.
  if (task.status === "succeeded" && !stepsSettled(steps)) return { steps, status: "running" };
  return { steps, status: task.status };
}
