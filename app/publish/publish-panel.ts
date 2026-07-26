/**
 * Pure logic behind the Publish control + panel (issue #225 §4.1/§4.2) — the persistent header
 * control that is the ONE way changes go live, and the panel that shows everything before it
 * does. No I/O and no server imports: this module is shared by the `repos/:projectId/publish`
 * resource route (which serializes the payloads) and the client components (which render them),
 * and it is unit-tested directly.
 *
 * The five step definitions live here too (single source of truth): the pipeline runner seeds a
 * task's `steps` from them, and the panel renders the same shape as a pending stepper before the
 * first poll returns.
 */
import type { DraftChange, PipelineStep } from "~/data/ports";

/** The five pipeline steps, in order, with their user-facing labels (§4.3). */
export function initialPublishSteps(): PipelineStep[] {
  return [
    { key: "check", label: "Checking your changes", status: "pending" },
    { key: "build", label: "Building your agents", status: "pending" },
    { key: "commit", label: "Saving to your repository", status: "pending" },
    { key: "version", label: "Creating version", status: "pending" },
    { key: "deploy", label: "Starting your agents", status: "pending" },
  ];
}

/** The running step's one-liner ("Building your agents — Ivy (2 of 3)"), or null when idle. */
export function runningStepSummary(steps: PipelineStep[] | null | undefined): string | null {
  const running = steps?.find((s) => s.status === "running");
  if (!running) return null;
  return running.detail ? `${running.label} — ${running.detail}` : running.label;
}

/**
 * The version label a finished publish went live as ("v13") — the pipeline records it as the
 * succeeded `version` step's detail, so the panel's success headline and the steps stay one
 * source of truth. Null when the step didn't run (e.g. an assistant-config-only publish).
 */
export function publishedVersion(steps: PipelineStep[] | null | undefined): string | null {
  const version = steps?.find((s) => s.key === "version");
  return version?.status === "succeeded" ? (version.detail ?? null) : null;
}

/** A deployment row's live status, keyed by id — what the deploy substeps resolve against. */
export interface DeploymentSnapshot {
  status: string;
  errorDetail: string | null;
}

/**
 * Present a task's steps against the LIVE deployment rows (§3.2 honesty). The pipeline's work
 * ends when every member's deploy is queued — each queued deploy substep records its
 * deploymentId — but "Starting your agents" is only true once the rows actually reach `live`.
 * This resolves each recorded substep to its row's current state (pending/building → running,
 * live/replaced → succeeded, failed → failed with the row's error) and re-derives the deploy
 * step from them, so the panel keeps spinning per member until each agent is up and a
 * post-queue deploy failure surfaces in the pipeline UI instead of only on the Deployment tab.
 * A recorded failure is never rewritten; a substep whose row aged out keeps its recorded state.
 */
export function resolveDeployProgress(
  steps: PipelineStep[] | null,
  deployments: Map<string, DeploymentSnapshot>,
): PipelineStep[] | null {
  if (!steps) return steps;
  return steps.map((step) => {
    if (step.key !== "deploy" || !step.substeps || step.substeps.length === 0) return step;
    const substeps = step.substeps.map((sub) => {
      if (!sub.deploymentId) return sub;
      const row = deployments.get(sub.deploymentId);
      if (!row) return sub;
      if (row.status === "failed") {
        return {
          ...sub,
          status: "failed" as const,
          error: row.errorDetail ?? "The deployment failed — see the Deployment tab.",
        };
      }
      if (row.status === "pending" || row.status === "building") {
        return { ...sub, status: "running" as const };
      }
      // live — or already replaced by a later deploy (draining/stopped): it did come up.
      return { ...sub, status: "succeeded" as const };
    });
    // Re-derive the step's presented status from the substeps; a step the pipeline recorded
    // as failed (queue-time failure) keeps its record.
    if (step.status !== "succeeded") return { ...step, substeps };
    const failed = substeps.filter((s) => s.status === "failed");
    if (failed.length > 0) {
      return {
        ...step,
        substeps,
        status: "failed" as const,
        error: `Couldn't start ${failed.map((s) => s.label).join(", ")}:\n\n${failed
          .map((s) => s.error)
          .filter(Boolean)
          .join("\n")}`,
      };
    }
    if (substeps.some((s) => s.status === "running")) {
      return { ...step, substeps, status: "running" as const };
    }
    return { ...step, substeps };
  });
}

