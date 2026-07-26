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
import { agents as agentsTable, deployments, environments, releases } from "~/db/schema";
import { listTeamEnvNames } from "~/deploy/environments.server";
import { shipRepoHead } from "~/deploy/ship.server";
import { discardDrafts, getDraft, listDrafts } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { readAgentFile } from "~/github/repo.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import {
  isAssistantConfigPath,
  requireProject,
  requireRepo,
  type ConnectedProject,
} from "~/project/guard.server";
import { cleanupOrphanedPendingSecrets } from "~/project/secrets.server";
import { startPublish } from "~/publish/pipeline.server";
import { presentTasks } from "~/publish/present.server";
import {
  changeAction,
  groupDrafts,
  stepsFailure,
  type PublishChangeRow,
  type PublishDiffPayload,
  type PublishStatePayload,
} from "~/publish/publish-panel";
import { unifiedDiff } from "~/publish/unified-diff";
import { getRuntime } from "~/seams/index.server";
import { listWorkspaceTasks } from "~/tasks/tasks.server";

/** Group label for changes the built-in assistant owns (`.harnesst/assistant/**`). */
const ASSISTANT_GROUP = "Assistant configuration";

/** How many staged paths the badge will probe individually before it stops asking (§4.2). */
const EXISTENCE_PROBE_LIMIT = 25;

const DISCONNECTED: PublishStatePayload = {
  connected: false,
  changeCount: 0,
  groups: [],
  deployed: false,
  deploying: false,
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
  const [drafts, tasks, envNames, agents] = await Promise.all([
    listDrafts(connected.id),
    listWorkspaceTasks(connected.id),
    listTeamEnvNames(connected.id),
    getRuntime().data.agents.listByProject(connected.id),
  ]);

  // The panel groups by EVERY agent that can own a change, not just the member roster: the
  // built-in assistant owns `.harnesst/assistant/**`, and a change the grouping can't name is a
  // change the user never sees but Publish still ships (§4.2 — every pending change, with a
  // diff and its owner).
  const roster = [
    ...agents.filter((a) => a.kind === "member").map((a) => ({ id: a.id, name: a.name })),
    ...agents
      .filter((a) => a.kind === "assistant")
      .map((a) => ({ id: a.id, name: ASSISTANT_GROUP })),
  ];

  const existsInRepo = await resolveExistence(
    connected,
    drafts.map((d) => d.path),
  );

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
        action: changeAction(d.content, existsInRepo.get(d.path) ?? null),
        savedBy: d.createdBy ? (userNames.get(d.createdBy) || "a teammate") : null,
        savedAt: d.updatedAt.toISOString(),
      },
    ]),
  );
  const groups = groupDrafts(drafts, roster).map((g) => ({
    member: g.member,
    files: g.files.map((path) => rowByPath.get(path)!),
  }));

  // Live status, read across the TEAM's environments only. The built-in assistant runs as its
  // own instance with its own release stream (t1, t2, …); letting an assistant redeploy win
  // this query makes the header read "Live · t3" for a team running v19 (§4.1 — the version
  // the team is running). `deploying` covers the deploys that no publish task owns (a HEAD
  // publish, a rollback), so the control reports progress instead of claiming "Live" with no
  // version while every row is still pending.
  const teamDeployments = and(
    eq(environments.projectId, connected.id),
    eq(agentsTable.kind, "member"),
  );
  const [[liveRow], [anyDeployment], [inFlight]] = await Promise.all([
    db
      .select({ version: releases.version })
      .from(deployments)
      .innerJoin(environments, eq(deployments.environmentId, environments.id))
      .innerJoin(agentsTable, eq(environments.agentId, agentsTable.id))
      .innerJoin(releases, eq(deployments.releaseId, releases.id))
      .where(and(teamDeployments, eq(deployments.status, "live")))
      .orderBy(desc(deployments.updatedAt))
      .limit(1),
    db
      .select({ id: deployments.id })
      .from(deployments)
      .innerJoin(environments, eq(deployments.environmentId, environments.id))
      .innerJoin(agentsTable, eq(environments.agentId, agentsTable.id))
      .where(teamDeployments)
      .limit(1),
    db
      .select({ id: deployments.id })
      .from(deployments)
      .innerJoin(environments, eq(deployments.environmentId, environments.id))
      .innerJoin(agentsTable, eq(environments.agentId, agentsTable.id))
      .where(and(teamDeployments, inArray(deployments.status, ["pending", "building"])))
      .limit(1),
  ]);

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

  // Present each task's steps against the LIVE deployment rows (§3.2 honesty), through the same
  // resolver the compact header indicator reads — a completed task whose deploys are still
  // coming up presents as running, one whose deploy failed after the queue presents as failed.
  const presented = await presentTasks(
    [running, failed, succeeded].filter((t): t is NonNullable<typeof t> => t != null),
  );
  let runningPayload = running
    ? { taskId: running.id, steps: presented.get(running.id)?.steps ?? running.steps }
    : null;
  let failedPayload = failed
    ? {
        taskId: failed.id,
        steps: presented.get(failed.id)?.steps ?? failed.steps,
        error: failed.error,
      }
    : null;
  let succeededPayload: PublishStatePayload["succeeded"] = null;
  if (succeeded) {
    const view = presented.get(succeeded.id);
    const resolved = view?.steps ?? succeeded.steps;
    if (view?.status === "failed" && (!failed || succeeded.createdAt > failed.createdAt)) {
      failedPayload = {
        taskId: succeeded.id,
        steps: resolved,
        error: stepsFailure(resolved)?.error ?? null,
      };
    } else if (view?.status === "running") {
      runningPayload ??= { taskId: succeeded.id, steps: resolved };
    } else if (view?.status !== "failed") {
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
    deploying: !!inFlight,
    liveVersion: liveRow?.version ?? null,
    envNames,
    needsEnvironmentChoice: envNames.length > 1 && !resolved && !assistantConfigOnly,
    running: runningPayload,
    failed: failedPayload,
    succeeded: succeededPayload,
  };
}

/**
 * Which staged paths already exist on the default branch — the New-vs-Edited badge (§4.2).
 *
 * The cached agent-source tree only carries agent directories, so a staged repo-root file (harnesst
 * stages `package.json` alongside a model change) is simply absent from it and would badge "New"
 * while its own diff shows existing lines being replaced. Paths that tree can't account for are
 * probed individually — cheap, since only staged paths are asked about and agent-directory paths
 * are already answered. Unknown (a read that errored, or more paths than the probe budget) maps
 * to null, which `changeAction` degrades to "edited" rather than mislabelling as new.
 */
async function resolveExistence(
  connected: ConnectedProject,
  paths: string[],
): Promise<Map<string, boolean | null>> {
  const result = new Map<string, boolean | null>();
  const repo = { owner: connected.repoOwner, repo: connected.repoName };
  let known: Set<string>;
  try {
    const source = await getAgentSource(connected.repoInstallationId, repo);
    known = new Set(source.paths);
  } catch {
    return result; // every badge degrades to "edited"
  }
  const unaccounted: string[] = [];
  for (const path of paths) {
    if (known.has(path)) result.set(path, true);
    else unaccounted.push(path);
  }
  if (unaccounted.length > EXISTENCE_PROBE_LIMIT) return result;
  await Promise.all(
    unaccounted.map(async (path) => {
      try {
        const content = await readAgentFile(connected.repoInstallationId, repo, path);
        result.set(path, content !== null);
      } catch {
        result.set(path, null);
      }
    }),
  );
  return result;
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
