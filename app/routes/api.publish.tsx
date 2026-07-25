/**
 * Resource route behind the persistent Publish control + panel (issue #225 §4.1/§4.2). The
 * control lives in AppShell's header and self-fetches here, so every back-of-house page gets it
 * without threading publish data through each loader.
 *
 * GET → the project's publish state: every saved change (grouped by owning member + shared,
 * with action badge, who saved it and when), the live/never-deployed status, the §2.8
 * environment question when resolution needs an answer, and the running/failed publish task.
 * `?diff=<path>` instead returns one saved change's unified diff for the expandable row.
 *
 * POST intents:
 * - `publish`      → start the publish pipeline (check → build → commit → version → deploy) as
 *                    the queued `publish` job; `env` carries the §2.8 one-time answer if asked.
 * - `publish-head` → never-deployed repos: cut versions at the branch HEAD and start the whole
 *                    team (`shipRepoHead`) — there is no change-set to build.
 * - `discard` / `discard-all` → drop saved changes without publishing (plus the pending-secret
 *                    sweep: an abandoned member install must not strand held secrets).
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { user } from "~/db/auth-schema";
import { db } from "~/db/client.server";
import { listAgents } from "~/db/queries.server";
import { deployments, environments, releases } from "~/db/schema";
import { listTeamEnvNames } from "~/deploy/environments.server";
import { shipRepoHead } from "~/deploy/ship.server";
import { discardDrafts, getDraft, listDrafts } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { readAgentFile } from "~/github/repo.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { resolveAgentContext } from "~/project/agent-context.server";
import {
  isAssistantConfigPath,
  requireProject,
  requireRepo,
  type ConnectedProject,
} from "~/project/guard.server";
import { cleanupOrphanedPendingSecrets } from "~/project/secrets.server";
import { startPublish } from "~/publish/pipeline.server";
import {
  changeAction,
  deploymentIdsOf,
  groupDrafts,
  resolveDeployProgress,
  stepsFailure,
  stepsSettled,
  type DeploymentSnapshot,
  type PublishChangeRow,
  type PublishDiffPayload,
  type PublishStatePayload,
} from "~/publish/publish-panel";
import { unifiedDiff } from "~/publish/unified-diff";
import { getRuntime } from "~/seams/index.server";
import { listWorkspaceTasks } from "~/tasks/tasks.server";

const DISCONNECTED: PublishStatePayload = {
  connected: false,
  changeCount: 0,
  groups: [],
  deployed: false,
  liveVersion: null,
  envNames: [],
  needsEnvironmentChoice: false,
  running: null,
  failed: null,
  succeeded: null,
};

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<PublishStatePayload | PublishDiffPayload> => {
      const project = await requireProject(auth, args.params.projectId);
      if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
        return DISCONNECTED;
      }
      const connected = requireRepo(project);

      const diffPath = new URL(args.request.url).searchParams.get("diff");
      if (diffPath) {
        // One saved change's diff, fetched lazily when its row expands. The draft holds the
        // whole new content; the repo's default branch holds the old side. An unreadable repo
        // side degrades to a whole-file view rather than failing the row.
        const draft = await getDraft(connected.id, diffPath);
        if (!draft) return { path: diffPath, action: "edited", patch: null };
        const repoContent = await readAgentFile(
          connected.repoInstallationId,
          { owner: connected.repoOwner, repo: connected.repoName },
          diffPath,
        ).catch(() => null);
        return {
          path: diffPath,
          action: changeAction(draft.content, repoContent !== null),
          patch: unifiedDiff(repoContent, draft.content),
        };
      }

      // Degrade to the disconnected (render-nothing) payload on any failure — a shared-header
      // control must never take the page down with it.
      try {
        return await publishState(connected);
      } catch {
        return DISCONNECTED;
      }
    },
    { ensureSignedIn: true },
  );

/** Build the GET payload the control polls: changes, live status, env question, task state. */
async function publishState(connected: ConnectedProject): Promise<PublishStatePayload> {
  const [drafts, tasks, envNames, { roster }] = await Promise.all([
    listDrafts(connected.id),
    listWorkspaceTasks(connected.id),
    listTeamEnvNames(connected.id),
    resolveAgentContext(connected.id, null),
  ]);

  // Repo tree for the New-vs-Edited badge — one cached read, never a per-file fetch. A
  // failure degrades badges to "edited" rather than blocking the control.
  let repoPaths: Set<string> | null = null;
  try {
    const source = await getAgentSource(connected.repoInstallationId, {
      owner: connected.repoOwner,
      repo: connected.repoName,
    });
    repoPaths = new Set(source.paths);
  } catch {
    repoPaths = null;
  }

  // Who saved each change: a user id resolves to a display name; null = the assistant
  // (§2.7 — assistant-saved drafts are the authorless ones).
  const saverIds = [
    ...new Set(drafts.map((d) => d.createdBy).filter((id): id is string => id != null)),
  ];
  const userRows = saverIds.length
    ? await db
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(inArray(user.id, saverIds))
    : [];
  const userNames = new Map(userRows.map((u) => [u.id, u.name]));
  const rowByPath = new Map<string, PublishChangeRow>(
    drafts.map((d) => [
      d.path,
      {
        path: d.path,
        action: changeAction(d.content, repoPaths ? repoPaths.has(d.path) : null),
        savedBy: d.createdBy ? (userNames.get(d.createdBy) ?? "a teammate") : null,
        savedAt: d.updatedAt.toISOString(),
      },
    ]),
  );
  const groups = groupDrafts(
    drafts,
    roster.map((a) => ({ id: a.id, name: a.name })),
  ).map((g) => ({
    member: g.member,
    files: g.files.map((path) => rowByPath.get(path)!),
  }));

  // Live status: the newest live deployment's version, and whether ANY deployment exists
  // (never-deployed repos get the Publish-HEAD state instead of "Live").
  const [liveRow] = await db
    .select({ version: releases.version })
    .from(deployments)
    .innerJoin(environments, eq(deployments.environmentId, environments.id))
    .innerJoin(releases, eq(deployments.releaseId, releases.id))
    .where(and(eq(environments.projectId, connected.id), eq(deployments.status, "live")))
    .orderBy(desc(deployments.updatedAt))
    .limit(1);
  const [anyDeployment] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .innerJoin(environments, eq(deployments.environmentId, environments.id))
    .where(eq(environments.projectId, connected.id))
    .limit(1);

  const running = tasks.find((t) => t.subjectKey === "publish" && t.status === "running");
  // Newest failed/succeeded, undismissed publish (listWorkspaceTasks filters dismissed rows).
  // The panel's success state only fires for a publish it watched run, so the succeeded row
  // lingering in the task window never re-celebrates on a later open.
  const failed = [...tasks]
    .reverse()
    .find((t) => t.subjectKey === "publish" && t.status === "failed");
  const succeeded = [...tasks]
    .reverse()
    .find((t) => t.subjectKey === "publish" && t.status === "succeeded");

  // Present each task's steps against the LIVE deployment rows (§3.2 honesty): the pipeline
  // resolves when every deploy is queued, but "your agents started" is only true once those
  // rows reach `live` — and a post-queue deploy failure must surface here, not just on the
  // Deployment tab. A completed task whose deploys are still coming up is presented as the
  // running publish; one whose deploy failed is presented as the failed publish.
  const deploymentIds = [
    ...new Set([running, failed, succeeded].flatMap((t) => deploymentIdsOf(t?.steps))),
  ];
  const deploymentRows = deploymentIds.length
    ? await db
        .select({
          id: deployments.id,
          status: deployments.status,
          errorDetail: deployments.errorDetail,
        })
        .from(deployments)
        .where(inArray(deployments.id, deploymentIds))
    : [];
  const snapshots = new Map<string, DeploymentSnapshot>(
    deploymentRows.map((d) => [d.id, { status: d.status, errorDetail: d.errorDetail }]),
  );
  let runningPayload = running
    ? { taskId: running.id, steps: resolveDeployProgress(running.steps, snapshots) }
    : null;
  let failedPayload = failed
    ? {
        taskId: failed.id,
        steps: resolveDeployProgress(failed.steps, snapshots),
        error: failed.error,
      }
    : null;
  let succeededPayload: PublishStatePayload["succeeded"] = null;
  if (succeeded) {
    const resolved = resolveDeployProgress(succeeded.steps, snapshots);
    const failure = stepsFailure(resolved);
    if (failure && (!failed || succeeded.createdAt > failed.createdAt)) {
      failedPayload = {
        taskId: succeeded.id,
        steps: resolved,
        error: failure.error ?? null,
      };
    } else if (!failure && !stepsSettled(resolved)) {
      runningPayload ??= { taskId: succeeded.id, steps: resolved };
    } else if (!failure) {
      succeededPayload = { taskId: succeeded.id, steps: resolved };
    }
  }

  // §2.8: ask only when several envs exist and no persisted answer still names one of them.
  // Change-sets that touch only the assistant's config deploy nothing — never ask for those.
  const resolved =
    connected.liveEnvironmentName && envNames.includes(connected.liveEnvironmentName);
  const assistantConfigOnly =
    drafts.length > 0 && drafts.every((d) => isAssistantConfigPath(d.path));

  return {
    connected: true,
    changeCount: drafts.length,
    groups,
    deployed: !!anyDeployment,
    liveVersion: liveRow?.version ?? null,
    envNames,
    needsEnvironmentChoice: envNames.length > 1 && !resolved && !assistantConfigOnly,
    running: runningPayload,
    failed: failedPayload,
    succeeded: succeededPayload,
  };
}

