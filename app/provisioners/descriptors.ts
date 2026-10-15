/**
 * Client-safe facts about each provisioner: what Setup calls its steps and which workspace
 * service connection it runs with. The server side (install, verify, upgrade) is registry.server.ts.
 * Ids are the values templates declare in `provisioning` (manifest.ts).
 */
import type { ServiceProviderId } from "~/service-connections/providers";

export interface ProvisionerDescriptor {
  id: string;
  /** Setup step title for the install. */
  title: string;
  /** Setup step title for post-deploy verification, or null when there is none. */
  verifyTitle: string | null;
  /** The workspace service connection the provisioner runs with. */
  connectionProvider: ServiceProviderId;
}

export const PROVISIONERS = {
  "supabase-ledger": {
    id: "supabase-ledger",
    title: "Install the ledger database",
    verifyTitle: "Check deployment and callbacks",
    connectionProvider: "supabase",
  },
} as const satisfies Record<string, ProvisionerDescriptor>;

export type ProvisionerId = keyof typeof PROVISIONERS;

export function isProvisionerId(value: unknown): value is ProvisionerId {
  return typeof value === "string" && Object.hasOwn(PROVISIONERS, value);
}

export function provisionerDescriptor(
  id: ProvisionerId,
): ProvisionerDescriptor {
  return PROVISIONERS[id];
}

/** bundle_provisioning statuses after which the install exists (upgrades apply, verify runs). */
export const INSTALLED_STATUSES: readonly string[] = ["provisioned", "ready"];
/** Statuses during which a run owns the row. */
export const BUSY_STATUSES: readonly string[] = ["running", "activating"];

/** Finished: installed, and verified when the provisioner has a verify step. */
export function provisioningComplete(
  id: ProvisionerId,
  status: string,
): boolean {
  return PROVISIONERS[id].verifyTitle
    ? status === "ready"
    : INSTALLED_STATUSES.includes(status);
}
