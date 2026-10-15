/**
 * Workspace service connections: display-safe CRUD plus server-only credential access.
 *
 * The credential is sealed with HARNESST_SECRETS_KEY and opened only by `openServiceCredential`
 * for an outbound call to the provider's fixed API origin. Every other function returns the
 * display shape, which has no credential field at all. Writes verify the credential first, so a
 * connection is only ever `active` with a credential the provider accepted.
 */
import { and, asc, eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { serviceConnections, type ServiceConnectionRow } from "~/db/schema";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";
import {
  isServiceProviderId,
  type ServiceConnection,
  type ServiceConnectionStatus,
  type ServiceProviderId,
} from "./providers";
import {
  ServiceCredentialError,
  serviceProvider,
  verifyServiceCredential,
  type VerifiedCredential,
} from "./providers.server";

/** The linked connection can't be used: missing, or marked expired/invalid. Safe to show. */
export class ServiceConnectionUnusableError extends Error {
  constructor(
    readonly reason: "missing" | "expired" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceConnectionDeps {
  verify?: (
    provider: ServiceProviderId,
    credential: string,
  ) => Promise<VerifiedCredential>;
}

function secretsKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

export function toDisplayServiceConnection(
  row: ServiceConnectionRow,
): ServiceConnection {
  if (!isServiceProviderId(row.provider))
    throw new Error(`Unknown service provider on connection ${row.id}.`);
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    status: row.status as ServiceConnectionStatus,
    lastVerifiedAt: row.lastVerifiedAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function sealCredential(credential: string) {
  const sealed = seal(secretsKey(), credential);
  return {
    credentialCiphertext: sealed.ciphertext,
    credentialIv: sealed.iv,
    credentialAuthTag: sealed.authTag,
  };
}

function cleanLabel(label: string, fallback: string) {
  const value = label.trim().slice(0, 120);
  return value || fallback;
}

async function findRow(orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(serviceConnections)
    .where(
      and(eq(serviceConnections.orgId, orgId), eq(serviceConnections.id, id)),
    );
  return row ?? null;
}

export async function listServiceConnections(
  orgId: string,
  provider?: ServiceProviderId,
): Promise<ServiceConnection[]> {
  const rows = await db
    .select()
    .from(serviceConnections)
    .where(
      provider
        ? and(
            eq(serviceConnections.orgId, orgId),
            eq(serviceConnections.provider, provider),
          )
        : eq(serviceConnections.orgId, orgId),
    )
    .orderBy(asc(serviceConnections.createdAt), asc(serviceConnections.id));
  return rows
    .filter((r) => isServiceProviderId(r.provider))
    .map(toDisplayServiceConnection);
}

export async function getServiceConnection(
  orgId: string,
  id: string,
): Promise<ServiceConnection | null> {
  const row = await findRow(orgId, id);
  return row && isServiceProviderId(row.provider)
    ? toDisplayServiceConnection(row)
    : null;
}

/** Verify, then store. The plaintext credential is never persisted. */
export async function createServiceConnection(
  input: {
    orgId: string;
    provider: ServiceProviderId;
    label: string;
    credential: string;
    createdBy?: string | null;
  },
  deps: ServiceConnectionDeps = {},
): Promise<ServiceConnection> {
  if (!isServiceProviderId(input.provider))
    throw new Error("Unknown service provider.");
  const credential = input.credential.trim();
  const { metadata } = await (deps.verify ?? verifyServiceCredential)(
    input.provider,
    credential,
  );
  const [row] = await db
    .insert(serviceConnections)
    .values({
      orgId: input.orgId,
      provider: input.provider,
      label: cleanLabel(input.label, input.provider),
      ...sealCredential(credential),
      status: "active",
      lastVerifiedAt: new Date(),
      metadata,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return toDisplayServiceConnection(row);
}

/** Swap in a new credential (verified first). Bumps the version so in-flight users notice. */
export async function replaceServiceConnectionCredential(
  input: { orgId: string; id: string; credential: string; label?: string },
  deps: ServiceConnectionDeps = {},
): Promise<ServiceConnection> {
  const existing = await findRow(input.orgId, input.id);
  if (!existing || !isServiceProviderId(existing.provider))
    throw new Error("This connection is unavailable in this workspace.");
  const credential = input.credential.trim();
  const { metadata } = await (deps.verify ?? verifyServiceCredential)(
    existing.provider,
    credential,
  );
  const [updated] = await db
    .update(serviceConnections)
    .set({
      ...sealCredential(credential),
      label:
        input.label === undefined
          ? existing.label
          : cleanLabel(input.label, existing.label),
      credentialVersion: existing.credentialVersion + 1,
      status: "active",
      lastVerifiedAt: new Date(),
      metadata,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(serviceConnections.id, existing.id),
        eq(serviceConnections.credentialVersion, existing.credentialVersion),
      ),
    )
    .returning();
  if (!updated)
    throw new Error(
      "This connection changed while the token was being verified. Try again.",
    );
  return toDisplayServiceConnection(updated);
}

/**
 * Re-check the stored credential with the provider. A rejection marks it invalid; a network or
 * provider outage throws without touching the status, since it says nothing about the token.
 */
export async function reverifyServiceConnection(
  input: { orgId: string; id: string },
  deps: ServiceConnectionDeps = {},
): Promise<ServiceConnection> {
  const row = await findRow(input.orgId, input.id);
  if (!row || !isServiceProviderId(row.provider))
    throw new Error("This connection is unavailable in this workspace.");
  const credential = open(secretsKey(), {
    ciphertext: row.credentialCiphertext,
    iv: row.credentialIv,
    authTag: row.credentialAuthTag,
  });
  let verified: VerifiedCredential;
  try {
    verified = await (deps.verify ?? verifyServiceCredential)(
      row.provider,
      credential,
    );
  } catch (error) {
    if (error instanceof ServiceCredentialError) {
      await markServiceConnectionUnusable({
        id: row.id,
        credentialVersion: row.credentialVersion,
        status: "invalid",
      });
    }
    throw error;
  }
  const [updated] = await db
    .update(serviceConnections)
    .set({
      status: "active",
      lastVerifiedAt: new Date(),
      metadata: verified.metadata,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(serviceConnections.id, row.id),
        eq(serviceConnections.credentialVersion, row.credentialVersion),
      ),
    )
    .returning();
  return toDisplayServiceConnection(updated ?? row);
}

/** Linked provisioning rows fall back to "no connection" (FK on delete set null). */
export async function removeServiceConnection(input: {
  orgId: string;
  id: string;
}) {
  const deleted = await db
    .delete(serviceConnections)
    .where(
      and(
        eq(serviceConnections.orgId, input.orgId),
        eq(serviceConnections.id, input.id),
      ),
    )
    .returning({ id: serviceConnections.id });
  return deleted.length > 0;
}

/**
 * SERVER ONLY. The plaintext credential for an outbound provider call. Never return it to a
 * loader, log it, or hand it to an agent. Throws ServiceConnectionUnusableError unless active.
 */
export async function openServiceCredential(input: {
  orgId: string;
  id: string;
  provider: ServiceProviderId;
}): Promise<{ id: string; secret: string; credentialVersion: number }> {
  const row = await findRow(input.orgId, input.id);
  if (!row || row.provider !== input.provider)
    throw new ServiceConnectionUnusableError(
      "missing",
      "The linked connection was removed. Link another one in Setup.",
    );
  if (row.status !== "active")
    throw new ServiceConnectionUnusableError(
      row.status === "expired" ? "expired" : "invalid",
      `The ${row.label} connection was rejected by the provider. Replace its token in Settings → Connections.`,
    );
  return {
    id: row.id,
    secret: open(secretsKey(), {
      ciphertext: row.credentialCiphertext,
      iv: row.credentialIv,
      authTag: row.credentialAuthTag,
    }),
    credentialVersion: row.credentialVersion,
  };
}

/**
 * Record that the provider rejected a credential. Version-guarded: a token replaced while the
 * failing call ran stays active.
 */
export async function markServiceConnectionUnusable(input: {
  id: string;
  credentialVersion: number;
  status: Exclude<ServiceConnectionStatus, "active">;
}) {
  await db
    .update(serviceConnections)
    .set({ status: input.status, updatedAt: new Date() })
    .where(
      and(
        eq(serviceConnections.id, input.id),
        eq(serviceConnections.credentialVersion, input.credentialVersion),
      ),
    );
}

/**
 * Runs `fn` with an open credential; when the provider's failure condemns the credential, marks
 * the connection and rethrows as ServiceConnectionUnusableError.
 */
export async function withServiceCredential<T>(
  connection: { orgId: string; id: string; provider: ServiceProviderId },
  fn: (secret: string) => Promise<T>,
): Promise<T> {
  const credential = await openServiceCredential(connection);
  try {
    return await fn(credential.secret);
  } catch (error) {
    const status = serviceProvider(connection.provider).unusableStatus(error);
    if (!status) throw error;
    await markServiceConnectionUnusable({
      id: credential.id,
      credentialVersion: credential.credentialVersion,
      status,
    });
    throw new ServiceConnectionUnusableError(
      status,
      "The provider rejected the linked connection's token. Replace it in Settings → Connections.",
    );
  }
}