/** Every deployment id the steps' deploy substeps recorded (what the route reads back). */
export function deploymentIdsOf(steps: PipelineStep[] | null | undefined): string[] {
  const deploy = steps?.find((s) => s.key === "deploy");
  return (deploy?.substeps ?? [])
    .map((s) => s.deploymentId)
    .filter((id): id is string => id != null);
}

/** True when no presented step is still running — the publish's work has fully landed. */
export function stepsSettled(steps: PipelineStep[] | null | undefined): boolean {
  return !steps || steps.every((s) => s.status !== "running");
}

/** The presented failed step, if any (a queue-time failure or a post-queue deploy failure). */
export function stepsFailure(steps: PipelineStep[] | null | undefined): PipelineStep | null {
  return steps?.find((s) => s.status === "failed") ?? null;
}

/** What a saved change does to its file — the panel's per-file action badge (§4.2). */
export type ChangeAction = "edited" | "new" | "deleted";

/**
 * Derive the action badge for one saved change. `existsInRepo` is null when the repo tree
 * couldn't be read — degrade to "edited" (the common case) rather than mislabel as "new".
 */
export function changeAction(
  content: string | null,
  existsInRepo: boolean | null,
): ChangeAction {
  if (content === null) return "deleted";
  if (existsInRepo === false) return "new";
  return "edited";
}

/** One block in the panel's breakdown: a member's saved changes, or the shared set. */
export interface DraftGroup {
  /** Owning member's name, or null for shared changes (agentId null — e.g. root package.json). */
  member: string | null;
  files: string[];
}

/**
 * Group saved changes for the panel: one block per member that owns changes (in roster order),
 * then a trailing shared block (agentId null) when any unattributed changes exist. Members with
 * no changes are omitted; file order is preserved within each group. Changes are attributed to
 * roster members by agentId, so the breakdown names match the roster the user sees.
 *
 * Fail safe: a change whose agentId matches nothing in the roster falls into the shared block
 * rather than being dropped. The panel's list is what the Publish button ships (§2.3 publishes
 * everything), so a file the roster can't name must still be shown — silently omitting it would
 * let the header's count and the panel's list disagree and publish a file nobody reviewed.
 */
export function groupDrafts(
  drafts: DraftChange[],
  roster: { id: string; name: string }[],
): DraftGroup[] {
  const byId = new Map<string, string[]>();
  const shared: string[] = [];
  for (const d of drafts) {
    if (d.agentId === null) {
      shared.push(d.path);
      continue;
    }
    const files = byId.get(d.agentId) ?? [];
    files.push(d.path);
    byId.set(d.agentId, files);
  }
  const groups: DraftGroup[] = [];
  for (const member of roster) {
    const files = byId.get(member.id);
    if (files && files.length > 0) groups.push({ member: member.name, files });
    byId.delete(member.id);
  }
  // Anything still in byId belongs to no known roster entry — keep it visible.
  const orphaned = [...byId.values()].flat();
  const unnamed = [...shared, ...orphaned];
  if (unnamed.length > 0) groups.push({ member: null, files: unnamed });
  return groups;
}

/** One saved change, serialized for the panel (the GET payload's file row). */
export interface PublishChangeRow {
  path: string;
  action: ChangeAction;
  /** Display name of the teammate who saved it; null = the assistant saved it (§2.7). */
  savedBy: string | null;
  /** ISO timestamp of the save. */
  savedAt: string;
}

