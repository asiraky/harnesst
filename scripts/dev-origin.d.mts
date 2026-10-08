// Hand-written declarations for scripts/dev-origin.mjs so vite.config.ts and the vitest suite
// typecheck. Keep in sync with its exports.

export const DEV_DOMAIN: string;
export function isLoopbackHost(hostname: string): boolean;
export function worktreeSlug(dirName: string): string;
export function devHostname(input: {
  cwd: string;
  isWorktree: boolean;
}): string;
export function isGitWorktree(cwd: string): boolean;
export function resolveDevOrigin(input: {
  env: { BETTER_AUTH_URL?: string; HARNESST_DEV_HOST?: string };
  port: number;
  cwd: string;
  isWorktree: boolean;
  resolves: (hostname: string) => Promise<boolean>;
}): Promise<{ origin: string; upgraded: boolean; note?: string }>;
export function hostResolves(
  hostname: string,
  timeoutMs?: number,
): Promise<boolean>;
