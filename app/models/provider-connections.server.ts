/**
 * Model-provider connections accessor (issue #28) — display-safe CRUD plus server-only
 * credential access for catalogs, deployments, and the Codex gateway.
 *
 * A row holds either an AES-256-GCM sealed API key (OpenRouter, Anthropic, OpenAI Platform) or a
 * sealed OAuth token pair (Codex). Loader-facing functions return ONLY display metadata.
 *
 * Refresh is central: `getFreshAccessToken` refreshes when the access token is within 5 minutes of
 * expiry, single-flighted per connection (the control plane is one process, so an in-process
 * promise map collapses concurrent gateway requests onto one refresh) and always persists a rotated
 * refresh token. A dead grant marks the connection `expired` and throws `InvalidGrantError`.
 */
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  modelProviderConnections,
  modelConnectionAliases,
  auditLog,
} from "~/db/schema";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";
import {
  InvalidGrantError,
  refreshCodexTokens,
} from "~/connections/codex.server";
import { validateProviderApiKey } from "~/models/provider-catalog.server";
import {
  MODEL_PROVIDERS,
  isApiKeyProviderId,
  isProviderConnectionId,
  isModelProviderId,
  providerConnectionApiKeyEnvName,
  type ApiKeyProviderId,
  type ModelProviderId,
} from "~/models/provider-reference";

export type ConnectionStatus = "active" | "expired" | "revoked";

/** Display-safe connection — everything but the sealed tokens. Safe to return to loaders. */
export interface ModelConnection {
  id: string;
  provider: ModelProviderId;
  label: string;
  accountEmail: string | null;
  status: ConnectionStatus;
  createdAt: Date;
}

/** Gateway-side view including the unsealed tokens. NEVER return this to a loader/client. */
export interface GatewayConnection {
  credentialVersion: number;
  id: string;
  orgId: string;
  provider: ModelProviderId;
  status: ConnectionStatus;
  accountId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

function secretsKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

export function toDisplayModelConnection(
  row: typeof modelProviderConnections.$inferSelect,
): ModelConnection {
  if (!isModelProviderId(row.provider)) {
    throw new Error(`Unknown model provider on connection ${row.id}.`);
  }
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    accountEmail: row.accountEmail,
    status: row.status as ConnectionStatus,
    createdAt: row.createdAt,
  };
}

export interface SealedApiKeyCredential {
  apiKeyCiphertext: string;
  apiKeyIv: string;
  apiKeyAuthTag: string;
}

/** Pure credential boundary used by API-key create/read paths. */
export function sealApiKeyCredential(
  apiKey: string,
  key: Buffer = secretsKey(),
): SealedApiKeyCredential {
  const value = seal(key, apiKey);
  return {
    apiKeyCiphertext: value.ciphertext,
    apiKeyIv: value.iv,
    apiKeyAuthTag: value.authTag,
  };
}

/** Server-only inverse of `sealApiKeyCredential`. Incomplete triplets are rejected as absent. */
export function openApiKeyCredential(
  value: {
    apiKeyCiphertext: string | null;
    apiKeyIv: string | null;
    apiKeyAuthTag: string | null;
  },
  key: Buffer = secretsKey(),
): string | null {
  return openSealed(key, {
    ciphertext: value.apiKeyCiphertext,
    iv: value.apiKeyIv,
    authTag: value.apiKeyAuthTag,
  });
}

function openSealed(
  key: Buffer,
  value: {
    ciphertext: string | null;
    iv: string | null;
    authTag: string | null;
  },
): string | null {
  if (!value.ciphertext || !value.iv || !value.authTag) return null;
  return open(key, {
    ciphertext: value.ciphertext,
    iv: value.iv,
    authTag: value.authTag,
  });
}

