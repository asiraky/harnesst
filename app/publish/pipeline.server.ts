/**
 * The publish pipeline (issue #225) — the ONE way a change goes live.
 *
 * Publish takes every saved draft through check → build → commit → version → deploy as a single
 * `publish` job, recording each step on the workspace task's `steps` (the publish panel renders
 * the full stepper, the header control derives its one-liner from the running step). Nothing
 * broken ever lands: the build runs BEFORE the commit, and a failed build leaves no commit, no
 * release, no deploy, and every draft still saved.
 *
 * One build, not two (§3.2): the build step produces real images under provisional tags
 * (`harnesst/publish-<taskId>:…`). After the commit lands and Releases are cut, the images are
 * promoted to the commit's runtime tags and each touched member's Release gets its `imageRef`,
 * so the queued deploys (`rebuild: false`) skip their own build. Untouched members (the team is
 * the deployment unit — everyone deploys) get a Release with no imageRef and build at deploy
 * time, which docker layer caching keeps cheap.
 *
 * The commit is a compare-and-swap fast-forward onto the default branch (§3.1), anchored on the
 * head sha the build pass captured: an external push anywhere in the build→commit window makes
 * the ref update non-fast-forward, and the pipeline rebuilds against the new head and retries
 * the commit exactly once before failing with a clear message. Nothing unbuilt ever lands.
 *
 * The pipeline itself finishes when every member's deploy is QUEUED (the worker is
 * concurrency-1, so it cannot wait on jobs behind itself). Each queued deploy substep records
 * its deploymentId; the publish state route re-reads those rows and presents the deploy step as
 * still running/failed until every agent is actually live — the record says what the pipeline
 * did, the presentation says what is true now.
 *
 * Error policy (carried over from the queued-publish runner it replaces): every step failure is
 * the TASK's outcome — fail the task, do not rethrow, let the job complete (`maxAttempts: 1`).
 * Only failures loading the project/task themselves rethrow as genuine queue errors.
 *
 * GitHub/docker/runtime dependencies are injectable so unit tests run with zero I/O.
 */
import { discardConversationCheckoutsForProject } from "~/assistant/checkout-sync.server";
import type { DataStore, PipelineStep, Project, WorkspaceTask } from "~/data/ports";
import { ensureReleasesForCommit, queueDeploy } from "~/deploy/controller.server";
import { listTeamEnvNames } from "~/deploy/environments.server";
import {
  promoteProvisionalImage,
  removeProvisionalImages,
} from "~/deploy/eve-image.server";
import {
  findOrphanedDrafts,
  inferBuildRoots,
  normalizeOpenRouterPackageDrafts,
  orphanedDraftsMessage,
  type CheckBuildFn,
  type ListRepoPathsFn,
  type PublishFile,
} from "~/drafts/drafts.server";
import { detectAgentRoots, hasTeamLayout } from "~/eve/parse";
import { syncProjectAgents } from "~/db/queries.server";
import { getAgentSource, invalidateRepoSource, warmAgentSource } from "~/github/cached.server";
import { fetchAgentSource, readAgentFile } from "~/github/repo.server";
import { LOCK_PATH, overlayLock } from "~/marketplace/lock";
import {
  platformFileProblems,
  platformFilesMessage,
  platformPathsUnderCheck,
  recordedPlatformHashes,
} from "~/marketplace/platform";
import {
  commitToDefaultBranch,
  getBranchHead,
  NonFastForwardError,
} from "~/github/write.server";
import { enqueue } from "~/jobs/queue.server";
import { isAssistantConfigPath } from "~/project/guard.server";
import { initialPublishSteps } from "~/publish/publish-panel";
import { getRuntime } from "~/seams/index.server";
import {
  completeTask,
  createTask,
  failTask,
  findRunningTask,
  setTaskJob,
  updateTaskSteps,
} from "~/tasks/tasks.server";

export interface PublishPayload {
  projectId: string;
  taskId: string;
  createdBy?: string | null;
  /** The user's one-time environment answer (§2.8 rule 3) — absent unless the panel had to ask. */
  envName?: string | null;
  [key: string]: unknown;
}

