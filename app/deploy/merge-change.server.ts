/**
 * Merge-a-change runner (issue #142). This is the body that used to run INLINE in the deployments
 * route's `merge` action — a synchronous Docker build gate plus GitHub merge plus roster sync — now
 * moved onto the durable job queue so the HTTP request returns immediately. The route enqueues a
 * `merge_change` job; the worker calls this; it streams progress into the workspace task the
 * indicator shows.
 *
 * Faithful to the original ordering: pre-merge build gate (conversation branches only) → merge →
 * roster sync (warn-only) → releases → discard the conversation checkout. The gate builds EVERY
 * affected member root, recomputed server-side from the PR's changed files (issue #137, via
 * runConversationMergeGate — the publish gate's sibling). A failing gate is a task OUTCOME, not a
 * queue error: it fails the task and returns without merging (the job is `done`). A thrown error
 * from the merge/release path fails the task AND rethrows so the queue records it (jobs enqueued
 * with maxAttempts:1 — merges are not safe to auto-retry after partial side effects).
 *
 * GitHub/runtime dependencies are injectable so unit tests need no network or docker.
 */
import { runConversationMergeGate } from "~/assistant/merge-gate.server";
import type { DataStore } from "~/data/ports";
import { ensureReleasesForCommit } from "~/deploy/controller.server";
import { detectAgentRoots, hasTeamLayout } from "~/eve/parse";
import { syncProjectAgents } from "~/db/queries.server";
import { fetchAgentSource } from "~/github/repo.server";
import { listPullRequestFilePaths, mergePullRequest } from "~/github/write.server";
import { invalidateRepoSource, warmAgentSource } from "~/github/cached.server";
import {
  discardConversationCheckoutByBranch,
  isConversationBranch,
} from "~/assistant/checkout-sync.server";
import { getRuntime } from "~/seams/index.server";
import type { BuildCheckRequest, BuildCheckResult } from "~/seams/types";
import { completeTask, failTask } from "~/tasks/tasks.server";

export interface MergeChangePayload {
  projectId: string;
  taskId: string;
  pullNumber: number;
  branch?: string;
  title: string;
  createdBy?: string | null;
  /** Where the indicator's "View result" link points, e.g. `/repos/:id/agents/x/deployment`. */
  backUrl: string;
  [key: string]: unknown;
}

/** Injected GitHub/runtime seams (production defaults below); keeps unit tests off the network. */
export interface MergeChangeDeps {
  checkBuild?: (req: BuildCheckRequest) => Promise<BuildCheckResult>;
  listPullRequestFilePaths: typeof listPullRequestFilePaths;
  mergePullRequest: typeof mergePullRequest;
  fetchAgentSource: typeof fetchAgentSource;
  detectAgentRoots: typeof detectAgentRoots;
  syncProjectAgents: typeof syncProjectAgents;
  invalidateRepoSource: typeof invalidateRepoSource;
  warmAgentSource: typeof warmAgentSource;
  ensureReleasesForCommit: typeof ensureReleasesForCommit;
  discardConversationCheckoutByBranch: typeof discardConversationCheckoutByBranch;
}

function defaultDeps(): MergeChangeDeps {
  return {
    checkBuild: getRuntime().deployTarget.checkBuild,
    listPullRequestFilePaths,
    mergePullRequest,
    fetchAgentSource,
    detectAgentRoots,
    syncProjectAgents,
    invalidateRepoSource,
    warmAgentSource,
    ensureReleasesForCommit,
    discardConversationCheckoutByBranch,
  };
}

export async function runMergeChange(
  payload: MergeChangePayload,
  deps: MergeChangeDeps = defaultDeps(),
  store: DataStore = getRuntime().data,
): Promise<void> {
  const { taskId, pullNumber, branch, title, createdBy, backUrl } = payload;
  const project = await store.projects.findById(payload.projectId);
  if (!project || !project.repoInstallationId || !project.repoOwner || !project.repoName) {
    throw new Error(`merge_change: project ${payload.projectId} has no connected repo`);
  }
  const repo = { owner: project.repoOwner, repo: project.repoName };
  const conversation = isConversationBranch(branch);

  // 1. Authoritative pre-merge gate for assistant conversation branches: build the branch's tree
  //    exactly as it will exist after merge (NO draft overlay), one build per affected member
  //    root recomputed from the PR's changed files (issue #137). A failure is the task's
  //    outcome — nothing merges, and the job completes normally.
  if (conversation && deps.checkBuild) {
    const paths = await deps.listPullRequestFilePaths(
      project.repoInstallationId,
      repo,
      pullNumber,
    );
    const installationId = project.repoInstallationId;
    const gate = await runConversationMergeGate({
      projectId: project.id,
      repo,
      ref: branch!,
      installationId,
      teamLayout: project.layout === "team",
      paths,
      checkBuild: deps.checkBuild,
    });
    if (!gate.ok) {
      await failTask(taskId, gate.error, store);
      return;
    }
  }

  try {
    // 2. Merge → one commit on the default branch (the version identity).
    const { mergeSha } = await deps.mergePullRequest(
      project.repoInstallationId,
      repo,
      pullNumber,
      branch,
    );

    // 3. Roster sync is best-effort (warn-only, exactly as the inline action was): a merged commit
    //    must still cut releases even if the tree read hiccups.
    try {
      const source = await deps.fetchAgentSource(project.repoInstallationId, {
        ...repo,
        ref: mergeSha,
      });
      const detected = deps.detectAgentRoots(source.paths);
      await deps.syncProjectAgents(project.id, detected, undefined, undefined, {
        allowEmpty:
          project.layout === "team" && hasTeamLayout(source.paths) && detected.length === 0,
      });
      deps.invalidateRepoSource(project.repoInstallationId, repo);
      deps.warmAgentSource(project.repoInstallationId, repo, {
        ...source,
        ref: project.defaultBranch,
      });
    } catch (error) {
      console.warn("[merge_change] merged but couldn't sync roster:", error);
    }

    const results = await deps.ensureReleasesForCommit({
      projectId: project.id,
      gitSha: mergeSha,
      changelog: `#${pullNumber} ${title}`.trim(),
      createdBy,
    });
    if (conversation) await deps.discardConversationCheckoutByBranch(branch!);

    const version = results[0]?.release.version ?? "";
    await completeTask(
      taskId,
      { resultUrl: `${backUrl}?released=${encodeURIComponent(version)}` },
      store,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failTask(taskId, message, store);
    throw error;
  }
}
