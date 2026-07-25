/**
 * Publish-a-change runner (issue #142). The deployments route used to call `publishDrafts`
 * synchronously inside the HTTP request — an orphan check plus a per-member Docker build gate plus
 * a GitHub PR — which could take a minute. It now runs on the durable job queue: the route enqueues
 * a `publish_change` job, the worker calls this, and it streams progress into the workspace task the
 * indicator shows.
 *
 * Error policy: `publishDrafts` throws for BOTH gate failures (orphan gate, build gate — the user's
 * change simply isn't publishable yet; the drafts stay staged for a fix) AND ordinary GitHub
 * failures. We treat ALL of them as the task's OUTCOME: fail the task, do NOT rethrow, let the job
 * complete. A gate failure is user-actionable, not a queue error, and re-running the merge/publish
 * after a transient hiccup is the user's call (jobs run maxAttempts:1). Only failures from loading
 * the project/task themselves rethrow, since those are genuine infrastructure errors.
 */
import type { DataStore } from "~/data/ports";
import { publishDrafts } from "~/drafts/drafts.server";
import { getRuntime } from "~/seams/index.server";
import { completeTask, failTask } from "~/tasks/tasks.server";

export interface PublishChangePayload {
  projectId: string;
  taskId: string;
  paths: string[];
  title?: string;
  createdBy?: string | null;
  [key: string]: unknown;
}

export async function runPublishChange(
  payload: PublishChangePayload,
  store: DataStore = getRuntime().data,
): Promise<void> {
  const { taskId, paths, title, createdBy } = payload;

  // Infrastructure reads — a failure here is a real queue error (rethrow).
  const project = await store.projects.findById(payload.projectId);
  if (!project || !project.repoInstallationId || !project.repoOwner || !project.repoName) {
    throw new Error(`publish_change: project ${payload.projectId} has no connected repo`);
  }
  const task = await store.workspaceTasks.findById(taskId);
  if (!task) throw new Error(`publish_change: task ${taskId} not found`);

  try {
    await publishDrafts(
      {
        project: {
          id: project.id,
          repoInstallationId: project.repoInstallationId,
          repoOwner: project.repoOwner,
          repoName: project.repoName,
          defaultBranch: project.defaultBranch,
        },
        paths,
        title,
        createdBy,
      },
      store,
    );
  } catch (error) {
    // Gate failures and GitHub errors alike are the task's outcome — the drafts stay staged.
    const message = error instanceof Error ? error.message : String(error);
    await failTask(taskId, message, store);
    return;
  }

  // Succeeded: the change request exists. The indicator links back to where the publish was
  // triggered (the Deployment tab), where the new change request now shows.
  await completeTask(taskId, { resultUrl: task.originUrl }, store);
}
