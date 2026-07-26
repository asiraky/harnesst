/**
 * Storage port for the local SecretsProvider: sealed values + the name index, scoped by
 * (project, agent, environment, key). `agentId = null` is a PROJECT-LEVEL shared secret (§4.2);
 * members opt into it via `secret_attachments`. Splitting this out lets the provider's
 * scoping/override logic (secrets.local.server.ts) be unit-tested against an in-memory KV with
 * real crypto, while the Drizzle impl here owns the two-table persistence (values + metadata),
 * the attachment join at resolve, and the sandbox-exposure allowlist.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  agents,
  pendingSecrets,
  secretAttachments,
  secretRequirementDismissals,
  secretsMetadata,
  secretValues,
} from "~/db/schema";
import type { SecretRef, SecretScope } from "../types";
import type { SealedSecret } from "./secretbox";

/** A sealed value with the scope needed to merge shared + agent + env at resolve time. */
export interface ScopedSealed extends SealedSecret {
  key: string;
  environmentId: string | null;
}

/** Metadata written alongside a value (never the value). */
export interface SecretMeta {
  fingerprint?: string;
  /** Undefined leaves the existing flag untouched (a value replace must not reset exposure). */
  sandboxExposed?: boolean;
  updatedBy?: string | null;
}

export interface SecretKVStore {
  upsert(ref: SecretRef, sealed: SealedSecret, meta?: SecretMeta): Promise<void>;
  getSealed(ref: SecretRef): Promise<SealedSecret | null>;
  delete(ref: SecretRef): Promise<void>;
  /** Keys in an exact scope, sorted (names only, values never listed). */
  listKeys(scope: SecretScope): Promise<string[]>;
  /**
   * Sealed rows for resolve, ordered shared-wide → shared-env → agent-wide → agent-env so the
   * provider's merge loop lets the most-specific write win (§5 precedence).
   */
  listForResolve(scope: SecretScope): Promise<ScopedSealed[]>;
}

/** `agentId = null` matches shared rows; a concrete id matches that member's rows. */
function agentIdEq(column: AnyColumn, id: string | null) {
  return id === null ? isNull(column) : eq(column, id);
}
function metaAgentIdEq(id: string | null) {
  return agentIdEq(secretsMetadata.agentId, id);
}
function envIdEq(column: AnyColumn, id: string | null) {
  return id === null ? isNull(column) : eq(column, id);
}

function valueScope(ref: SecretRef) {
  return and(
    eq(secretValues.projectId, ref.projectId),
    agentIdEq(secretValues.agentId, ref.agentId),
    envIdEq(secretValues.environmentId, ref.environmentId),
    eq(secretValues.key, ref.key),
  );
}