/** Discard abandonment sweep: drop held pending secrets whose member install can't land now. */
async function sweepPendingSecrets(projectId: string): Promise<void> {
  try {
    const [roster, drafts] = await Promise.all([listAgents(projectId), listDrafts(projectId)]);
    await cleanupOrphanedPendingSecrets({
      projectId,
      rosterNames: roster.map((a) => a.name),
      draftPaths: drafts.map((d) => d.path),
    });
  } catch (error) {
    console.warn("[secrets] pending-secret sweep failed:", error);
  }
}

/**
 * Discard abandonment sweep for renames: a member's pending rename lives or dies with its saved
 * directory move — when no saved change still creates `agents/<pendingName>/`, the rename was
 * discarded and the mark must clear, or the member would read "rename saved" forever.
 */
async function sweepStalePendingRenames(projectId: string): Promise<void> {
  try {
    const store = getRuntime().data;
    const [agents, drafts] = await Promise.all([
      store.agents.listByProject(projectId),
      listDrafts(projectId),
    ]);
    for (const agent of agents) {
      if (agent.kind !== "member" || !agent.pendingName) continue;
      const dir = `agents/${agent.pendingName}/`;
      if (!drafts.some((d) => d.path.startsWith(dir) && d.content !== null)) {
        await store.agents.setPendingName(agent.id, null);
      }
    }
  } catch (error) {
    console.warn("[publish] pending-rename sweep failed:", error);
  }
}

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(await requireProject(auth, args.params.projectId));
  const store = getRuntime().data;

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "publish") {
      ensureWorkerStarted();
      const envName = String(form.get("env") ?? "").trim() || null;
      const result = await startPublish({
        projectId: project.id,
        originUrl: contextPath(project.id),
        createdBy: auth.user.id,
        envName,
      });
      return { ok: true as const, taskId: result.taskId };
    }

    if (intent === "publish-head") {
      // Never-deployed repos: there is no change-set — cut versions at the branch HEAD and
      // start the whole team. Env resolution follows §2.8 and persists the answer.
      ensureWorkerStarted();
      const envNames = await listTeamEnvNames(project.id);
      let envName =
        project.liveEnvironmentName && envNames.includes(project.liveEnvironmentName)
          ? project.liveEnvironmentName
          : envNames.length === 1
            ? envNames[0]
            : null;
      if (!envName) {
        const requested = String(form.get("env") ?? "").trim();
        if (!requested || !envNames.includes(requested)) {
          return { error: "Choose which environment your agents run in." };
        }
        envName = requested;
      }
      if (project.liveEnvironmentName !== envName) {
        await store.projects.setLiveEnvironmentName(project.id, envName);
      }
      await shipRepoHead({ project, envName, createdBy: auth.user.id });
      return { ok: true as const };
    }

    if (intent === "discard") {
      const path = String(form.get("path") ?? "");
      if (!path) return { error: "Missing file to discard." };
      await discardDrafts(project.id, [path]);
      await sweepPendingSecrets(project.id);
      await sweepStalePendingRenames(project.id);
      return { ok: true as const };
    }

    if (intent === "discard-all") {
      const drafts = await listDrafts(project.id);
      await discardDrafts(
        project.id,
        drafts.map((d) => d.path),
      );
      await sweepPendingSecrets(project.id);
      await sweepStalePendingRenames(project.id);
      return { ok: true as const };
    }

    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}
