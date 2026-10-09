/** Renew only while this process still owns a running channel turn. A crash drops the timer. */
export function startLeaseHeartbeat(
  renew: () => Promise<{ ok: boolean; data?: { renewed?: boolean } }>,
  intervalMs: number = 60_000,
): { stop: () => void; tick: () => Promise<void> } {
  let stopped = false;
  let pending = false;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };
  const tick = async (): Promise<void> => {
    if (stopped || pending) return;
    pending = true;
    try {
      const result = await renew();
      // A refusal fences this claimant out. Transient transport errors retry until the DB lease expires.
      if (result.ok && !result.data?.renewed) stop();
    } catch {
      /* retry a transient transport failure on the next heartbeat */
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return { stop, tick };
}

type LeaseRpc = (
  op: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; data?: any }>;
/**
 * Keeps a claimed ledger lease alive from a process timer, so long silent model work keeps it.
 * `hold` starts the heartbeat and, once the session id is known, binds the lease to that session.
 * `release` ends it at turn end; `drop` only stops renewing, so expiry hands it on if nobody returns.
 */
export function createLeaseKeeper(rpc: LeaseRpc, intervalMs: number = 60_000) {
  const held = new Map<
    string,
    { sessionId?: string; heartbeat: ReturnType<typeof startLeaseHeartbeat> }
  >();
  const stop = (token: string): void => {
    held.get(token)?.heartbeat.stop();
    held.delete(token);
  };
  return {
    has: (token: string): boolean => held.has(token),
    async hold(token: string, sessionId?: string): Promise<void> {
      if (!token) return;
      const existing = held.get(token);
      if (existing) {
        if (sessionId && !existing.sessionId) {
          existing.sessionId = sessionId;
          await existing.heartbeat.tick();
        }
        return;
      }
      const entry: { sessionId?: string; heartbeat: ReturnType<typeof startLeaseHeartbeat> } = {
        sessionId,
        heartbeat: startLeaseHeartbeat(async () => {
          const result = await rpc("renew_lease", {
            lease_token: token,
            ...(entry.sessionId ? { session_id: entry.sessionId } : {}),
          });
          if (result.ok && !result.data?.renewed) held.delete(token);
          return result;
        }, intervalMs),
      };
      held.set(token, entry);
      await entry.heartbeat.tick();
    },
    async release(token: string): Promise<void> {
      if (!token) return;
      stop(token);
      // A failed release is harmless: the lease expires without heartbeats.
      await rpc("release_lease", { lease_token: token }).catch(() => undefined);
    },
    drop: stop,
  };
}