export const drizzleSecretKV: SecretKVStore = {
  async upsert(ref, sealed, meta) {
    await db
      .insert(secretValues)
      .values({
        projectId: ref.projectId,
        agentId: ref.agentId,
        environmentId: ref.environmentId,
        key: ref.key,
        ...sealed,
      })
      .onConflictDoUpdate({
        target: [
          secretValues.projectId,
          secretValues.agentId,
          secretValues.environmentId,
          secretValues.key,
        ],
        set: { ...sealed, updatedAt: new Date() },
      });
    // Keep the name/audit index in sync (never stores the value). Exposure is only written when
    // the caller passes it — a plain value replace leaves the existing flag alone.
    const metaSet: Record<string, unknown> = {
      fingerprint: meta?.fingerprint ?? null,
      updatedBy: meta?.updatedBy ?? null,
      updatedAt: new Date(),
    };
    if (meta?.sandboxExposed !== undefined) metaSet.sandboxExposed = meta.sandboxExposed;
    await db
      .insert(secretsMetadata)
      .values({
        projectId: ref.projectId,
        agentId: ref.agentId,
        environmentId: ref.environmentId,
        key: ref.key,
        fingerprint: meta?.fingerprint ?? null,
        sandboxExposed: meta?.sandboxExposed ?? false,
        updatedBy: meta?.updatedBy ?? null,
      })
      .onConflictDoUpdate({
        target: [
          secretsMetadata.projectId,
          secretsMetadata.agentId,
          secretsMetadata.environmentId,
          secretsMetadata.key,
        ],
        set: metaSet,
      });
  },

  async getSealed(ref) {
    const [row] = await db.select().from(secretValues).where(valueScope(ref)).limit(1);
    return row ? { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag } : null;
  },

  async delete(ref) {
    await db.delete(secretValues).where(valueScope(ref));
    await db
      .delete(secretsMetadata)
      .where(
        and(
          eq(secretsMetadata.projectId, ref.projectId),
          metaAgentIdEq(ref.agentId),
          envIdEq(secretsMetadata.environmentId, ref.environmentId),
          eq(secretsMetadata.key, ref.key),
        ),
      );
  },

  async listKeys(scope) {
    const rows = await db
      .select({ key: secretValues.key })
      .from(secretValues)
      .where(
        and(
          eq(secretValues.projectId, scope.projectId),
          agentIdEq(secretValues.agentId, scope.agentId),
          envIdEq(secretValues.environmentId, scope.environmentId),
        ),
      );
    return rows.map((r) => r.key).sort();
  },

  async listForResolve(scope) {
    const project = eq(secretValues.projectId, scope.projectId);
    const project2 = scope.projectId;

    // The member's own rows: agent-wide first, then this environment's.
    const agentWide = await db
      .select()
      .from(secretValues)
      .where(
        and(project, agentIdEq(secretValues.agentId, scope.agentId), isNull(secretValues.environmentId)),
      );
    const agentEnv = scope.environmentId
      ? await db
          .select()
          .from(secretValues)
          .where(
            and(
              project,
              agentIdEq(secretValues.agentId, scope.agentId),
              eq(secretValues.environmentId, scope.environmentId),
            ),
          )
      : [];

    // Attached shared rows (agentId IS NULL) whose name this member opted into.
    let sharedWide: (typeof agentWide)[number][] = [];
    let sharedEnv: (typeof agentWide)[number][] = [];
    if (scope.agentId) {
      const attachedRows = await db
        .select({ key: secretAttachments.key })
        .from(secretAttachments)
        .where(eq(secretAttachments.agentId, scope.agentId));
      const attachedKeys = attachedRows.map((r) => r.key);
      if (attachedKeys.length > 0) {
        sharedWide = await db
          .select()
          .from(secretValues)
          .where(
            and(
              eq(secretValues.projectId, project2),
              isNull(secretValues.agentId),
              isNull(secretValues.environmentId),
              inArray(secretValues.key, attachedKeys),
            ),
          );
        sharedEnv = scope.environmentId
          ? await db
              .select()
              .from(secretValues)
              .where(
                and(
                  eq(secretValues.projectId, project2),
                  isNull(secretValues.agentId),
                  eq(secretValues.environmentId, scope.environmentId),
                  inArray(secretValues.key, attachedKeys),
                ),
              )
          : [];
      }
    }

    // Order least→most specific so the provider's merge lets later writes override.
    return [...sharedWide, ...sharedEnv, ...agentWide, ...agentEnv].map((r) => ({
      key: r.key,
      environmentId: r.environmentId,
      ciphertext: r.ciphertext,
      iv: r.iv,
      authTag: r.authTag,
    }));
  },
};

// ── Sandbox exposure (metadata, never values) ────────────────────────────────
// The per-secret "available in the agent's sandbox shell" flag lives on the METADATA index,
// not behind the SecretsProvider: it's control-plane policy about a name, so it survives
// provider swaps (KMS/Vault store values, not harnesst decisions) and value rotations. Deploys
// join the exposed names into HARNESST_SANDBOX_ENV (see ~/deploy/controller.server.ts).

function metadataScope(ref: SecretRef) {
  return and(
    eq(secretsMetadata.projectId, ref.projectId),
    metaAgentIdEq(ref.agentId),
    envIdEq(secretsMetadata.environmentId, ref.environmentId),
    eq(secretsMetadata.key, ref.key),
  );
}

/** Flip one secret's sandbox exposure (exact scope — the row the Settings list shows). */
export async function setSecretSandboxExposed(
  ref: SecretRef,
  exposed: boolean,
  updatedBy?: string | null,
): Promise<void> {
  await db
    .update(secretsMetadata)
    .set({ sandboxExposed: exposed, updatedBy: updatedBy ?? null, updatedAt: new Date() })
    .where(metadataScope(ref));
}

/** Exposure flags for a Settings list's exact scope: key → exposed. */
export async function listSandboxExposure(scope: SecretScope): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ key: secretsMetadata.key, exposed: secretsMetadata.sandboxExposed })
    .from(secretsMetadata)
    .where(
      and(
        eq(secretsMetadata.projectId, scope.projectId),
        metaAgentIdEq(scope.agentId),
        envIdEq(secretsMetadata.environmentId, scope.environmentId),
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.key, r.exposed]));
}