/** Injected GitHub/docker/runtime seams (production defaults below); keeps unit tests off I/O. */
export interface PublishPipelineDeps {
  checkBuild: CheckBuildFn;
  listRepoPaths: ListRepoPathsFn;
  normalizeDrafts: typeof normalizeOpenRouterPackageDrafts;
  getBranchHead: typeof getBranchHead;
  commitToDefaultBranch: typeof commitToDefaultBranch;
  fetchAgentSource: typeof fetchAgentSource;
  /** One file's bytes off the branch — the platform-file gate's only read (issue #254). */
  readRepoFile: typeof readAgentFile;
  detectAgentRoots: typeof detectAgentRoots;
  syncProjectAgents: typeof syncProjectAgents;
  invalidateRepoSource: typeof invalidateRepoSource;
  warmAgentSource: typeof warmAgentSource;
  ensureReleasesForCommit: typeof ensureReleasesForCommit;
  queueDeploy: typeof queueDeploy;
  listTeamEnvNames: (projectId: string, store: DataStore) => Promise<string[]>;
  promoteImage: typeof promoteProvisionalImage;
  removeProvisionalImages: typeof removeProvisionalImages;
  discardConversationCheckouts: typeof discardConversationCheckoutsForProject;
  enqueueJob: typeof enqueue;
}

function defaultDeps(): PublishPipelineDeps {
  return {
    checkBuild: async (req) => {
      const target = getRuntime().deployTarget;
      return target.checkBuild ? target.checkBuild(req) : { ok: true, skipped: true };
    },
    // On any failure, fall back to an empty tree so the orphan check degrades to roster +
    // drafts rather than blocking a publish on a GitHub hiccup.
    listRepoPaths: async ({ installationId, owner, repo }) => {
      try {
        const source = await getAgentSource(installationId, { owner, repo });
        return source.paths;
      } catch {
        return [];
      }
    },
    normalizeDrafts: normalizeOpenRouterPackageDrafts,
    getBranchHead,
    commitToDefaultBranch,
    fetchAgentSource,
    readRepoFile: readAgentFile,
    detectAgentRoots,
    syncProjectAgents,
    invalidateRepoSource,
    warmAgentSource,
    ensureReleasesForCommit,
    queueDeploy,
    listTeamEnvNames: (projectId, store) => listTeamEnvNames(projectId, { store }),
    promoteImage: promoteProvisionalImage,
    removeProvisionalImages,
    discardConversationCheckouts: discardConversationCheckoutsForProject,
    enqueueJob: enqueue,
  };
}

// The step shape lives in the pure panel module (one source of truth: the panel renders the
// same five steps as a pending stepper before the first poll returns). Re-exported so pipeline
// callers/tests keep importing it from here.
export { initialPublishSteps };

const ASSISTANT_ONLY_REASON = "This change only affects the assistant's configuration";

const CAS_FAILED_MESSAGE =
  "Someone else changed this repository while we were publishing. Try publishing again.";

/** The outcome of a publish whose process died mid-run (boot reconciliation / rerun guard). */
export const PUBLISH_INTERRUPTED_MESSAGE =
  "harnesst restarted while this publish was running. Nothing you saved was lost — publish again.";

/**
 * The `workspace_tasks_running_subject_uq` partial unique violation: another request created the
 * running publish task between our dedupe read and our insert. Walks `cause` like
 * isVersionLabelCollision so wrapped driver errors still match.
 */
function isRunningPublishCollision(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const pg = e as Error & { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === "workspace_tasks_running_subject_uq") {
      return true;
    }
  }
  return false;
}

/**
 * Trigger a publish (§2.9: one per project at a time): dedupe on the running `publish` task,
 * create the task with the full step shape visible from the start, enqueue the `publish` job
 * (`maxAttempts: 1` — a failed pipeline is the task's outcome, never an auto-retry), and link
 * the job onto the task. Returns the existing running task when one is already in flight —
 * the find is racy on its own, so the running-subject partial unique index is the real gate
 * and an insert collision resolves to "already running" too.
 */
