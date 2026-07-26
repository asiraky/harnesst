/**
 * Resource route behind the persistent workspace task-progress indicator (issue #142). The
 * indicator (AppShell) self-fetches this per project and polls it, so progress survives navigation
 * within a workspace without threading task data through every page's loader.
 *
 * GET  → this project's running + recent terminal tasks (dates serialized to ISO for the client).
 * POST intent=dismiss → dismiss a terminal task (the × in the indicator), scoped to the project.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { requireProject } from "~/project/guard.server";
import { presentTasks } from "~/publish/present.server";
import { getRuntime } from "~/seams/index.server";
import { dismissTask, listWorkspaceTasks } from "~/tasks/tasks.server";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId);
      const tasks = await listWorkspaceTasks(project.id);
      // Present through the same resolver the publish panel uses (§4.3): the compact indicator
      // must not call a publish succeeded while its agents are still coming up, nor miss a
      // deploy that failed after the pipeline queued it.
      const presented = await presentTasks(tasks);
      return {
        tasks: tasks.map((t) => ({
          id: t.id,
          kind: t.kind,
          subjectKey: t.subjectKey,
          label: t.label,
          steps: presented.get(t.id)?.steps ?? t.steps,
          status: presented.get(t.id)?.status ?? t.status,
          originUrl: t.originUrl,
          resultUrl: t.resultUrl,
          error: t.error,
          createdAt: t.createdAt.toISOString(),
        })),
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = await requireProject(auth, args.params.projectId);
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "dismiss") return { error: "Unknown action." };

  const taskId = String(form.get("taskId") ?? "");
  // Tenant guard: only dismiss a task that belongs to THIS project. dismissTask itself refuses a
  // still-running task, so a terminal-only + project-scoped check here is enough.
  const task = taskId ? await getRuntime().data.workspaceTasks.findById(taskId) : null;
  if (!task || task.projectId !== project.id) return { ok: false };
  const dismissed = await dismissTask(taskId);
  return { ok: dismissed };
}