/**
 * The §5 sandbox-name rule as a pure function (unit-tested directly): the union of the member's
 * own exposed names and the attachment-exposed names whose shared secret actually exists in scope.
 */
export function computeSandboxNames(input: {
  agentExposed: string[];
  attachmentExposed: string[];
  sharedExisting: string[];
}): string[] {
  const existing = new Set(input.sharedExisting);
  const names = new Set(input.agentExposed);
  for (const key of input.attachmentExposed) if (existing.has(key)) names.add(key);
  return [...names].sort();
}

/**
 * The union of names exposed to the sandbox for a DEPLOY scope (§5):
 *  (a) the member's own exposed rows (agent-wide OR this env), plus
 *  (b) attachment rows flagged exposed whose shared secret actually exists in scope.
 * The controller still filters to names that actually resolved, so exposing a name that has no
 * value forwards nothing. Names only — never values.
 */
export async function listSandboxExposedNames(scope: SecretScope): Promise<string[]> {
  const agentRows = await db
    .select({ key: secretsMetadata.key })
    .from(secretsMetadata)
    .where(
      and(
        eq(secretsMetadata.projectId, scope.projectId),
        metaAgentIdEq(scope.agentId),
        eq(secretsMetadata.sandboxExposed, true),
        scope.environmentId === null
          ? isNull(secretsMetadata.environmentId)
          : sql`(${secretsMetadata.environmentId} is null or ${secretsMetadata.environmentId} = ${scope.environmentId})`,
      ),
    );
  const agentExposed = agentRows.map((r) => r.key);

  let attachmentExposed: string[] = [];
  let sharedExisting: string[] = [];
  if (scope.agentId) {
    const attachRows = await db
      .select({ key: secretAttachments.key })
      .from(secretAttachments)
      .where(
        and(eq(secretAttachments.agentId, scope.agentId), eq(secretAttachments.sandboxExposed, true)),
      );
    attachmentExposed = attachRows.map((r) => r.key);
    if (attachmentExposed.length > 0) {
      const existing = await db
        .select({ key: secretValues.key })
        .from(secretValues)
        .where(
          and(
            eq(secretValues.projectId, scope.projectId),
            isNull(secretValues.agentId),
            inArray(secretValues.key, attachmentExposed),
            scope.environmentId === null
              ? isNull(secretValues.environmentId)
              : sql`(${secretValues.environmentId} is null or ${secretValues.environmentId} = ${scope.environmentId})`,
          ),
        );
      sharedExisting = existing.map((r) => r.key);
    }
  }
  return computeSandboxNames({ agentExposed, attachmentExposed, sharedExisting });
}

// ── Rich metadata reads for the Settings loader ──────────────────────────────