export async function startPublish(
  input: {
    projectId: string;
    originUrl: string;
    createdBy?: string | null;
    /** The user's environment answer, when the panel had to ask (§2.8 rule 3). */
    envName?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<{ taskId: string; alreadyRunning: boolean }> {
  const running = await findRunningTask(input.projectId, "publish", store);
  if (running) return { taskId: running.id, alreadyRunning: true };

  const drafts = await store.drafts.listByProject(input.projectId);
  if (drafts.length === 0) throw new Error("Nothing to publish — no saved changes.");

  let task: WorkspaceTask;
  try {
    task = await createTask(
      {
        projectId: input.projectId,
        kind: "publish",
        subjectKey: "publish",
        label: `Publishing ${drafts.length} change${drafts.length === 1 ? "" : "s"}`,
        originUrl: input.originUrl,
        steps: initialPublishSteps(),
        createdBy: input.createdBy,
      },
      store,
    );
  } catch (error) {
    if (isRunningPublishCollision(error)) {
      const winner = await findRunningTask(input.projectId, "publish", store);
      if (winner) return { taskId: winner.id, alreadyRunning: true };
    }
    throw error;
  }
  const jobId = await enqueue(
    "publish",
    {
      projectId: input.projectId,
      taskId: task.id,
      createdBy: input.createdBy ?? null,
      envName: input.envName ?? null,
    } satisfies PublishPayload,
    { maxAttempts: 1 },
    store,
  );
  await setTaskJob(task.id, jobId, store);
  return { taskId: task.id, alreadyRunning: false };
}

/**
 * What one pipeline run did — the workspace task's steps are the user-facing record; this is
 * the programmatic summary for callers that await the run (the MCP publish tool audits the
 * commit sha, release ids, and deployment ids from it).
 */
export interface PublishOutcome {
  taskId: string;
  status: "succeeded" | "failed";
  /** Which step failed, when failed. */
  failedStep?: PipelineStep["key"];
  /** The failed step's error, when failed. */
  error?: string;
  /** The published commit — set once the commit step lands, even if a later step fails. */
  commitSha: string | null;
  releaseIds: string[];
  deploymentIds: string[];
}

/**
 * Run a publish synchronously (the MCP `publish_changes` path): same dedupe and task record as
 * startPublish, but the pipeline runs in-request and the caller gets the full outcome. Throws
 * for a publish already in flight or nothing saved; pipeline failures come back as a `failed`
 * outcome, exactly as the UI sees them.
 */
export async function publishNow(
  input: {
    projectId: string;
    originUrl: string;
    createdBy?: string | null;
    envName?: string | null;
  },
  deps: PublishPipelineDeps = defaultDeps(),
  store: DataStore = getRuntime().data,
): Promise<PublishOutcome> {
  const running = await findRunningTask(input.projectId, "publish", store);
  if (running) {
    throw new Error("A publish is already running for this project.");
  }
  const drafts = await store.drafts.listByProject(input.projectId);
  if (drafts.length === 0) throw new Error("Nothing to publish — no saved changes.");

  let task: WorkspaceTask;
  try {
    task = await createTask(
      {
        projectId: input.projectId,
        kind: "publish",
        subjectKey: "publish",
        label: `Publishing ${drafts.length} change${drafts.length === 1 ? "" : "s"}`,
        originUrl: input.originUrl,
        steps: initialPublishSteps(),
        createdBy: input.createdBy,
      },
      store,
    );
  } catch (error) {
    if (isRunningPublishCollision(error)) {
      throw new Error("A publish is already running for this project.");
    }
    throw error;
  }
  return runPublish(
    {
      projectId: input.projectId,
      taskId: task.id,
      createdBy: input.createdBy ?? null,
      envName: input.envName ?? null,
    },
    deps,
    store,
  );
}

/** A project narrowed to the connected-repo fields the pipeline needs. */
type ConnectedProject = Project & {
  repoInstallationId: string;
  repoOwner: string;
  repoName: string;
};

/** Thrown by env resolution when §2.8 needs an answer the payload didn't carry. */
class EnvironmentChoiceError extends Error {}

/**
 * §2.8 — never ask which environment more than once. Resolution order: the persisted
 * `liveEnvironmentName` (when it still names a real env — a Deployment-tab rename can strand
 * it, in which case we fall through and re-resolve); else the payload's one-time answer; else
 * the project's only env name. Anything resolved here is persisted so it is never asked again.
 */
async function resolveLiveEnvironment(
  project: ConnectedProject,
  requested: string | null,
  deps: PublishPipelineDeps,
  store: DataStore,
): Promise<string> {
  const names = await deps.listTeamEnvNames(project.id, store);
  if (project.liveEnvironmentName && names.includes(project.liveEnvironmentName)) {
    return project.liveEnvironmentName;
  }
  const persist = async (name: string): Promise<string> => {
    await store.projects.setLiveEnvironmentName(project.id, name);
    return name;
  };
  if (requested) {
    if (!names.includes(requested)) {
      throw new Error(`This project has no environment named "${requested}".`);
    }
    return persist(requested);
  }
  if (names.length === 1) return persist(names[0]);
  if (names.length === 0) {
    throw new Error("This project has no environments to deploy into.");
  }
  throw new EnvironmentChoiceError(
    "This project has more than one environment — choose which one Publish deploys to.",
  );
}

/** The commit message, matching the old change-set titles (§2.6: history quality unchanged). */
function commitMessage(files: PublishFile[]): string {
  if (files.length === 1) {
    return `${files[0].content === null ? "Remove" : "Update"} ${files[0].path}`;
  }
  return `Update ${files.length} agent files`;
}

export async function runPublish(
  payload: PublishPayload,
  deps: PublishPipelineDeps = defaultDeps(),
  store: DataStore = getRuntime().data,
): Promise<PublishOutcome> {
  const { taskId, createdBy } = payload;

  // Infrastructure reads — a failure here is a real queue error (rethrow).
  const project = await store.projects.findById(payload.projectId);
  if (!project || !project.repoInstallationId || !project.repoOwner || !project.repoName) {
    throw new Error(`publish: project ${payload.projectId} has no connected repo`);
  }
  const connected = project as ConnectedProject;
  const task = await store.workspaceTasks.findById(taskId);
  if (!task) throw new Error(`publish: task ${taskId} not found`);

  const repo = { owner: connected.repoOwner, repo: connected.repoName };
  const installationId = connected.repoInstallationId;
  const drafts = await store.drafts.listByProject(connected.id);
  const agents = await store.agents.listByProject(connected.id);

  // The programmatic summary returned to callers that await the run. Mutated in place as the
  // pipeline progresses so every early return carries whatever had already happened.
  const outcome: PublishOutcome = {
    taskId,
    status: "failed",
    commitSha: null,
    releaseIds: [],
    deploymentIds: [],
  };

  // Rerun guard: a publish task runs exactly ONCE. If this task already carries progress (or
  // resolved), a restart re-delivered its job — rerunning would clobber the real history, and a
  // crash after the commit would re-read zero drafts and misreport a landed publish as "nothing
  // to publish" (or land a duplicate commit). Fail it cleanly instead; boot reconciliation
  // (worker.server.ts) normally settles these before the queue ever re-delivers.
  if (task.status !== "running" || (task.steps ?? []).some((s) => s.status !== "pending")) {
    if (task.status === "running") {
      await failTask(taskId, PUBLISH_INTERRUPTED_MESSAGE, store);
    }
    outcome.error = PUBLISH_INTERRUPTED_MESSAGE;
    return outcome;
  }

  // ── Step bookkeeping: ONE array, updated in place and re-persisted after every transition. ──
  const steps = initialPublishSteps();
  const step = (key: PipelineStep["key"]): PipelineStep =>
    steps.find((s) => s.key === key)!;
  const save = () => updateTaskSteps(taskId, steps, store);
  const succeed = async (key: PipelineStep["key"]) => {
    const s = step(key);
    s.status = "succeeded";
    delete s.detail;
    await save();
  };
  /** A step failure is the task's outcome: mark the step, fail the task, never rethrow. */
  const failAt = async (key: PipelineStep["key"], error: string) => {
    const s = step(key);
    s.status = "failed";
    s.error = error;
    delete s.detail;
    await save();
    await failTask(taskId, error, store);
    outcome.status = "failed";
    outcome.failedStep = key;
    outcome.error = error;
  };

  if (drafts.length === 0) {
    await failAt("check", "Nothing to publish — no saved changes.");
    return outcome;
  }

  // Assistant-config-only change-sets (§3.3): nothing to compile, version, or deploy — the
  // commit lands the config and an assistant restart picks it up. The skipped steps stay
  // visible with their reason (an absent step reads as a bug).
  const assistantConfigOnly = drafts.every((d) => isAssistantConfigPath(d.path));
  // The lock counts for the RESTART trigger (issue #274: installs change the assistant's
  // installed skills) but never for assistant-config-ONLY — a lock change rides an install's
  // real file writes, which still need build/version/deploy.
  const touchesAssistantConfig = drafts.some(
    (d) => isAssistantConfigPath(d.path) || d.path === LOCK_PATH,
  );
  if (assistantConfigOnly) {
    for (const key of ["build", "version", "deploy"] as const) {
      step(key).status = "skipped";
      step(key).reason = ASSISTANT_ONLY_REASON;
    }
  }
  await save();

  // Provisional tags from the LAST build pass, keyed by root — what promotion reads. Every tag
  // ever created lands in cleanupTags for the finally (a CAS retry rebuilds, superseding the
  // first pass's tags; promotion must never see those).
  let provisional = new Map<string | undefined, string>();
  const cleanupTags: string[] = [];

  // The head the current build pass was based on — the commit's CAS anchor (§3.1). Captured at
  // the START of each build pass and passed to commitToDefaultBranch as the expected head, so an
  // external push ANYWHERE in the minutes-long build→commit window is a NonFastForwardError,
  // never a silently-unbuilt tree landing on the default branch.
  let baseHeadSha: string | null = null;

  /**
   * The build step (§3.2): one sequential build per member root the change-set touches (one
   * docker tag namespace per task, but the underlying builder still races on shared caches —
   * and the worker is concurrency-1 anyway). Pins the built tree to the head sha it captures,
   * which the commit then CASes on. Rerunnable: a CAS retry calls it again, capturing the moved
   * head. Returns false after failing the task.
   */
  const runBuildStep = async (files: PublishFile[]): Promise<boolean> => {
    const buildStep = step("build");
    const roots = inferBuildRoots(agents, drafts);
    const buildRoots = !roots || roots.length === 0 ? [undefined] : roots;
    const labelFor = (root: string | undefined): string =>
      agents.find((a) => a.root === root)?.name ??
      root?.match(/^agents\/([^/]+)\//)?.[1] ??
      "the repository";
    buildStep.status = "running";
    const subs = buildRoots.map((root) => ({
      label: labelFor(root),
      status: "pending" as const,
    })) as NonNullable<PipelineStep["substeps"]>;
    buildStep.substeps = subs;
    provisional = new Map();
    await save();
    const headSha = await deps.getBranchHead(installationId, repo, connected.defaultBranch);
    baseHeadSha = headSha;

    for (const [i, agentRoot] of buildRoots.entries()) {
      const sub = subs[i];
      sub.status = "running";
      buildStep.detail =
        buildRoots.length > 1 ? `${sub.label} (${i + 1} of ${buildRoots.length})` : sub.label;
      await save();
      const result = await deps.checkBuild({
        projectId: connected.id,
        repo,
        // Pinned to the captured head, not the branch name: the built tree must be exactly
        // what the CAS commit lands on.
        ref: headSha,
        installationId,
        overlay: files,
        agentRoot,
        taskId,
        // Promoted images must match what a deploy-time build would produce: team members
        // (root under agents/) get the generated ask-teammate tool baked in (D2).
        injectTeammateTool: !!agentRoot && agentRoot !== "agent",
      });
      if (!result.ok) {
        sub.status = "failed";
        sub.error = result.output;
        const scope = buildRoots.length > 1 && agentRoot ? ` (\`${agentRoot}\`)` : "";
        await failAt(
          "build",
          `The build failed${scope} — nothing was published, and your changes are still saved. Fix this and publish again:\n\n${result.output}`,
        );
        return false;
      }
      sub.status = "succeeded";
      if (result.provisionalTag) {
        provisional.set(agentRoot, result.provisionalTag);
        cleanupTags.push(result.provisionalTag);
      }
      await save();
    }
    buildStep.status = "succeeded";
    delete buildStep.detail;
    await save();
    return true;
  };

  try {
    // ── check ─────────────────────────────────────────────────────────────────────────────
    step("check").status = "running";
    await save();
    let files: PublishFile[];
    let envName: string | null = null;
    try {
      const repoPaths = await deps.listRepoPaths({
        installationId,
        owner: connected.repoOwner,
        repo: connected.repoName,
      });
      // Orphan gate (issue #67): a draft stranded under a member root nothing backs would
      // reach the build as a package.json with no agent code and fail opaquely.
      const orphaned = findOrphanedDrafts(agents, repoPaths, drafts);
      if (orphaned.length > 0) {
        await failAt("check", orphanedDraftsMessage(orphaned));
        return outcome;
      }
      // Platform-file gate (issue #254): `harnesst/` code is the marketplace installer's to write,
      // and publish is the last place that can prove it still is. Every platform file the published
      // tree will carry has to hash to the sha256 its install recorded, and a platform file no
      // install owns fails just as hard — a hand-"fixed" one works right up until the next update
      // overwrites it, which is the failure this whole issue exists to make impossible.
      //
      // Runs BEFORE the coherence pass on purpose: the pass is harnesst's own code repairing the
      // change-set (it relocates the generated model module, a platform path nothing owns), and the
      // gate is about what humans and installs did, not what we do to their change-set.
      //
      // Costs nothing on a repo with no platform files — no lock read, no file reads — which is
      // every repo until it takes a `harnesst/`-shipping template.
      //
      // The gate only sees what `fetchAgentSource` reads, so that filter admits both platform
      // roots — repo-root `harnesst/**` and `agents/<m>/harnesst/**`. Narrow it and a
      // single-agent repo's platform files go back to being checked only while they are drafts.
      const platformPaths = platformPathsUnderCheck(repoPaths, drafts);
      if (platformPaths.length > 0) {
        // The lock the published tree will have: the staged one when this change-set rewrites it
        // (an install stages its platform files and its lock entry together, so the recorded
        // hashes must come from the same change-set), else the branch's.
        const stagedLock = drafts.some((d) => d.path === LOCK_PATH);
        const recorded = recordedPlatformHashes(
          overlayLock(
            stagedLock ? null : await deps.readRepoFile(installationId, repo, LOCK_PATH),
            drafts,
          ),
        );
        // Drafts win over the branch — the change-set is what is about to land. Deletions never
        // reach here (platformPathsUnderCheck drops them).
        const resolved = await Promise.all(
          platformPaths.map(async (path) => {
            const draft = drafts.find((d) => d.path === path);
            return [
              path,
              draft ? draft.content : await deps.readRepoFile(installationId, repo, path),
            ] as const;
          }),
        );
        const problems = platformFileProblems(platformPaths, recorded, new Map(resolved));
        if (problems.length > 0) {
          await failAt("check", platformFilesMessage(problems));
          return outcome;
        }
      }
      // Coherence pass (§2.4): harnesst never publishes an incoherent change-set.
      files = await deps.normalizeDrafts({
        project: connected,
        files: drafts.map((d) => ({ path: d.path, content: d.content })),
      });
      // Resolve the live environment up front (§2.8) so an unanswerable ambiguity fails in
      // seconds, not after minutes of building. Config-only publishes deploy nothing.
      if (!assistantConfigOnly) {
        envName = await resolveLiveEnvironment(
          connected,
          payload.envName ?? null,
          deps,
          store,
        );
      }
    } catch (error) {
      await failAt("check", error instanceof Error ? error.message : String(error));
      return outcome;
    }
    await succeed("check");

    // ── build ─────────────────────────────────────────────────────────────────────────────
    if (!assistantConfigOnly && !(await runBuildStep(files))) return outcome;

    // ── commit ────────────────────────────────────────────────────────────────────────────
    step("commit").status = "running";
    await save();
    const message = commitMessage(files);
    let sha: string;
    try {
      // Config-only publishes never ran a build — capture the CAS anchor now.
      if (baseHeadSha === null) {
        baseHeadSha = await deps.getBranchHead(installationId, repo, connected.defaultBranch);
      }
      const commit = () =>
        deps.commitToDefaultBranch(installationId, repo, {
          branch: connected.defaultBranch,
          // Read at call time: the CAS retry below refreshes it before recommitting.
          expectedHeadSha: baseHeadSha!,
          files,
          message,
        });
      try {
        sha = (await commit()).sha;
      } catch (error) {
        if (!(error instanceof NonFastForwardError)) throw error;
        // CAS miss (§3.1): the head moved since the build's anchor. Set the commit step back to
        // pending — only one step is ever active (§4.3), and a failed rebuild must not strand a
        // spinning commit in a failed task — then rebuild against the new head and retry the
        // commit exactly once.
        const commitStep = step("commit");
        commitStep.status = "pending";
        commitStep.detail = "The repository changed — rebuilding and retrying";
        await save();
        if (assistantConfigOnly) {
          baseHeadSha = await deps.getBranchHead(installationId, repo, connected.defaultBranch);
        } else if (!(await runBuildStep(files))) {
          delete commitStep.detail;
          await save();
          return outcome;
        }
        commitStep.status = "running";
        delete commitStep.detail;
        await save();
        try {
          sha = (await commit()).sha;
        } catch (retryError) {
          if (retryError instanceof NonFastForwardError) {
            await failAt("commit", CAS_FAILED_MESSAGE);
            return outcome;
          }
          throw retryError;
        }
      }
    } catch (error) {
      await failAt("commit", error instanceof Error ? error.message : String(error));
      return outcome;
    }
    outcome.commitSha = sha;

    // Only after the commit succeeds: the published drafts now live on the default branch.
    // Guarded per row by the updatedAt captured at pipeline start — a save that landed on the
    // same path DURING the build/commit window was not published and must stay saved.
    await store.drafts.deletePublished(
      connected.id,
      drafts.map((d) => ({ path: d.path, updatedAt: d.updatedAt })),
    );
    // Any conversation whose staged drafts were included has just been published — drop the
    // project's checkout link rows so the next assistant turn re-syncs against the new head.
    // Assistant-staged drafts are the authorless ones (§2.7: human saves always carry a user
    // id); a publish containing none touched no conversation's work, and discarding then would
    // re-stage work the user had deliberately discarded.
    if (drafts.some((d) => d.createdBy === null)) {
      try {
        await deps.discardConversationCheckouts(connected.id);
      } catch (error) {
        console.warn("[publish] committed but couldn't discard conversation checkouts:", error);
      }
    }
    await succeed("commit");

    // A published set touching the assistant's config restarts its instance so the entrypoint
    // re-fetches the bundle (direct commits fire no webhook — this is the only trigger).
    if (touchesAssistantConfig) {
      await deps.enqueueJob("assistant_restart", { projectId: connected.id }, undefined, store);
    }

    if (assistantConfigOnly) {
      await completeTask(taskId, { resultUrl: task.originUrl }, store);
      outcome.status = "succeeded";
      return outcome;
    }

    // ── version ───────────────────────────────────────────────────────────────────────────
    step("version").status = "running";
    await save();
    let releases: Awaited<ReturnType<typeof ensureReleasesForCommit>>;
    let roster: (typeof agents)[number][];
    try {
      // Roster sync is best-effort (warn-only): a landed commit must still cut releases even
      // if the tree read hiccups.
      try {
        const source = await deps.fetchAgentSource(installationId, { ...repo, ref: sha });
        const detected = deps.detectAgentRoots(source.paths);
        await deps.syncProjectAgents(connected.id, detected, undefined, undefined, {
          allowEmpty:
            connected.layout === "team" &&
            hasTeamLayout(source.paths) &&
            detected.length === 0,
        });
        deps.invalidateRepoSource(installationId, repo);
        // Restore the branch NAME in the warmed cache ref, never the sha.
        deps.warmAgentSource(installationId, repo, {
          ...source,
          ref: connected.defaultBranch,
        });
      } catch (error) {
        console.warn("[publish] committed but couldn't sync roster:", error);
      }
      releases = await deps.ensureReleasesForCommit(
        { projectId: connected.id, gitSha: sha, changelog: message, createdBy },
        store,
      );

      // Promote the publish build's images (§3.2) so the deploys below skip their own build.
      // Warn-only: a failed promotion just means that member rebuilds at deploy time.
      roster = (await store.agents.listByProject(connected.id)).filter(
        (a) => a.kind === "member",
      );
      for (const [root, tag] of provisional) {
        const member = roster.find((a) => a.root === (root ?? "agent"));
        const release =
          member && releases.find((r) => r.release.agentId === member.id)?.release;
        if (!release) continue;
        try {
          const built = await deps.promoteImage({
            provisionalTag: tag,
            projectId: connected.id,
            gitSha: sha,
            agentRoot: member.root,
          });
          await store.releases.setImageRef(release.id, built.imageRef);
        } catch (error) {
          console.warn(`[publish] couldn't promote the build image for ${member.name}:`, error);
        }
      }
    } catch (error) {
      await failAt("version", error instanceof Error ? error.message : String(error));
      return outcome;
    }
    outcome.releaseIds = releases.map((r) => r.release.id);
    // Succeed with the team version label as the step's detail — the success panel's
    // "Live · vN" headline reads it off the steps (one source of truth). Labels can differ
    // per member; use the first, as the version history does.
    const versionStep = step("version");
    versionStep.status = "succeeded";
    versionStep.detail = releases[0]?.release.version;
    await save();

    // ── deploy ────────────────────────────────────────────────────────────────────────────
    // Queue one deploy per roster member into the live env (the team is the deployment unit).
    // rebuild: false — promoted Releases reuse their image; the rest build in the deploy job.
    // Queuing is this step's own work (§3.3); whether each agent actually comes up is its
    // deployment row's story, so every queued substep records its deploymentId and the publish
    // state route re-reads those rows until each agent is live or failed (§3.2: report
    // deploy-time work honestly, never pretend the team was already up).
    const deployStep = step("deploy");
    deployStep.status = "running";
    const deploySubs = roster.map((a) => ({
      label: a.name,
      status: "pending" as const,
    })) as NonNullable<PipelineStep["substeps"]>;
    deployStep.substeps = deploySubs;
    await save();
    let queued = 0;
    for (const [i, agent] of roster.entries()) {
      const sub = deploySubs[i];
      sub.status = "running";
      await save();
      const release = releases.find((r) => r.release.agentId === agent.id)?.release;
      const envs = await store.environments.listByAgent(agent.id);
      const env = envs.find((e) => e.name === envName);
      if (!release || !env) {
        sub.status = "failed";
        sub.error = !release
          ? `No version was created for ${agent.name}.`
          : `${agent.name} has no "${envName}" environment.`;
        await save();
        continue;
      }
      try {
        const dep = await deps.queueDeploy(
          { environmentId: env.id, releaseId: release.id, rebuild: false, createdBy },
          store,
        );
        outcome.deploymentIds.push(dep.id);
        sub.status = "succeeded";
        sub.deploymentId = dep.id;
        queued++;
      } catch (error) {
        // e.g. the env already has a deploy in flight (deployments_env_inflight_uq).
        sub.status = "failed";
        sub.error = error instanceof Error ? error.message : String(error);
      }
      await save();
    }
    const failedMembers = deploySubs.filter((s) => s.status === "failed");
    if (failedMembers.length > 0) {
      // The per-member errors always win over any aggregate guess — a "no environment"
      // message when every member's real failure was just recorded would misdirect the user.
      await failAt(
        "deploy",
        `Couldn't start ${failedMembers.map((s) => s.label).join(", ")}:\n\n${failedMembers
          .map((s) => s.error)
          .filter(Boolean)
          .join("\n")}`,
      );
      return outcome;
    }
    if (queued === 0) {
      await failAt("deploy", "This team has no agents to deploy.");
      return outcome;
    }
    deployStep.status = "succeeded";
    await save();
    await completeTask(taskId, { resultUrl: task.originUrl }, store);
    outcome.status = "succeeded";
    return outcome;
  } catch (error) {
    // Unexpected failure outside the per-step handlers: still the task's outcome, never a
    // stranded running task or a queue retry. Anchor the failure to the running step, else the
    // first still-pending one — never rewrite a step that already succeeded (a post-completion
    // hiccup must not repaint a landed pipeline as failed at "check").
    const message = error instanceof Error ? error.message : String(error);
    const anchor =
      steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "pending");
    if (anchor) {
      await failAt(anchor.key, message);
    } else {
      await failTask(taskId, message, store);
      outcome.status = "failed";
      outcome.error = message;
    }
    return outcome;
  } finally {
    // Provisional tags never outlive the publish (§7): promoted images keep their real tags.
    if (cleanupTags.length > 0) {
      await deps.removeProvisionalImages(cleanupTags).catch(() => {});
    }
  }
}
