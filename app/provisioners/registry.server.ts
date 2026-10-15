/**
 * The provisioner registry: the one place that maps a provisioner id (a template's
 * `provisioning` entry) to its implementation. Install routes, the setup wizard, the job worker
 * and the publish pipeline go through here and never name a provisioner themselves.
 */
import { enqueue } from "~/jobs/queue.server";
import {
  INSTALLED_STATUSES,
  isProvisionerId,
  provisioningComplete,
  type ProvisionerId,
} from "./descriptors";
import { ensureProvisioning, listProvisioning } from "./state.server";
import { supabaseLedger } from "./supabase-ledger/provisioner.server";
import type { Provisioner } from "./types";

const REGISTRY: Record<ProvisionerId, Provisioner> = {
  "supabase-ledger": supabaseLedger,
};

export function getProvisioner(id: ProvisionerId): Provisioner {
  return REGISTRY[id];
}

/** Creates a pending row for every provisioner an installed template declares. */
export async function ensureProvisioners(
  projectId: string,
  ids: Iterable<string>,
) {
  for (const id of new Set(ids))
    if (isProvisionerId(id)) await ensureProvisioning(projectId, id);
}

export interface RegistryDeps {
  list?: typeof listProvisioning;
  provisioner?: (id: ProvisionerId) => Provisioner;
  enqueue?: typeof enqueue;
}

/**
 * The provisioner a provisioning job is for. Jobs queued before provisioners were keyed carry
 * only a project id; those belong to the project's single provisioning row.
 */
export async function resolveJobProvisioner(
  payload: Record<string, unknown>,
  deps: RegistryDeps = {},
): Promise<{ projectId: string; provisioner: Provisioner }> {
  const projectId = String(payload.projectId ?? "");
  if (!projectId) throw new Error("Provisioning job is missing projectId.");
  const get = deps.provisioner ?? getProvisioner;
  if (payload.provisioner !== undefined) {
    if (!isProvisionerId(payload.provisioner))
      throw new Error(`Unknown provisioner: ${String(payload.provisioner)}`);
    return { projectId, provisioner: get(payload.provisioner) };
  }
  const rows = (await (deps.list ?? listProvisioning)(projectId)).filter((r) =>
    isProvisionerId(r.provisioner),
  );
  if (rows.length !== 1)
    throw new Error(
      "Provisioning job has no provisioner and the project has no single one.",
    );
  return { projectId, provisioner: get(rows[0].provisioner as ProvisionerId) };
}

/** Dispatches provision_bundle / verify_bundle / upgrade_bundle. */
export async function runProvisioningJob(
  kind: "provision_bundle" | "verify_bundle" | "upgrade_bundle",
  payload: Record<string, unknown>,
  deps: RegistryDeps = {},
) {
  const { projectId, provisioner } = await resolveJobProvisioner(payload, deps);
  switch (kind) {
    case "provision_bundle":
      return provisioner.install(projectId);
    case "verify_bundle":
      return provisioner.verify(projectId, Number(payload.attempt ?? 0));
    case "upgrade_bundle": {
      const result = await provisioner.upgrade(projectId);
      if (result.outcome === "failed")
        console.warn(
          `[provisioning] ${provisioner.descriptor.id} upgrade failed for ${projectId}: ${result.error}`,
        );
      return;
    }
  }
}

/**
 * After a publish: queue an upgrade for each installed provisioner with something pending. The
 * check is local (no provider call), so a publish with nothing to upgrade queues nothing.
 */
export async function scheduleProvisionerUpgrades(
  projectId: string,
  deps: RegistryDeps = {},
): Promise<ProvisionerId[]> {
  const scheduled: ProvisionerId[] = [];
  for (const row of await (deps.list ?? listProvisioning)(projectId)) {
    if (
      !isProvisionerId(row.provisioner) ||
      !INSTALLED_STATUSES.includes(row.status)
    )
      continue;
    const provisioner = (deps.provisioner ?? getProvisioner)(row.provisioner);
    if (!(await provisioner.needsUpgrade(row))) continue;
    await (deps.enqueue ?? enqueue)(
      "upgrade_bundle",
      { projectId, provisioner: row.provisioner },
      { maxAttempts: 1 },
    );
    scheduled.push(row.provisioner);
  }
  return scheduled;
}

/** Whether any provisioner the lock declares is unfinished (no row counts as unfinished). */
export async function provisioningIncomplete(
  projectId: string,
  declared: string[],
  deps: Pick<RegistryDeps, "list"> = {},
): Promise<boolean> {
  const ids = declared.filter(isProvisionerId);
  if (ids.length === 0) return false;
  const rows = await (deps.list ?? listProvisioning)(projectId);
  return ids.some((id) => {
    const status = rows.find((r) => r.provisioner === id)?.status;
    return !status || !provisioningComplete(id, status);
  });
}
