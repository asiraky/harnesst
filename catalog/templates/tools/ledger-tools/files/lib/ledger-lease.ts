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
