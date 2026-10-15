import type { BundleProvisioningRow } from "~/db/schema";
import type { HarnesstLock } from "~/marketplace/lock";
import type { ProvisionerDescriptor } from "./descriptors";
import type { ConnectionLink } from "./link";

export interface ProvisionerSetupContext {
  project: { id: string; orgId: string };
  lock: HarnesstLock;
  /** The signed-in user's email, a default for human contacts. */
  userEmail: string;
  /** The team's member names, for role pickers. */
  memberNames: string[];
  link: ConnectionLink;
}

export type UpgradeResult =
  /** Not installed, so there is nothing to upgrade. */
  | { outcome: "skipped" }
  /** Another run for this team holds the lock; it applies the same migrations. */
  | { outcome: "busy" }
  | { outcome: "upgraded"; applied: string[] }
  /** Recorded on the provisioning row; never thrown, so a caller can't fail on it. */
  | { outcome: "failed"; error: string };

/**
 * A provisioner sets up and maintains something outside harnesst that a template needs (today
 * the ledger's Supabase database), using a workspace service connection the team links in Setup.
 */
export interface Provisioner<Details = unknown> {
  descriptor: ProvisionerDescriptor;
  /** Directory of the migrations it applies, in sorted order. */
  migrations: string;
  /** The `provision_bundle` job: the full install from saved Setup inputs. */
  install(projectId: string): Promise<void>;
  /** The `verify_bundle` job: post-deploy checks. */
  verify(projectId: string, attempt: number): Promise<void>;
  /** The `upgrade_bundle` job: apply only what's pending. Idempotent; never throws. */
  upgrade(projectId: string): Promise<UpgradeResult>;
  /** Cheap local check: does an installed row have anything to upgrade? */
  needsUpgrade(row: BundleProvisioningRow): Promise<boolean>;
  /** Loader data for the provisioner's Setup UI. Display-safe: no credentials. */
  setupDetails(
    ctx: ProvisionerSetupContext,
    row: BundleProvisioningRow,
  ): Promise<Details>;
  /** A Setup form submission for this provisioner. Throws a displayable Error. */
  setupAction(
    ctx: ProvisionerSetupContext,
    op: string,
    form: FormData,
  ): Promise<void>;
}
