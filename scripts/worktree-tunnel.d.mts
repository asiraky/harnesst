export const DEFAULT_TUNNEL_DOMAIN: string;
export type PortEntry = {
  dev: number;
  splitter: number;
  instance: number;
  tunnelShortId?: string;
  tunnelHost?: string;
};
export type TunnelMetadata = {
  tunnelId: string;
  tunnelName: string;
  credentialsFile: string;
  domain: string;
};
export function generateTunnelShortId(): string;
export function sanitizeDnsLabel(value: string): string;
export function deriveTunnelHost(
  session: string,
  shortId: string,
  domain?: string,
): string;
export function resolveTunnelDomain(
  metadata: Partial<TunnelMetadata> | null | undefined,
  env?: NodeJS.ProcessEnv,
): string;
export function enrichPortEntry(
  entry: PortEntry,
  session: string,
  domain?: string,
): PortEntry & Required<Pick<PortEntry, "tunnelShortId" | "tunnelHost">>;
export function isSafeHostname(host: string): boolean;
export function renderTunnelConfig(
  metadata: TunnelMetadata,
  registry: Record<string, PortEntry>,
): string;
export function parseQuickTunnelUrl(output: string): string;
export function cloudflaredEnvironment(
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function resolveCloudflaredBin(
  env?: NodeJS.ProcessEnv,
  exists?: (path: string) => boolean,
): string;
export function rehomeRegistry<T extends Record<string, PortEntry>>(
  registry: T,
  domain: string,
): T;
export function findWorktreeEntry(
  registry: Record<string, PortEntry>,
  key: string,
  port: number,
): { key: string; entry: PortEntry } | null;
export function parseRouteDnsHost(output: string): string | null;
export function parseOriginCert(
  contents: string,
): { zoneID: string; accountID?: string; apiToken: string } | null;
export function hostInZone(host: string, zone: string): boolean;
