/**
 * Roster-change teammate refresh (Team delegation — D7). `HARNESST_TEAMMATES` is deploy-time env, so
 * adding or removing a member must refresh the OTHER members' running instances — otherwise a new
 * teammate never appears in their tool, and a removed one lingers. After a merge-driven roster
 * sync changes membership, this queues a same-release redeploy (image reuse — no rebuild) of every
 * live member deployment; each redeploy re-mints `HARNESST_TEAMMATES` from the current roster.
 *
 * Trigger discipline (D7): called ONLY from the merge webhook — the merge-driven sync point that
 * also covers in-app ship (which merges via GitHub). NEVER from the loader self-heal path
 * (`resolveSyncedAgentContext` also syncs the roster, and a page load must not deploy anything).
 */
import type { DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import { queueDeploy } from "./controller.server";

/**
 * Queue teammate refreshes when membership changed. No-op when the roster names are unchanged (a
 * routine merge that only edited config) or when the repo is single-agent. Returns how many
 * redeploys were queued. Best-effort — callers should not let it break release cutting.
 */
export async function refreshTeammatesForRosterChange(
  input: {
    projectId: string;
    previousNames: string[];
    currentNames: string[];
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<number> {
  const before = new Set(input.previousNames);
  const after = new Set(input.currentNames);
  const membershipChanged =
    before.size !== after.size || [...after].some((n) => !before.has(n));
  if (!membershipChanged) return 0;

  const roster = await store.agents.listByProject(input.projectId);
  // Only team members carry HARNESST_TEAMMATES; a single-agent repo has nothing to refresh, and the
  // built-in assistant (kind !== 'member') is never a teammate.
  const members = roster.filter((a) => a.kind === "member" && a.root !== "agent");
  if (members.length === 0) return 0;

  let queued = 0;
  for (const member of members) {
    const envs = await store.environments.listByAgent(member.id);
    for (const env of envs) {
      const deployments = await store.deployments.listByEnvironment(env.id);
      // An env with a deploy already in flight is skipped ENTIRELY: on the in-app ship path the
      // ship queues the member's new-release deploy BEFORE this refresh runs, so the env's
      // current live row still points at the pre-merge release — queueing that release here
      // would land AFTER the ship's job (FIFO worker) and silently revert the member. The
      // in-flight deploy re-mints HARNESST_TEAMMATES from the current roster anyway.
      if (deployments.some((d) => d.status === "pending" || d.status === "building")) {
        continue;
      }
      // Redeploy the env's CURRENT live release (image reuse) so only running members refresh;
      // a just-added member has no live deployment yet — it deploys with the right roster anyway.
      const live = deployments.find((d) => d.status === "live");
      if (!live) continue;
      await queueDeploy(
        {
          environmentId: env.id,
          releaseId: live.releaseId,
          createdBy: input.createdBy ?? null,
        },
        store,
      );
      queued++;
    }
  }
  return queued;
}
