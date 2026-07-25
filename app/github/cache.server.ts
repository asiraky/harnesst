/**
 * In-memory stale-while-revalidate cache for GitHub reads (M5.9).
 *
 * Every GitHub REST call costs ~600ms from this machine (Australia), and a single navigation
 * chains several — so uncached loaders sat at 2–3s. This cache lets a loader return the last
 * known value instantly and refresh it in the background, turning repeat navigations into a
 * memory hit. Entries are keyed per connected repo (owner/repo + ref), so growth is bounded by
 * the number of connected repos in practice — there is no eviction (unbounded by design at this
 * scale; a process restart clears it, and invalidation drops stale keys on writes/webhooks).
 *
 * Staleness is checked lazily on access — no timers. Concurrent reads for one key share a single
 * in-flight fetch (both on a cold miss and a background revalidation), so one key never triggers
 * two GitHub calls at once. The instance is stashed on `globalThis` to survive dev HMR (same
 * pattern as the Drizzle client, db/client.server.ts).
 */

interface Entry<T> {
  value: T;
  fetchedAt: number;
}

export class SwrCache {
  private entries = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  /**
   * Return a cached value, revalidating per its age:
   *  - miss  → run the fetcher (blocking), store, and return it.
   *  - fresh (age < ttlMs) → return the cached value, no fetch.
   *  - stale (age ≥ ttlMs) → return the cached value immediately AND kick off a background
   *    revalidation; on failure the stale value is kept and a warning is logged once.
   * Concurrent calls for the same key share one fetcher promise.
   */
  async get<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key) as Entry<T> | undefined;

    if (entry) {
      const age = Date.now() - entry.fetchedAt;
      if (age >= ttlMs) {
        // Stale: refresh in the background (deduped), but return the old value now. A failed
        // revalidation keeps the stale value — warn (never leave the rejection unhandled).
        this.revalidate(key, fetcher).catch((error) => {
          console.warn(`[github-cache] background revalidation failed for ${key}:`, error);
        });
      }
      return entry.value;
    }

    // Miss: block on the (deduped) fetch.
    return this.revalidate(key, fetcher);
  }

  /** Overwrite/warm an entry directly (webhook re-warm, connect flow). */
  set<T>(key: string, value: T): void {
    this.entries.set(key, { value, fetchedAt: Date.now() });
  }

  /** Drop every key starting with `prefix` (e.g. one repo's entries) without knowing the refs. */
  invalidate(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    // Also disown matching in-flight fetches: they started BEFORE the write that invalidated
    // them, so their results may predate the change and must not be written back (callers
    // already joined on the promise still get their read — it just isn't cached).
    for (const key of this.inflight.keys()) {
      if (key.startsWith(prefix)) this.inflight.delete(key);
    }
  }

  /** Run (or join) the single in-flight fetch for `key`, storing its result on success. */
  private revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise: Promise<T> = fetcher()
      .then((value) => {
        // Only write back if this fetch is still the current one — invalidate() disowns
        // in-flight fetches whose results may predate the invalidating write.
        if (this.inflight.get(key) === promise) {
          this.entries.set(key, { value, fetchedAt: Date.now() });
        }
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }
}

const globalForCache = globalThis as unknown as { __harnesstGithubCache?: SwrCache };

export const githubCache: SwrCache = globalForCache.__harnesstGithubCache ?? new SwrCache();

if (process.env.NODE_ENV !== "production") {
  globalForCache.__harnesstGithubCache = githubCache;
}