/** Validate and create an active API-key connection. The plaintext key is never persisted. */
export async function createApiKeyConnection(
  input: {
    orgId: string;
    provider: ApiKeyProviderId;
    label: string;
    apiKey: string;
    createdBy?: string | null;
    connectionId?: string;
  },
  deps: { validate?: typeof validateProviderApiKey } = {},
): Promise<ModelConnection> {
  if (!isApiKeyProviderId(input.provider)) {
    throw new Error("This provider does not accept API-key connections.");
  }
  const [existing] = input.connectionId
    ? await db
        .select()
        .from(modelProviderConnections)
        .where(
          and(
            eq(modelProviderConnections.orgId, input.orgId),
            eq(modelProviderConnections.id, input.connectionId),
            eq(modelProviderConnections.provider, input.provider),
          ),
        )
    : [];
  if (input.connectionId && !existing)
    throw new Error(
      "This provider connection is unavailable in this workspace.",
    );
  const apiKey = input.apiKey.trim();
  await (deps.validate ?? validateProviderApiKey)(input.provider, apiKey);
  const sealed = sealApiKeyCredential(apiKey);
  if (existing) {
    const [updated] = await db
      .update(modelProviderConnections)
      .set({
        ...sealed,
        label: input.label,
        authorizationVersion: existing.authorizationVersion + 1,
        status: "active",
        credentialVersion: existing.credentialVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(modelProviderConnections.id, existing.id),
          eq(
            modelProviderConnections.credentialVersion,
            existing.credentialVersion,
          ),
        ),
      )
      .returning();
    if (!updated)
      throw new Error(
        "This connection changed while the key was being validated. Try again.",
      );
    return toDisplayModelConnection(updated);
  }
  const [row] = await db
    .insert(modelProviderConnections)
    .values({
      orgId: input.orgId,
      provider: input.provider,
      label: input.label,
      apiKeyCiphertext: sealed.apiKeyCiphertext,
      apiKeyIv: sealed.apiKeyIv,
      apiKeyAuthTag: sealed.apiKeyAuthTag,
      status: "active",
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return toDisplayModelConnection(row);
}

type ConnectionTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/** Serialize account matching within a workspace, including concurrent first-time connects. */
export async function createCodexConnection(
  input: {
    orgId: string;
    label: string;
    accountEmail: string | null;
    accountId: string | null;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date | null;
    createdBy?: string | null;
    connectionId?: string;
    authorizationVersion?: number;
    verifiedAccount?: boolean;
    accountIdAliases?: string[];
    connectionVersions?: Record<string, number>;
  },
  transaction?: ConnectionTransaction,
): Promise<ModelConnection> {
  if (
    !input.accessToken ||
    !input.refreshToken ||
    !input.accountId ||
    !input.expiresAt ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt <= new Date()
  ) {
    throw new Error(
      "OpenAI did not return a complete grant and account identity. Existing credentials have not changed; try signing in again.",
    );
  }
  const save = async (tx: ConnectionTransaction) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.orgId}), 391)`,
    );
    const rows = await tx
      .select()
      .from(modelProviderConnections)
      .where(
        and(
          eq(modelProviderConnections.orgId, input.orgId),
          eq(modelProviderConnections.provider, "codex"),
        ),
      )
      .for("update");
    const matching = rows.filter((row) => row.accountId === input.accountId);
    // A historical null/organization identity cannot safely match a new grant automatically.
    // Resolve it through explicit reauthentication before inserting another logical connection.
    if (
      !input.connectionId &&
      matching.length === 0 &&
      rows.some(
        (row) =>
          row.accountId === null ||
          input.accountIdAliases?.includes(row.accountId),
      )
    ) {
      throw new Error(
        "This Codex connection may already exist under a legacy account identity. Choose Reauthenticate on the existing connection and verify its account before connecting another account.",
      );
    }
    const target = input.connectionId
      ? rows.find((row) => row.id === input.connectionId)
      : matching[0];
    if (input.connectionId && !target)
      throw new Error(
        "This Codex connection is unavailable in this workspace.",
      );
    if (
      target &&
      target.accountId !== input.accountId &&
      !(
        input.verifiedAccount &&
        (target.accountId === null ||
          input.accountIdAliases?.includes(target.accountId))
      )
    ) {
      throw new Error(
        "Sign in to the same OpenAI account as this connection. No credentials or selections were changed.",
      );
    }
    if (!input.connectionId && matching.length > 1) {
      throw new Error(
        "Several connections use this OpenAI account. Close this dialog and choose Reauthenticate on the connection you want to renew.",
      );
    }
    const expectedVersion = input.connectionId
      ? input.authorizationVersion
      : target && input.connectionVersions
        ? input.connectionVersions[target.id]
        : undefined;
    if (
      target &&
      ((input.connectionVersions !== undefined &&
        expectedVersion === undefined) ||
        (expectedVersion !== undefined &&
          target.authorizationVersion !== expectedVersion))
    ) {
      throw new Error(
        "This connection changed during sign-in. Close this dialog and try again.",
      );
    }
    const access = seal(secretsKey(), input.accessToken);
    const refresh = seal(secretsKey(), input.refreshToken);
    const credentials = {
      accountEmail: input.accountEmail,
      accountId: input.accountId,
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenAuthTag: refresh.authTag,
      accessTokenExpiresAt: input.expiresAt,
      status: "active",
      updatedAt: new Date(),
    };
    const [row] = target
      ? await tx
          .update(modelProviderConnections)
          .set({
            ...credentials,
            credentialVersion: target.credentialVersion + 1,
            authorizationVersion: target.authorizationVersion + 1,
          })
          .where(eq(modelProviderConnections.id, target.id))
          .returning()
      : await tx
          .insert(modelProviderConnections)
          .values({
            ...credentials,
            orgId: input.orgId,
            provider: "codex",
            label: input.label,
            accountId: input.accountId,
            createdBy: input.createdBy ?? null,
          })
          .returning();
    return toDisplayModelConnection(row);
  };
  return transaction ? save(transaction) : db.transaction(save);
}

/** Resolve only explicit recovery mappings; never substitute the workspace default. */
export async function resolveModelConnectionId(
  orgId: string,
  id: string,
): Promise<string> {
  const [alias] = await db
    .select()
    .from(modelConnectionAliases)
    .where(
      and(
        eq(modelConnectionAliases.orgId, orgId),
        eq(modelConnectionAliases.oldId, id),
      ),
    )
    .limit(1);
  return alias?.connectionId ?? id;
}

export async function recoverDeletedCodexConnection(input: {
  orgId: string;
  oldId: string;
  connectionId: string;
  verifiedBy: string;
  verified: boolean;
}): Promise<void> {
  if (!input.verified || !isProviderConnectionId(input.oldId)) {
    throw new Error(
      "Enter the deleted connection ID and confirm you verified the original OpenAI account.",
    );
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.orgId}), 391)`,
    );
    const [existing] = await tx
      .select()
      .from(modelProviderConnections)
      .where(
        and(
          eq(modelProviderConnections.orgId, input.orgId),
          eq(modelProviderConnections.id, input.oldId),
        ),
      );
    if (existing)
      throw new Error(
        "That connection still exists. Reauthenticate it directly.",
      );
    const [target] = await tx
      .select()
      .from(modelProviderConnections)
      .where(
        and(
          eq(modelProviderConnections.orgId, input.orgId),
          eq(modelProviderConnections.id, input.connectionId),
          eq(modelProviderConnections.provider, "codex"),
          eq(modelProviderConnections.status, "active"),
        ),
      )
      .for("update");
    if (!target?.accountId)
      throw new Error(
        "Choose an active Codex connection with a verified provider account ID.",
      );
    const [alias] = await tx
      .select()
      .from(modelConnectionAliases)
      .where(
        and(
          eq(modelConnectionAliases.orgId, input.orgId),
          eq(modelConnectionAliases.oldId, input.oldId),
        ),
      );
    if (alias)
      throw new Error("That deleted ID already has a recovery mapping.");
    await tx.insert(modelConnectionAliases).values(input);
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      actorUserId: input.verifiedBy,
      action: "model_provider_recovery_verified",
      target: input.oldId,
      meta: { connectionId: target.id, accountId: target.accountId },
    });
  });
}

