/**
 * Cached wrappers around the raw GitHub reads (M5.9).
 *
 * These are the entry points loaders should call — they layer the SWR cache
 * (cache.server.ts) over the raw functions in repo.server.ts / write.server.ts without
 * touching those signatures. The rule the whole milestone rests on: LOADERS read cached
 * (staleness is a fresh background refresh away), but ACTIONS and any read composed INTO a
 * write stay raw — a stale read merged into a commit could clobber newer content. Writes and
 * the webhook invalidate/re-warm the relevant keys so a stale value never outlives the change
 * that obsoleted it.
 */
import { createHash } from "node:crypto";

import { githubCache } from "./cache.server";
import {
  fetchAgentSource,
  fetchLastCommitForPaths,
  type LastCommitInfo,
} from "./repo.server";

/** The shape fetchAgentSource resolves to (raw signature left untouched). */
type AgentSourceResult = Awaited<ReturnType<typeof fetchAgentSource>>;

interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

const SRC_TTL_MS = 60_000; // 60s — repo source rarely changes between navigations.
const META_TTL_MS = 5 * 60_000; // 5min — commit metadata staleness is harmless.

function refPart(ref?: string): string {
  return ref ?? "@default";
}

/** Cached repo source (tree + eager file contents) for a loader. Key: src:<inst>:<repo>:<ref>. */
export function getAgentSource(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
): Promise<AgentSourceResult> {
  const key = `src:${installationId}:${owner}/${repo}:${refPart(ref)}`;
  return githubCache.get(key, SRC_TTL_MS, () =>
    fetchAgentSource(installationId, { owner, repo, ref }),
  );
}

/**
 * Cached last-commit metadata for a set of paths. The path set is folded into a short stable
 * hash so the same list hits the same key regardless of order. Key:
 * meta:<inst>:<repo>:<ref>:<hash>.
 */
export function getLastCommitForPaths(
  installationId: string | number,
  { owner, repo, ref }: RepoRef,
  paths: string[],
): Promise<Record<string, LastCommitInfo>> {
  const hash = createHash("sha1").update([...paths].sort().join("\n")).digest("hex").slice(0, 12);
  const key = `meta:${installationId}:${owner}/${repo}:${refPart(ref)}:${hash}`;
  return githubCache.get(key, META_TTL_MS, () =>
    fetchLastCommitForPaths(installationId, { owner, repo, ref }, paths),
  );
}

/** Drop a repo's source + commit-metadata entries (all refs) — a write changed its contents. */
export function invalidateRepoSource(
  installationId: string | number,
  { owner, repo }: { owner: string; repo: string },
): void {
  githubCache.invalidate(`src:${installationId}:${owner}/${repo}:`);
  githubCache.invalidate(`meta:${installationId}:${owner}/${repo}:`);
}

/** Warm the default-branch source key so the first page load after a connect/push is instant. */
export function warmAgentSource(
  installationId: string | number,
  { owner, repo }: { owner: string; repo: string },
  source: AgentSourceResult,
): void {
  githubCache.set(`src:${installationId}:${owner}/${repo}:${refPart()}`, source);
}
