/**
 * Persisted connection grants (issue #30). A row holds an app-scoped OAuth grant for one
 * (project, agent, provider): the sealed refresh token plus display metadata (account email,
 * scopes, status). Written by the connect callback, read by the install wizard / Deployment tab
 * (metadata only) and by deploy (which alone unseals the token). Direct-Drizzle, upsert-on-
 * conflict — mirrors app/discord/connections.server.ts.
 *
 * The refresh token is sealed with the same AES-256-GCM secretbox as `secret_values`. Loader-
 * facing functions NEVER return the plaintext; only `openRefreshToken` unseals, and only
 * deploy-side code calls it.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "~/db/client.server";
import { connectionGrants } from "~/db/schema";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";
import { invalidateCapabilityToken } from "./capability-token-cache.server";

export type GrantStatus = "active" | "expired" | "revoked";

/** Display-safe grant: everything but the sealed token. Safe to return to loaders. */
export interface ConnectionGrant {
  id: string;
  projectId: string;
  agentId: string;
  environmentId: string | null;
  provider: string;
  accountEmail: string | null;
  scopes: string;
  status: GrantStatus;
  /** Per-grant OAuth client from dynamic registration (issue #167); null = operator client. */
  clientId: string | null;
  /**
   * Provider-side resource binding (issue #166): the resource capability calls target (Xero's
   * tenant id). Null for non-capability providers and for capability grants not yet bound
   * (multi-resource accounts pick one post-consent). `resourceName` is display-only.
   */
  resourceId: string | null;
  resourceName: string | null;
  /**
   * When THIS grant was minted (a reconnect refreshes it — see `upsertGrant`). The Connections
   * card compares it against environment creation times to detect stale per-grant client
   * callback coverage (issue #167).
   */
  createdAt: Date;
}

export interface UpsertGrantInput {
  projectId: string;
  agentId: string;
  /** null = all environments (always null in Phase 1). */
  environmentId?: string | null;
  provider: string;
  accountEmail: string | null;
  scopes: string;
  refreshToken: string;
  /** Per-grant OAuth client from dynamic registration (issue #167). */
  clientId?: string | null;
  /** Provider-side resource binding (issue #166); null/absent = unbound. */
  resourceId?: string | null;
  resourceName?: string | null;
  createdBy?: string | null;
}

function secretsKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

function toGrant(row: typeof connectionGrants.$inferSelect): ConnectionGrant {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    environmentId: row.environmentId,
    provider: row.provider,
    accountEmail: row.accountEmail,
    scopes: row.scopes,
    status: row.status as GrantStatus,
    clientId: row.clientId,
    resourceId: row.resourceId,
    resourceName: row.resourceName,
    createdAt: row.createdAt,
  };
}

/**
 * Create or refresh the grant for (project, agent, provider). Seals the refresh token and, on
 * conflict, re-activates the row (a reconnect flips an expired/revoked grant back to "active" and
 * replaces the token + metadata). Returns the display-safe grant.
 *
 * `createdAt` is refreshed on conflict too (issue #167): a reconnect mints a genuinely NEW grant
 * — new token (family) and, for registration providers, a new OAuth client — so the column records
 * when the CURRENT grant was made. Stale-callback-coverage detection compares environment creation
 * times against it, and rotation persistence (`rotateGrantRefreshToken`) deliberately does NOT
 * touch it (a rotation continues the same grant).
 */