/** Recovery mappings are managed separately from selectable connections. */
export async function listModelConnectionAliases(
  orgId: string,
): Promise<{ oldConnectionId: string; connectionId: string }[]> {
  return db
    .select({
      oldConnectionId: modelConnectionAliases.oldId,
      connectionId: modelConnectionAliases.connectionId,
    })
    .from(modelConnectionAliases)
    .where(eq(modelConnectionAliases.orgId, orgId));
}

export async function deleteModelConnectionAlias(
  orgId: string,
  oldConnectionId: string,
): Promise<boolean> {
  const rows = await db
    .delete(modelConnectionAliases)
    .where(
      and(
        eq(modelConnectionAliases.orgId, orgId),
        eq(modelConnectionAliases.oldId, oldConnectionId),
      ),
    )
    .returning({ id: modelConnectionAliases.oldId });
  return rows.length === 1;
}

/** Every connection for an org, newest first — display metadata only. */
export async function listModelConnections(
  orgId: string,
): Promise<ModelConnection[]> {
  const rows = await db
    .select()
    .from(modelProviderConnections)
    .where(eq(modelProviderConnections.orgId, orgId))
    .orderBy(desc(modelProviderConnections.createdAt));
  return rows.map(toDisplayModelConnection);
}

/** Every active connection for an org, oldest/id first for deterministic credential aliases. */
export async function listActiveModelConnections(
  orgId: string,
): Promise<ModelConnection[]> {
  const rows = await db
    .select()
    .from(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.orgId, orgId),
        eq(modelProviderConnections.status, "active"),
      ),
    )
    .orderBy(
      asc(modelProviderConnections.createdAt),
      asc(modelProviderConnections.id),
    );
  return rows.map(toDisplayModelConnection);
}

