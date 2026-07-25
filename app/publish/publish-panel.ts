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
  }
  if (shared.length > 0) groups.push({ member: null, files: shared });
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
  /** The project has ever deployed (any deployment row). False → the Publish-HEAD state. */
  deployed: boolean;
  /** Version label currently live (newest live deployment), when one is running. */
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
  | { kind: "live"; version: string | null }
  | { kind: "never-deployed" };

export function publishControlState(
  data: Pick<
    PublishStatePayload,
    "changeCount" | "deployed" | "liveVersion" | "running" | "failed"
  >,
): PublishControlState {
  if (data.running) {
    return { kind: "running", summary: runningStepSummary(data.running.steps) };
  }
  if (data.failed) return { kind: "failed" };
  if (data.changeCount > 0) return { kind: "ready", count: data.changeCount };
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
