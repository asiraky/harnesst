// Hand-written declarations for the plain-JS worktree setup script so the
// vitest suite (tests/unit/worktree-setup.test.ts) typechecks. Keep in sync
// with the exported helpers in worktree-setup.mjs.

export type PortEntry = {
  dev: number;
  splitter: number;
  instance: number;
  tunnelShortId?: string;
  tunnelHost?: string;
  path?: string;
};
export type PortsRegistry = Record<string, PortEntry>;

export function allocatePorts(
  registry: PortsRegistry,
  feature: string,
): PortEntry;
export function withDatabaseName(url: string, db: string): string;
export function parseDatabaseUrl(url: string): {
  user: string;
  password: string;
  db: string;
};
export function applyEnvOverrides(
  original: string,
  overrides: Record<string, string>,
): string;
export function parseEnvFile(text: string): Record<string, string>;
export function resolveBetterAuthSecret(existing?: string): string;
export function acquireSetupLock(
  lockDir: string,
  options?: { timeoutMs?: number; pollMs?: number; pid?: number },
): void;
export function releaseSetupLock(lockDir: string): void;
export function withWorktreeAppendix(
  rawAgentsMd: string,
  appendixMarker: string,
  appendix: string,
): string;