/** Resolve one exact active connection, scoped to its owning org. */
export async function getActiveModelConnection(
  orgId: string,
  id: string,
): Promise<ModelConnection | null> {
  const resolvedId = await resolveModelConnectionId(orgId, id);
  const [row] = await db
    .select()
    .from(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.id, resolvedId),
        eq(modelProviderConnections.orgId, orgId),
        eq(modelProviderConnections.status, "active"),
      ),
    )
    .limit(1);
  return row ? { ...toDisplayModelConnection(row), id } : null;
}

/** Active Codex connections for an org (drives the model-picker union + gateway injection). */
export async function listActiveCodexConnections(
  orgId: string,
): Promise<ModelConnection[]> {
  const rows = await db
    .select()
    .from(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.orgId, orgId),
        eq(modelProviderConnections.provider, "codex"),
        eq(modelProviderConnections.status, "active"),
      ),
    )
    .orderBy(desc(modelProviderConnections.createdAt));
  return rows.map(toDisplayModelConnection);
}

/** Whether the org has at least one active Codex connection (deploy-injection gate). */
export async function hasActiveCodexConnection(
  orgId: string,
): Promise<boolean> {
  const rows = await listActiveCodexConnections(orgId);
  return rows.length > 0;
}

/** Rename a connection, org-checked (a mismatched org is a no-op). */
export async function renameModelConnection(
  orgId: string,
  id: string,
  label: string,
): Promise<void> {
  await db
    .update(modelProviderConnections)
    .set({ label, updatedAt: new Date() })
    .where(
      and(
        eq(modelProviderConnections.id, id),
        eq(modelProviderConnections.orgId, orgId),
      ),
    );
}

/** Disconnect credentials while retaining identity and every model/effort reference. */
export async function disconnectModelConnection(
  orgId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(modelProviderConnections)
    .set({
      status: "revoked",
      authorizationVersion: sql`${modelProviderConnections.authorizationVersion} + 1`,
      credentialVersion: sql`${modelProviderConnections.credentialVersion} + 1`,
      apiKeyCiphertext: null,
      apiKeyIv: null,
      apiKeyAuthTag: null,
      accessTokenCiphertext: null,
      accessTokenIv: null,
      accessTokenAuthTag: null,
      refreshTokenCiphertext: null,
      refreshTokenIv: null,
      refreshTokenAuthTag: null,
      accessTokenExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(modelProviderConnections.orgId, orgId),
        eq(modelProviderConnections.id, id),
        ne(modelProviderConnections.status, "revoked"),
      ),
    )
    .returning({ id: modelProviderConnections.id });
  return rows.length === 1;
}

/** Permanent deletion is explicit; retained references become unavailable instead of switching accounts. */
export async function deleteModelConnection(
  orgId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.orgId, orgId),
        eq(modelProviderConnections.id, id),
      ),
    )
    .returning({ id: modelProviderConnections.id });
  return rows.length === 1;
}

