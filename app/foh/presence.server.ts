/**
 * Front of House presence — per-agent ●/○ derivation (§3 sidebar, §6 legibility).
 *
 * Two halves, both from state harnesst already keeps:
 * - Container half: `deployments.status` per environment, read WITHOUT the live filter —
 *   `live` = reachable (●), `stopped`/`draining`/in-flight = wakeable-idle (○), failed-only =
 *   error. A deploy cutover transiently holds two live rows; any live row counts as live.
 * - Active-turn half: `runs.countRunningByDeployment` on the live rows ("any turn anywhere",
 *   incl. delegations/cron) plus fresh `running` playground_sessions rows (session-level
 *   granularity with a staleness cutoff — a drain that died with the process must not show a
 *   phantom turn forever). `hasActiveTurn` is deliberately NOT consulted: it is per-process.
 *
 * Honesty note (risk register): deployments.status is routing truth, not physical truth, and
 * no idle-stop exists — so presence reads "running/idle", never a promise of activity.
 */
import { TURN_IDLE_TIMEOUT_MS } from "~/chat/turn-stream.server";
import type { DataStore } from "~/data/ports";
import { listAgentsWithFreshRunningSessions } from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

export type AgentPresence = "active_turn" | "running" | "idle" | "error";

/** Deployment statuses that mean "an instance exists and could be (or become) reachable". */
const WAKEABLE = new Set(["stopped", "draining", "pending", "building"]);

/** Pure derivation — the unit-testable matrix behind the sidebar dots. */
export function deriveAgentPresence(input: {
  /** Every deployment row's status across the agent's environments (no live filter). */
  deploymentStatuses: string[];
  /** `running` runs attributed to the agent's LIVE deployments. */
  runningTurnCount: number;
  /** A fresh `running` chat session exists for this agent (see staleness note above). */
  hasFreshRunningSession: boolean;
}): AgentPresence {
  const hasLive = input.deploymentStatuses.includes("live");
  if (hasLive && (input.runningTurnCount > 0 || input.hasFreshRunningSession)) {
    return "active_turn";
  }
  if (hasLive) return "running";
  if (input.deploymentStatuses.some((status) => WAKEABLE.has(status))) {
    return "idle";
  }
  if (input.deploymentStatuses.includes("failed")) return "error";
  // Never deployed — nothing to wake, nothing broken; reads as idle.
  return "idle";
}

/**
 * Presence for a set of agents (one sidebar load). Deps are injectable so the sidebar unit
 * tests run over the FakeStore with a scripted running-sessions set.
 */
export async function agentPresenceMap(
  agentIds: string[],
  deps: {
    store?: DataStore;
    freshRunningAgentIds?: (agentIds: string[]) => Promise<Set<string>>;
  } = {},
): Promise<Map<string, AgentPresence>> {
  const store = deps.store ?? getRuntime().data;
  const freshRunning = await (deps.freshRunningAgentIds
    ? deps.freshRunningAgentIds(agentIds)
    : listAgentsWithFreshRunningSessions(agentIds, TURN_IDLE_TIMEOUT_MS));

  const presence = new Map<string, AgentPresence>();
  await Promise.all(
    agentIds.map(async (agentId) => {
      const environments = await store.environments.listByAgent(agentId);
      const deployments = (
        await Promise.all(
          environments.map((env) => store.deployments.listByEnvironment(env.id)),
        )
      ).flat();
      const liveRows = deployments.filter((d) => d.status === "live");
      const counts = await Promise.all(
        liveRows.map((d) => store.runs.countRunningByDeployment(d.id)),
      );
      presence.set(
        agentId,
        deriveAgentPresence({
          deploymentStatuses: deployments.map((d) => d.status),
          runningTurnCount: counts.reduce((sum, n) => sum + n, 0),
          hasFreshRunningSession: freshRunning.has(agentId),
        }),
      );
    }),
  );
  return presence;
}