export interface SecretRow {
  key: string;
  environmentId: string | null;
  sandboxExposed: boolean;
  fingerprint: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/** One secret's metadata row (for a fetcher's JSON echo after a set), or null. */
export async function getSecretRow(ref: SecretRef): Promise<SecretRow | null> {
  const [r] = await db
    .select()
    .from(secretsMetadata)
    .where(metadataScope(ref))
    .limit(1);
  if (!r) return null;
  return {
    key: r.key,
    environmentId: r.environmentId,
    sandboxExposed: r.sandboxExposed,
    fingerprint: r.fingerprint,
    updatedAt: new Date(r.updatedAt).toISOString(),
    updatedBy: r.updatedBy,
  };
}

/** Every secret metadata row for a member, across ALL envs (env switching is client-side, §6). */
export async function listAgentSecretRows(
  projectId: string,
  agentId: string,
): Promise<SecretRow[]> {
  const rows = await db
    .select()
    .from(secretsMetadata)
    .where(and(eq(secretsMetadata.projectId, projectId), eq(secretsMetadata.agentId, agentId)));
  return rows.map((r) => ({
    key: r.key,
    environmentId: r.environmentId,
    sandboxExposed: r.sandboxExposed,
    fingerprint: r.fingerprint,
    updatedAt: new Date(r.updatedAt).toISOString(),
    updatedBy: r.updatedBy,
  }));
}

// ── Project-level shared secrets ─────────────────────────────────────────────

export interface SharedSecretRow extends SecretRow {
  /** How many members have attached this name (blast radius for replace/delete). */
  attachCount: number;
}

/** All shared (agentId null) secret rows for a project + per-name attach count. */
export async function listSharedSecrets(projectId: string): Promise<SharedSecretRow[]> {
  const rows = await db
    .select()
    .from(secretsMetadata)
    .where(and(eq(secretsMetadata.projectId, projectId), isNull(secretsMetadata.agentId)));
  const counts = await db
    .select({ key: secretAttachments.key, n: sql<number>`count(*)::int` })
    .from(secretAttachments)
    .where(eq(secretAttachments.projectId, projectId))
    .groupBy(secretAttachments.key);
  const countByKey = new Map(counts.map((c) => [c.key, c.n]));
  return rows.map((r) => ({
    key: r.key,
    environmentId: r.environmentId,
    sandboxExposed: r.sandboxExposed,
    fingerprint: r.fingerprint,
    updatedAt: new Date(r.updatedAt).toISOString(),
    updatedBy: r.updatedBy,
    attachCount: countByKey.get(r.key) ?? 0,
  }));
}

export interface AttachmentRow {
  key: string;
  agentId: string;
  agentName: string;
  sandboxExposed: boolean;
}

/** Every attachment in a project, joined to the member name (for "Used by N agents"). */
export async function listSharedAttachments(projectId: string): Promise<AttachmentRow[]> {
  const rows = await db
    .select({
      key: secretAttachments.key,
      agentId: secretAttachments.agentId,
      agentName: agents.name,
      sandboxExposed: secretAttachments.sandboxExposed,
    })
    .from(secretAttachments)
    .innerJoin(agents, eq(secretAttachments.agentId, agents.id))
    .where(eq(secretAttachments.projectId, projectId));
  return rows;
}

/** This member's attachments: key → per-member sandbox flag. */
export async function listAttachments(
  agentId: string,
): Promise<{ key: string; sandboxExposed: boolean }[]> {
  return db
    .select({ key: secretAttachments.key, sandboxExposed: secretAttachments.sandboxExposed })
    .from(secretAttachments)
    .where(eq(secretAttachments.agentId, agentId));
}

/** Attach or detach a shared secret for a member; attach seeds the per-member sandbox flag. */
export async function setAttachment(input: {
  projectId: string;
  agentId: string;
  key: string;
  attached: boolean;
  sandboxExposed?: boolean;
  createdBy?: string | null;
}): Promise<void> {
  if (!input.attached) {
    await db
      .delete(secretAttachments)
      .where(and(eq(secretAttachments.agentId, input.agentId), eq(secretAttachments.key, input.key)));
    return;
  }
  await db
    .insert(secretAttachments)
    .values({
      projectId: input.projectId,
      agentId: input.agentId,
      key: input.key,
      sandboxExposed: input.sandboxExposed ?? false,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [secretAttachments.agentId, secretAttachments.key],
      set: {
        ...(input.sandboxExposed !== undefined ? { sandboxExposed: input.sandboxExposed } : {}),
      },
    });
}

/**
 * Delete a shared secret ENTIRELY — every env row of the name (values + metadata) plus its
 * attachments (§11.4 cascade). Dependent agents show the name as required-missing afterwards.
 */
export async function deleteSharedSecret(projectId: string, key: string): Promise<void> {
  await db
    .delete(secretValues)
    .where(
      and(
        eq(secretValues.projectId, projectId),
        isNull(secretValues.agentId),
        eq(secretValues.key, key),
      ),
    );
  await db
    .delete(secretsMetadata)
    .where(
      and(
        eq(secretsMetadata.projectId, projectId),
        isNull(secretsMetadata.agentId),
        eq(secretsMetadata.key, key),
      ),
    );
  await db
    .delete(secretAttachments)
    .where(and(eq(secretAttachments.projectId, projectId), eq(secretAttachments.key, key)));
}

/** Members attached to a shared secret name — the delete blast radius. */
export async function attachmentDependents(
  projectId: string,
  key: string,
): Promise<{ agentId: string; agentName: string }[]> {
  const rows = await db
    .select({ agentId: secretAttachments.agentId, agentName: agents.name })
    .from(secretAttachments)
    .innerJoin(agents, eq(secretAttachments.agentId, agents.id))
    .where(and(eq(secretAttachments.projectId, projectId), eq(secretAttachments.key, key)));
  return rows;
}

// ── Dismissed template requirements (§7) ─────────────────────────────────────

/** Names this member marked "not needed" — suppressed from required rows + the deploy guard. */
export async function listDismissedRequirements(agentId: string): Promise<string[]> {
  const rows = await db
    .select({ key: secretRequirementDismissals.key })
    .from(secretRequirementDismissals)
    .where(eq(secretRequirementDismissals.agentId, agentId));
  return rows.map((r) => r.key).sort();
}

export async function setRequirementDismissed(input: {
  projectId: string;
  agentId: string;
  key: string;
  dismissed: boolean;
  createdBy?: string | null;
}): Promise<void> {
  if (!input.dismissed) {
    await db
      .delete(secretRequirementDismissals)
      .where(
        and(
          eq(secretRequirementDismissals.agentId, input.agentId),
          eq(secretRequirementDismissals.key, input.key),
        ),
      );
    return;
  }
  await db
    .insert(secretRequirementDismissals)
    .values({
      projectId: input.projectId,
      agentId: input.agentId,
      key: input.key,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing({
      target: [secretRequirementDismissals.agentId, secretRequirementDismissals.key],
    });
}

// ── Pending install secrets (§4.4) ───────────────────────────────────────────

export interface PendingSecretInput {
  projectId: string;
  memberName: string;
  key: string;
  sealed: SealedSecret;
  /** SHA-256 hex of the held plaintext (null for attach-only rows) — carried at ship (§4.1). */
  fingerprint: string | null;
  sandboxExposed: boolean;
  attachShared: boolean;
  createdBy?: string | null;
}

/** Stash a sealed value for a not-yet-shipped member; upserts on (project, member, key). */
export async function writePendingSecret(input: PendingSecretInput): Promise<void> {
  await db
    .insert(pendingSecrets)
    .values({
      projectId: input.projectId,
      memberName: input.memberName,
      key: input.key,
      ciphertext: input.sealed.ciphertext,
      iv: input.sealed.iv,
      authTag: input.sealed.authTag,
      fingerprint: input.fingerprint,
      sandboxExposed: input.sandboxExposed,
      attachShared: input.attachShared,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [pendingSecrets.projectId, pendingSecrets.memberName, pendingSecrets.key],
      set: {
        ciphertext: input.sealed.ciphertext,
        iv: input.sealed.iv,
        authTag: input.sealed.authTag,
        fingerprint: input.fingerprint,
        sandboxExposed: input.sandboxExposed,
        attachShared: input.attachShared,
      },
    });
}

export interface PendingSecretRow {
  key: string;
  sealed: SealedSecret;
  fingerprint: string | null;
  sandboxExposed: boolean;
  attachShared: boolean;
  createdBy: string | null;
}

/** Held secrets for a not-yet-shipped member. */
export async function listPendingSecrets(
  projectId: string,
  memberName: string,
): Promise<PendingSecretRow[]> {
  const rows = await db
    .select()
    .from(pendingSecrets)
    .where(and(eq(pendingSecrets.projectId, projectId), eq(pendingSecrets.memberName, memberName)));
  return rows.map((r) => ({
    key: r.key,
    sealed: { ciphertext: r.ciphertext, iv: r.iv, authTag: r.authTag },
    fingerprint: r.fingerprint,
    sandboxExposed: r.sandboxExposed,
    attachShared: r.attachShared,
    createdBy: r.createdBy,
  }));
}

/** Roster names in a project that have held pending secrets (for the ship-time sweep). */
export async function listPendingMemberNames(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ memberName: pendingSecrets.memberName })
    .from(pendingSecrets)
    .where(eq(pendingSecrets.projectId, projectId));
  return [...new Set(rows.map((r) => r.memberName))];
}

/** Drop a member's held secrets — on ship-migration or install abandonment. */
export async function deletePendingSecrets(
  projectId: string,
  memberName: string,
): Promise<void> {
  await db
    .delete(pendingSecrets)
    .where(and(eq(pendingSecrets.projectId, projectId), eq(pendingSecrets.memberName, memberName)));
}

/** One held secret by name — used when discarding a single pending value. */
export async function deletePendingSecret(
  projectId: string,
  memberName: string,
  key: string,
): Promise<void> {
  await db
    .delete(pendingSecrets)
    .where(
      and(
        eq(pendingSecrets.projectId, projectId),
        eq(pendingSecrets.memberName, memberName),
        eq(pendingSecrets.key, key),
      ),
    );
}