/** Compare-and-swap prevents a stale refresh failure from expiring a renewed grant. */
export async function markConnectionStatus(
  id: string,
  status: ConnectionStatus,
  version: number,
): Promise<boolean> {
  const rows = await db
    .update(modelProviderConnections)
    .set({
      status,
      updatedAt: new Date(),
      credentialVersion: sql`${modelProviderConnections.credentialVersion} + 1`,
    })
    .where(
      and(
        eq(modelProviderConnections.id, id),
        eq(modelProviderConnections.credentialVersion, version),
      ),
    )
    .returning({ id: modelProviderConnections.id });
  return rows.length === 1;
}

/** Server-only view of one API-key connection. Never return this object from a loader. */
export interface ApiKeyConnectionSecret {
  id: string;
  orgId: string;
  provider: ApiKeyProviderId;
  apiKey: string;
  credentialVersion?: number;
}

/** Pure env projection; input order decides each provider's conventional default alias. */
export function buildProviderDeploymentEnv(
  connections: ApiKeyConnectionSecret[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const connection of connections) {
    const exactName = providerConnectionApiKeyEnvName(
      connection.provider,
      connection.id,
    );
    if (!exactName) continue;
    result[exactName] = connection.apiKey;
    const standardName = MODEL_PROVIDERS[connection.provider].standardEnv;
    if (standardName && result[standardName] === undefined) {
      result[standardName] = connection.apiKey;
    }
  }
  return result;
}

/** Unseal one exact active API-key connection after checking its workspace ownership. */
export async function getApiKeyConnection(
  orgId: string,
  id: string,
): Promise<ApiKeyConnectionSecret | null> {
  const [row] = await db
    .select()
    .from(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.id, id),
        eq(modelProviderConnections.orgId, orgId),
        eq(modelProviderConnections.status, "active"),
      ),
    )
    .limit(1);
  if (!row || !isApiKeyProviderId(row.provider)) return null;
  const apiKey = openApiKeyCredential(row);
  return apiKey
    ? {
        id: row.id,
        orgId: row.orgId,
        provider: row.provider,
        apiKey,
        credentialVersion: row.credentialVersion,
      }
    : null;
}

/**
 * Runtime credentials for every active API-key connection in an org. Exact variables support
 * switching between same-provider connections; the oldest/id-first connection also receives the
 * provider's conventional variable for compatibility with provider SDK defaults.
 */
export async function getProviderDeploymentEnv(
  orgId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.orgId, orgId),
        eq(modelProviderConnections.status, "active"),
      ),
    )
    .orderBy(
      asc(modelProviderConnections.createdAt),
      asc(modelProviderConnections.id),
    );
  const connections: ApiKeyConnectionSecret[] = [];
  let key: Buffer | null = null;

  for (const row of rows) {
    if (!isApiKeyProviderId(row.provider)) continue;
    const exactName = providerConnectionApiKeyEnvName(row.provider, row.id);
    if (!exactName) continue;
    key ??= secretsKey();
    const apiKey = openApiKeyCredential(row, key);
    if (!apiKey) continue;
    connections.push({
      id: row.id,
      orgId: row.orgId,
      provider: row.provider,
      apiKey,
    });
  }
  return buildProviderDeploymentEnv(connections);
}

/** Load a connection with its tokens unsealed. Gateway/refresh-side only. */
export async function getConnectionForGateway(
  id: string,
): Promise<GatewayConnection | null> {
  const [row] = await db
    .select()
    .from(modelProviderConnections)
    .where(eq(modelProviderConnections.id, id))
    .limit(1);
  if (!row) return null;
  const key = secretsKey();
  const accessToken = openSealed(key, {
    ciphertext: row.accessTokenCiphertext,
    iv: row.accessTokenIv,
    authTag: row.accessTokenAuthTag,
  });
  const refreshToken = openSealed(key, {
    ciphertext: row.refreshTokenCiphertext,
    iv: row.refreshTokenIv,
    authTag: row.refreshTokenAuthTag,
  });
  if (!isModelProviderId(row.provider)) {
    throw new Error(`Unknown model provider on connection ${row.id}.`);
  }
  return {
    credentialVersion: row.credentialVersion,
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    status: row.status as ConnectionStatus,
    accountId: row.accountId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  };
}

