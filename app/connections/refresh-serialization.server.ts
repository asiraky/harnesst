/**
 * Per-grant refresh serialization (issue #167). Rotating-grant providers revoke the whole
 * token family when a stored refresh token is consumed twice, so EVERY control-plane refresh of a
 * grant — broker calls (broker.server.ts) AND deploy-time validation (deploy.server.ts) — must run
 * on ONE in-process chain per grant scope: each task re-reads the grant row inside the chain, so a
 * queued task always consumes its predecessor's rotated token, never the same stored one. The two
 * callers share this module precisely so a broker call racing a redeploy's validation refresh
 * cannot double-spend a token. Cross-process writes (not a shape the single-container control
 * plane produces) are detected after the fact by the compare-and-set in
 * `rotateGrantRefreshToken` and surface as a retryable error.
 */

/** Per-grant-scope serialization chains, keyed before the grant row is read. */
const refreshChains = new Map<string, Promise<unknown>>();

/** The chain key for one grant scope — every refresh path MUST build it identically. */
export function grantRefreshKey(input: {
  projectId: string;
  agentId: string;
  provider: string;
}): string {
  return `${input.projectId}/${input.agentId}/${input.provider}`;
}

/**
 * Run `task` after every earlier task for the same key has settled — a failed predecessor never
 * poisons the chain (its rejection is observed by its own caller only).
 */
export async function serializedRefresh<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const tail = refreshChains.get(key) ?? Promise.resolve();
  const run = tail.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  refreshChains.set(key, settled);
  try {
    return await run;
  } finally {
    if (refreshChains.get(key) === settled) refreshChains.delete(key);
  }
}
