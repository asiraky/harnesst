/**
 * Generic bundle_provisioning storage, keyed by (project, provisioner): the row, its sealed
 * private state, per-project serialisation, and the team's link to a workspace service
 * connection. Provisioners keep their own state shape; this module never looks inside it.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  bundleProvisioning,
  projects,
  type BundleProvisioningRow,
} from "~/db/schema";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";
import {
  ServiceConnectionUnusableError,
  getServiceConnection,
  listServiceConnections,
  withServiceCredential,
} from "~/service-connections/connections.server";
import { SERVICE_PROVIDERS } from "~/service-connections/providers";
import { provisionerDescriptor, type ProvisionerId } from "./descriptors";
import {
  resolveConnectionLink,
  type ConnectionLink,
  type LinkOption,
} from "./link";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialises one team's provisioning writes for the rest of the transaction. */
export function lockProvisioning(tx: Tx, projectId: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
}

export function sealState(state: object) {
  return seal(
    decodeKey(process.env.HARNESST_SECRETS_KEY),
    JSON.stringify(state),
  );
}

export function openState<T extends object>(
  row: Pick<BundleProvisioningRow, "encryptedState">,
): T {
  return row.encryptedState
    ? JSON.parse(
        open(decodeKey(process.env.HARNESST_SECRETS_KEY), row.encryptedState),
      )
    : ({} as T);
}

const key = (projectId: string, provisioner: ProvisionerId) =>
  and(
    eq(bundleProvisioning.projectId, projectId),
    eq(bundleProvisioning.provisioner, provisioner),
  );

export async function getProvisioning(
  projectId: string,
  provisioner: ProvisionerId,
  tx: Tx | typeof db = db,
): Promise<BundleProvisioningRow | null> {
  return (
    (
      await tx
        .select()
        .from(bundleProvisioning)
        .where(key(projectId, provisioner))
    )[0] ?? null
  );
}

export function listProvisioning(
  projectId: string,
): Promise<BundleProvisioningRow[]> {
  return db
    .select()
    .from(bundleProvisioning)
    .where(eq(bundleProvisioning.projectId, projectId));
}

/** Installing a template that declares a provisioner creates its pending row. */
export async function ensureProvisioning(
  projectId: string,
  provisioner: ProvisionerId,
) {
  await db
    .insert(bundleProvisioning)
    .values({ projectId, provisioner })
    .onConflictDoNothing();
}

export async function updateProvisioning(
  projectId: string,
  provisioner: ProvisionerId,
  values: Partial<typeof bundleProvisioning.$inferInsert>,
  tx: Tx | typeof db = db,
) {
  await tx
    .update(bundleProvisioning)
    .set({ ...values, updatedAt: new Date() })
    .where(key(projectId, provisioner));
}

async function projectOrg(projectId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row) throw new Error("Project not found.");
  return row.orgId;
}

/** The team's connection link as Setup shows it, plus every candidate for choosing. */
export async function resolveProvisionerLink(
  projectId: string,
  provisioner: ProvisionerId,
  row?: BundleProvisioningRow | null,
): Promise<{ orgId: string; link: ConnectionLink; options: LinkOption[] }> {
  const orgId = await projectOrg(projectId);
  const current =
    row === undefined ? await getProvisioning(projectId, provisioner) : row;
  const options = (
    await listServiceConnections(
      orgId,
      provisionerDescriptor(provisioner).connectionProvider,
    )
  ).map((c) => ({ id: c.id, label: c.label, status: c.status }));
  return {
    orgId,
    link: resolveConnectionLink(current?.serviceConnectionId ?? null, options),
    options,
  };
}

/** Link a team's provisioner to one of its workspace's connections for that provider. */
export async function linkProvisionerConnection(input: {
  projectId: string;
  orgId: string;
  provisioner: ProvisionerId;
  connectionId: string;
}) {
  const connection = await getServiceConnection(
    input.orgId,
    input.connectionId,
  );
  if (
    !connection ||
    connection.provider !==
      provisionerDescriptor(input.provisioner).connectionProvider ||
    (await projectOrg(input.projectId)) !== input.orgId
  )
    throw new Error("That connection isn't available in this workspace.");
  await ensureProvisioning(input.projectId, input.provisioner);
  await updateProvisioning(input.projectId, input.provisioner, {
    serviceConnectionId: connection.id,
  });
}

/** Why the link can't be used yet, in words that tell the user what to do. */
export function unusableLinkError(
  provisioner: ProvisionerId,
  link: Exclude<ConnectionLink, { state: "ready" }>,
): ServiceConnectionUnusableError {
  const name =
    SERVICE_PROVIDERS[provisionerDescriptor(provisioner).connectionProvider]
      .displayName;
  switch (link.state) {
    case "none":
      return new ServiceConnectionUnusableError(
        "missing",
        `Add a ${name} connection in Settings → Connections, then link it to this team in Setup.`,
      );
    case "choose":
      return new ServiceConnectionUnusableError(
        "missing",
        `Choose which ${name} connection this team uses in Setup.`,
      );
    case "reconnect":
      return new ServiceConnectionUnusableError(
        link.connection.status === "expired" ? "expired" : "invalid",
        `Reconnect ${name}: the ${link.connection.label} connection was rejected. Replace its token in Settings → Connections.`,
      );
  }
}

/**
 * SERVER ONLY. Runs `fn` with the team's linked credential. An auto-selected connection becomes
 * the team's link on first use, so adding a second connection later doesn't change which one
 * this team uses. Throws ServiceConnectionUnusableError when there is nothing usable, and marks
 * the connection when the provider rejects it mid-run.
 */
export async function withLinkedCredential<T>(
  projectId: string,
  provisioner: ProvisionerId,
  fn: (secret: string) => Promise<T>,
  opts: { saveAutoLink?: boolean } = {},
): Promise<T> {
  const { orgId, link } = await resolveProvisionerLink(projectId, provisioner);
  if (link.state !== "ready") throw unusableLinkError(provisioner, link);
  // Page loads read without writing; runs that act on the team save the link.
  if (!link.linked && opts.saveAutoLink !== false)
    await updateProvisioning(projectId, provisioner, {
      serviceConnectionId: link.connection.id,
    });
  return withServiceCredential(
    {
      orgId,
      id: link.connection.id,
      provider: provisionerDescriptor(provisioner).connectionProvider,
    },
    fn,
  );
}

/**
 * Runs `fn` unless another run for this team's provisioner already holds the lock; returns
 * "busy" then. Holds one pooled connection for the duration, which serialises upgrades across
 * processes without a status flag that a crash could leave behind.
 */
export async function withExclusiveRun<T>(
  projectId: string,
  provisioner: ProvisionerId,
  fn: () => Promise<T>,
): Promise<T | "busy"> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`run:${provisioner}:${projectId}`})) as locked`,
    );
    if (!row?.locked) return "busy" as const;
    return fn();
  });
}
