/**
 * When is a `running` chat session actually dead?
 *
 * A session is flipped to `running` when a turn starts and back to `waiting`/`failed` by the
 * drain that streams it (see turn-stream.server.ts). If that drain dies — dev-server reload,
 * control-plane restart, redeploy mid-turn — nothing ever settles the status, the UI treats the
 * session as busy forever, and the reconnect poll revalidates every 2s without end. Reconciling
 * from Eve can't always recover either: an instance that never saw the session (a fresh container
 * after a redeploy) HANGS its `/session/:id/stream` endpoint instead of 404ing, so the tail read
 * yields nothing and the status stays stuck (#73).
 *
 * This module is the pure decision: settle when no drain in this process owns the turn AND the
 * turn is provably unrecoverable — the deployment that ran it is gone (its instance was stopped,
 * taking the turn with it), or Eve has been silent past the drain's own idle timeout (a live
 * drain bumps the session row about once a second, so prolonged silence means no drain anywhere
 * is making progress).
 */
export function shouldSettleAbandonedSession(input: {
  status: string;
  /** A drain for this session is streaming in this process (`hasActiveTurn`). */
  activeTurnInProcess: boolean;
  /** A live target still serves the session's environment (its world store holds the turn). */
  ownerDeploymentLive: boolean;
  /** Time since the session row last moved (`updatedAt` — progress saves bump it ~1s). */
  msSinceLastActivity: number;
  /** The drain's own silence budget (TURN_IDLE_TIMEOUT_MS). */
  idleTimeoutMs: number;
}): boolean {
  if (input.status !== "running" || input.activeTurnInProcess) return false;
  if (!input.ownerDeploymentLive) return true;
  return input.msSinceLastActivity > input.idleTimeoutMs;
}