/** One panel block: a member's rows, or the shared (member null) rows. */
export interface PublishGroup {
  member: string | null;
  files: PublishChangeRow[];
}

/** The `repos/:projectId/publish` GET payload the control polls and the panel renders. */
export interface PublishStatePayload {
  /** False when the project has no connected repo — the control renders nothing. */
  connected: boolean;
  changeCount: number;
  groups: PublishGroup[];
  /** The team has ever deployed (any deployment row). False → the Publish-HEAD state. */
  deployed: boolean;
  /**
   * A team deployment is pending/building right now. Deploys started outside a publish task — a
   * HEAD publish, a rollback — have no pipeline to watch, so this is what keeps the control from
   * reporting "Live" while the agents are still coming up.
   */
  deploying: boolean;
  /** Version label currently live (newest live TEAM deployment), when one is running. */
  liveVersion: string | null;
  /** The team's environment names — only rendered when the panel must ask (§2.8). */
  envNames: string[];
  /** True when §2.8 resolution can't decide alone: several envs and no persisted answer. */
  needsEnvironmentChoice: boolean;
  /** The in-flight publish task, when one is running (§2.9: one per project at a time). */
  running: { taskId: string; steps: PipelineStep[] | null } | null;
  /** The most recent failed, undismissed publish task, if any. */
  failed: { taskId: string; steps: PipelineStep[] | null; error: string | null } | null;
  /**
   * The most recent succeeded, undismissed publish task. The panel's success state (§4.3
   * "Live · vN", auto-dismiss) reads it when the publish it was watching completes; the
   * header control ignores it (a finished publish quietly becomes the Live text).
   */
  succeeded: { taskId: string; steps: PipelineStep[] | null } | null;
}

/** The `?diff=<path>` GET payload: one saved change's diff for the expandable row. */
export interface PublishDiffPayload {
  path: string;
  action: ChangeAction;
  /** Unified-diff hunks for DiffView, or null when there is nothing renderable. */
  patch: string | null;
}

/**
 * Which of the §4.1 states the header control renders. Running and failed outrank everything
 * (a publish in flight/aground is THE thing to surface); saved changes outrank the quiet
 * live/not-deployed texts.
 */
export type PublishControlState =
  | { kind: "running"; summary: string | null }
  | { kind: "failed" }
  | { kind: "ready"; count: number }
  | { kind: "deploying" }
  | { kind: "live"; version: string | null }
  | { kind: "never-deployed" };

export function publishControlState(
  data: Pick<
    PublishStatePayload,
    "changeCount" | "deployed" | "deploying" | "liveVersion" | "running" | "failed"
  >,
): PublishControlState {
  if (data.running) {
    return { kind: "running", summary: runningStepSummary(data.running.steps) };
  }
  if (data.failed) return { kind: "failed" };
  if (data.changeCount > 0) return { kind: "ready", count: data.changeCount };
  // Agents still coming up with no publish task to watch (a HEAD publish, a rollback): say so
  // rather than claiming "Live" for a version that isn't serving yet.
  if (data.deploying) return { kind: "deploying" };
  if (data.deployed) return { kind: "live", version: data.liveVersion };
  return { kind: "never-deployed" };
}

/**
 * Why the panel's primary Publish action is disabled right now, or null when it may run.
 * Rendered as the explanatory line under the button (§4.2).
 */
export function publishDisabledReason(data: {
  running: PublishStatePayload["running"];
  changeCount: number;
  needsEnvironmentChoice: boolean;
  envAnswer: string;
}): string | null {
  if (data.running) return "A publish is already running for this repository.";
  if (data.changeCount === 0) return "Nothing to publish — everything you've saved is live.";
  if (data.needsEnvironmentChoice && !data.envAnswer) {
    return "Choose which environment your agents run in.";
  }
  return null;
}