/** Persist tokens after a refresh, sealing both. Keeps status active. */
export async function persistRefreshedTokens(
  id: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date | null },
  version: number,
): Promise<boolean> {
  const key = secretsKey();
  const access = seal(key, tokens.accessToken);
  const refresh = seal(key, tokens.refreshToken);
  const rows = await db
    .update(modelProviderConnections)
    .set({
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenAuthTag: refresh.authTag,
      accessTokenExpiresAt: tokens.expiresAt,
      status: "active",
      credentialVersion: sql`${modelProviderConnections.credentialVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(modelProviderConnections.id, id),
        eq(modelProviderConnections.credentialVersion, version),
      ),
    )
    .returning({ id: modelProviderConnections.id });
  return rows.length === 1;
}

/** Refresh when the access token is within this margin of expiry. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A fresh access token + the account-id header value the gateway needs for a connection. */
export interface FreshAccess {
  credentialVersion: number;
  accessToken: string;
  accountId: string | null;
}

// Single-flight: collapse concurrent refreshes of one connection onto a single upstream call.
const inflightRefresh = new Map<string, Promise<FreshAccess>>();

/**
 * Return a valid access token for a connection, refreshing (once, single-flighted) when it is
 * within REFRESH_MARGIN_MS of expiry or already expired. On `invalid_grant` the connection is
 * marked `expired` and `InvalidGrantError` is rethrown so the gateway can tell the user to
 * reconnect. `deps` is injected in tests to count refresh calls / avoid real I/O.
 */
export async function getFreshAccessToken(
  connectionId: string,
  deps: {
    load?: typeof getConnectionForGateway;
    refresh?: typeof refreshCodexTokens;
    persist?: (
      ...args: Parameters<typeof persistRefreshedTokens>
    ) => Promise<boolean | void>;
    markStatus?: (
      ...args: Parameters<typeof markConnectionStatus>
    ) => Promise<boolean | void>;
    now?: () => number;
  } = {},
): Promise<FreshAccess> {
  const load = deps.load ?? getConnectionForGateway;
  const refresh = deps.refresh ?? refreshCodexTokens;
  const persist = deps.persist ?? persistRefreshedTokens;
  const markStatus = deps.markStatus ?? markConnectionStatus;
  const now = deps.now ?? Date.now;

  const conn = await load(connectionId);
  if (!conn) throw new Error("Connection not found.");
  if (conn.status !== "active") {
    throw new InvalidGrantError(
      "This provider connection is no longer active — reconnect it in Org settings.",
    );
  }

  const expiresAt = conn.accessTokenExpiresAt?.getTime() ?? 0;
  const fresh =
    conn.accessToken != null && expiresAt - now() > REFRESH_MARGIN_MS;
  if (fresh && conn.accessToken) {
    return {
      accessToken: conn.accessToken,
      accountId: conn.accountId,
      credentialVersion: conn.credentialVersion,
    };
  }

  const refreshKey = `${connectionId}:${conn.credentialVersion}`;
  const existing = inflightRefresh.get(refreshKey);
  if (existing) return existing;

  const currentAccess = async (): Promise<FreshAccess> => {
    const current = await load(connectionId);
    if (!current || current.status !== "active" || !current.accessToken) {
      throw new InvalidGrantError(
        "Reauthenticate OpenAI Codex in workspace connections.",
      );
    }
    return {
      accessToken: current.accessToken,
      accountId: current.accountId,
      credentialVersion: current.credentialVersion,
    };
  };
  const run = (async (): Promise<FreshAccess> => {
    try {
      if (!conn.refreshToken) {
        throw new InvalidGrantError(
          "This provider connection has no refresh token — reconnect it in Org settings.",
        );
      }
      const tokens = await refresh(conn.refreshToken);
      const expiry = new Date(now() + tokens.expiresIn * 1000);
      const saved = await persist(
        connectionId,
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || conn.refreshToken,
          expiresAt: expiry,
        },
        conn.credentialVersion,
      );
      if (saved === false) return currentAccess();
      return {
        accessToken: tokens.accessToken,
        accountId: conn.accountId,
        credentialVersion: conn.credentialVersion + 1,
      };
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        if (
          (await markStatus(
            connectionId,
            "expired",
            conn.credentialVersion,
          )) === false
        )
          return currentAccess();
      }
      throw error;
    } finally {
      inflightRefresh.delete(refreshKey);
    }
  })();
  inflightRefresh.set(refreshKey, run);
  return run;
}