export async function upsertGrant(input: UpsertGrantInput): Promise<ConnectionGrant> {
  const sealed = seal(secretsKey(), input.refreshToken);
  const environmentId = input.environmentId ?? null;
  const [row] = await db
    .insert(connectionGrants)
    .values({
      projectId: input.projectId,
      agentId: input.agentId,
      environmentId,
      provider: input.provider,
      accountEmail: input.accountEmail,
      scopes: input.scopes,
      status: "active",
      clientId: input.clientId ?? null,
      resourceId: input.resourceId ?? null,
      resourceName: input.resourceName ?? null,
      refreshTokenCiphertext: sealed.ciphertext,
      refreshTokenIv: sealed.iv,
      refreshTokenAuthTag: sealed.authTag,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [
        connectionGrants.projectId,
        connectionGrants.agentId,
        connectionGrants.environmentId,
        connectionGrants.provider,
      ],
      set: {
        accountEmail: input.accountEmail,
        scopes: input.scopes,
        status: "active",
        clientId: input.clientId ?? null,
        resourceId: input.resourceId ?? null,
        resourceName: input.resourceName ?? null,
        refreshTokenCiphertext: sealed.ciphertext,
        refreshTokenIv: sealed.iv,
        refreshTokenAuthTag: sealed.authTag,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();
  // A reconnect may bind a DIFFERENT vendor account to the same scope: any control-plane-cached
  // capability access token minted under the replaced grant must die with it (issue #166) —
  // otherwise capability calls would ride the old account's token for the rest of its ~30-minute
  // life. No-op for non-capability providers (nothing cached under their scope).
  invalidateCapabilityToken({
    projectId: input.projectId,
    agentId: input.agentId,
    provider: input.provider,
  });
  return toGrant(row);
}

/**
 * Persist a ROTATED refresh token onto its grant (issue #167) — providers like mayi return a new
 * refresh token on every refresh and revoke the whole family on reuse, so the rotated token must
 * replace the stored one before anything else uses it. When `expectedTokenVersion` is given (the
 * `tokenVersion` from `openRefreshToken`), the write is compare-and-set against the token that
 * was actually refreshed (the seal IV, as in `markGrantStatus`): if a concurrent reconnect
 * replaced the grant meanwhile, the stale rotation is DROPPED (returns false) rather than
 * clobbering the fresh grant. Does not touch `createdAt` — a rotation continues the same grant.
 */
export async function rotateGrantRefreshToken(
  id: string,
  refreshToken: string,
  expectedTokenVersion?: string,
): Promise<boolean> {
  const sealed = seal(secretsKey(), refreshToken);
  const rows = await db
    .update(connectionGrants)
    .set({
      refreshTokenCiphertext: sealed.ciphertext,
      refreshTokenIv: sealed.iv,
      refreshTokenAuthTag: sealed.authTag,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectionGrants.id, id),
        ...(expectedTokenVersion !== undefined
          ? [eq(connectionGrants.refreshTokenIv, expectedTokenVersion)]
          : []),
      ),
    )
    .returning({ id: connectionGrants.id });
  return rows.length > 0;
}

/**
 * Bind (or re-bind) a grant's provider-side resource (issue #166) — the post-consent picker's
 * write. Display metadata only from the token's point of view (the resource id is not a secret);
 * the sealed token is untouched.
 */
export async function setGrantResource(
  id: string,
  resourceId: string,
  resourceName: string | null,
): Promise<void> {
  await db
    .update(connectionGrants)
    .set({ resourceId, resourceName, updatedAt: new Date() })
    .where(eq(connectionGrants.id, id));
}

/** The grant for (project, agent, provider) with a null environment (Phase 1 scope). */
export async function findGrant(input: {
  projectId: string;
  agentId: string;
  provider: string;
}): Promise<ConnectionGrant | null> {
  const [row] = await db
    .select()
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.projectId, input.projectId),
        eq(connectionGrants.agentId, input.agentId),
        eq(connectionGrants.provider, input.provider),
        isNull(connectionGrants.environmentId),
      ),
    )
    .limit(1);
  return row ? toGrant(row) : null;
}

/** Every grant for an agent (the Deployment tab's Connections card lists these). */
export async function listGrantsForAgent(
  agentId: string,
): Promise<ConnectionGrant[]> {
  const rows = await db
    .select()
    .from(connectionGrants)
    .where(eq(connectionGrants.agentId, agentId))
    .orderBy(desc(connectionGrants.createdAt));
  return rows.map(toGrant);
}

/**
 * Flip a grant's status (e.g. deploy found the token dead → "expired"). When
 * `expectedTokenVersion` is given (the `tokenVersion` returned by `openRefreshToken`), the flip
 * is compare-and-set against the token that was actually tested: a concurrent reconnect rotates
 * the sealed token (fresh random IV), so a deploy that found the OLD token dead must not expire
 * the row after a NEW valid token landed on it.
 */
export async function markGrantStatus(
  id: string,
  status: GrantStatus,
  expectedTokenVersion?: string,
): Promise<void> {
  await db
    .update(connectionGrants)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(connectionGrants.id, id),
        ...(expectedTokenVersion !== undefined
          ? [eq(connectionGrants.refreshTokenIv, expectedTokenVersion)]
          : []),
      ),
    );
}

/**
 * Unseal a grant's refresh token. DEPLOY-SIDE ONLY — never call from a loader that renders to a
 * client. Takes the full row (via a fresh lookup) so the plaintext never rides on the display type.
 * `tokenVersion` is an opaque per-seal fingerprint (the encryption IV — fresh random bytes on
 * every upsert) for compare-and-set status flips via `markGrantStatus`.
 */
export async function openRefreshToken(input: {
  projectId: string;
  agentId: string;
  provider: string;
}): Promise<{
  grant: ConnectionGrant;
  refreshToken: string;
  tokenVersion: string;
} | null> {
  const [row] = await db
    .select()
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.projectId, input.projectId),
        eq(connectionGrants.agentId, input.agentId),
        eq(connectionGrants.provider, input.provider),
        isNull(connectionGrants.environmentId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const refreshToken = open(secretsKey(), {
    ciphertext: row.refreshTokenCiphertext,
    iv: row.refreshTokenIv,
    authTag: row.refreshTokenAuthTag,
  });
  return { grant: toGrant(row), refreshToken, tokenVersion: row.refreshTokenIv };
}
