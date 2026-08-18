/**
 * Bounded-concurrency map (issue #375): the publish build step and the job worker's deploy pool
 * both need "run at most N of these at once" without pulling in a dependency.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Results come back in ITEM order
 * (not completion order) as settled results — the call itself never rejects, so one failed item
 * cannot abandon its in-flight siblings; callers own the failure policy.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  // A NaN limit must clamp to 1, not propagate: Array.from({length: NaN}) is ZERO workers,
  // which would return a sparse result array the caller reads as "no failures".
  const bound = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workers = Array.from(
    { length: Math.max(1, Math.min(bound, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * A concurrency knob read from the environment: a positive integer, else `fallback`. A typo'd
 * value must degrade to the default — Number("two") is NaN, and NaN silently disables every
 * comparison it touches (zero pool workers, an unbounded in-flight check).
 */
export function concurrencyFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}
