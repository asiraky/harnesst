/**
 * The authoritative pre-merge build gate for assistant conversation branches (issue #137).
 *
 * A conversation branch merges its tree exactly as-is, so the gate compiles every eve project
 * the change touches — mirroring the PUBLISH gate's per-root loop in `app/drafts/drafts.server.ts`
 * (`inferBuildRoots` + the sequential `publishDrafts` build loop). The two must not drift: both
 * collect the member roots a change spans and build each one, scoping a failure to the member.
 *
 * The bug this fixes: the old gate inferred ONE root client-side and, on any multi-member or
 * root-touching change, fell back to building the repo root — which on a team-layout repo is a
 * workspaces shell (no eve project), so a change that built fine per-member failed the gate with
 * an opaque "Could not resolve an eve agent root" error. The roots are now recomputed SERVER-side
 * from the PR's changed files, and a team repo's shared/root files map to no build at all.
 */
import type { BuildCheckRequest, BuildCheckResult } from "~/seams/types";

/**
 * The build directories a conversation change's paths span — the merge gate builds each one.
 * Team layout: every `agents/<member>/…` path maps to that member's `agents/<member>/agent`
 * root; `.harnesst/**` config and repo-root/shared files (root package-lock.json, workspace
 * config) map to NO root — a team repo's root is a workspaces shell, not an eve project, so
 * there is nothing to build for them (issue #137: falling back to the repo root here is what
 * broke multi-member merges). An empty result means the gate has nothing to compile and
 * passes. Single-agent layout: the repo root IS the eve project — one `undefined` root
 * (projectDirOf builds ".").
 */
export function inferMergeBuildRoots(
  paths: string[],
  teamLayout: boolean,
): (string | undefined)[] {
  if (!teamLayout) return [undefined];
  const roots = new Set<string>();
  for (const p of paths) {
    if (p.startsWith(".harnesst/")) continue;
    const m = p.match(/^agents\/([^/]+)\//);
    if (m) roots.add(`agents/${m[1]}/agent`);
  }
  return [...roots].sort();
}

export type MergeGateResult = { ok: true } | { ok: false; error: string };

/**
 * Run the pre-merge build gate for a conversation branch: build EVERY affected root at the
 * branch ref (no overlay — the branch tree is exactly what merges). Sequential on purpose:
 * checkEveBuild reuses one docker tag per project, so concurrent checks would race on it.
 * Fails fast with the error scoped to the member that broke.
 */
export async function runConversationMergeGate(input: {
  projectId: string;
  repo: { owner: string; repo: string };
  /** The conversation branch ref being merged. */
  ref: string;
  installationId: string;
  teamLayout: boolean;
  /** Changed file paths of the branch's PR (server-fetched). */
  paths: string[];
  checkBuild: (req: BuildCheckRequest) => Promise<BuildCheckResult>;
  /**
   * Progress callback (issue #142): invoked before each root's build check with a human stage
   * label, so a queued merge can stream "Checking the build for … (i/n)…" into the workspace
   * task indicator. Absent for callers that don't render progress.
   */
  onStage?: (stage: string) => void | Promise<void>;
}): Promise<MergeGateResult> {
  const roots = inferMergeBuildRoots(input.paths, input.teamLayout);
  for (const [i, agentRoot] of roots.entries()) {
    await input.onStage?.(
      `Checking the build for ${agentRoot ?? "the repository"}${
        roots.length > 1 ? ` (${i + 1}/${roots.length})` : ""
      }…`,
    );
    const check = await input.checkBuild({
      projectId: input.projectId,
      repo: input.repo,
      ref: input.ref,
      installationId: input.installationId,
      overlay: [],
      agentRoot,
    });
    if (!check.ok) {
      const scope = agentRoot ? ` (\`${agentRoot}\`)` : "";
      return {
        ok: false,
        error: `This change doesn't build yet${scope}, so it can't be merged:\n${check.output}`,
      };
    }
  }
  return { ok: true };
}
