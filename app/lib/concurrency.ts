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
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
