/** Database-backed credentials for harnesst's hosted MCP endpoint. */
import { and, desc, eq, isNull } from "drizzle-orm";

import {
  hashEdnToken,
  isEdnToken,
  mintEdnToken,
  parseEdnAuthorizationHeader,
} from "~/auth/edn-token.server";
import { db } from "~/db/client.server";
import { apiKeys, member } from "~/db/schema";
import { recordAudit } from "~/managed/audit.server";

export const MCP_SCOPES = ["read", "deploy", "author"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface VerifiedApiKey {
  keyId: string;
  orgId: string;
  userId: string;
  scopes: McpScope[];
}

interface ApiKeyRecord extends VerifiedApiKey {
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ApiKeyVerifierDeps {
  now(): Date;
  findByTokenHash(tokenHash: string): Promise<ApiKeyRecord | null>;
  hasMembership(orgId: string, userId: string): Promise<boolean>;
  markUsed(keyId: string, usedAt: Date): Promise<void>;
}

export interface ApiKeyMetadata {
  id: string;
  userId: string;
  name: string;
  scopes: McpScope[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ApiKeyAdminDeps {
  now(): Date;
  mintToken(): string;
  hasMembership(orgId: string, userId: string): Promise<boolean>;
  insert(input: {
    orgId: string;
    userId: string;
    name: string;
    tokenHash: string;
    scopes: McpScope[];
    expiresAt: Date | null;
  }): Promise<{ id: string }>;
  list(orgId: string): Promise<ApiKeyMetadata[]>;
  revoke(
    orgId: string,
    apiKeyId: string,
    revokedAt: Date,
  ): Promise<{
    id: string;
    name: string;
  } | null>;
  audit(input: {
    orgId: string;
    actorUserId: string;
    action: string;
    target: string;
    meta: Record<string, unknown>;
  }): Promise<void>;
}

const defaultVerifierDeps: ApiKeyVerifierDeps = {
  now: () => new Date(),
  async findByTokenHash(tokenHash) {
    const [row] = await db
      .select({
        keyId: apiKeys.id,
        orgId: apiKeys.orgId,
        userId: apiKeys.userId,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.tokenHash, tokenHash))
      .limit(1);
    return row ? { ...row, scopes: row.scopes as McpScope[] } : null;
  },
  async hasMembership(orgId, userId) {
    const [membership] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
      .limit(1);
    return Boolean(membership);
  },
  async markUsed(keyId, usedAt) {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: usedAt })
      .where(eq(apiKeys.id, keyId));
  },
};

const defaultAdminDeps: ApiKeyAdminDeps = {
  now: () => new Date(),
  mintToken: mintEdnToken,
  async hasMembership(orgId, userId) {
    const [membership] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
      .limit(1);
    return Boolean(membership);
  },
  async insert(input) {
    const [row] = await db
      .insert(apiKeys)
      .values(input)
      .returning({ id: apiKeys.id });
    if (!row) throw new Error("Failed to create API key.");
    return row;
  },
  async list(orgId) {
    const rows = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        name: apiKeys.name,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.orgId, orgId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map((row) => ({ ...row, scopes: row.scopes as McpScope[] }));
  },
  async revoke(orgId, apiKeyId, revokedAt) {
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt })
      .where(
        and(
          eq(apiKeys.id, apiKeyId),
          eq(apiKeys.orgId, orgId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id, name: apiKeys.name });
    return row ?? null;
  },
  audit: recordAudit,
};

function normalizeScopes(scopes: readonly McpScope[]): McpScope[] {
  const unique = [...new Set(scopes)];
  if (unique.length === 0)
    throw new Error("At least one API key scope is required.");
  if (unique.some((scope) => !MCP_SCOPES.includes(scope))) {
    throw new Error("Invalid API key scope.");
  }
  return unique;
}

/** Mint an API key. The plaintext credential is returned once and never persisted. */
export async function createApiKey(
  input: {
    orgId: string;
    userId: string;
    name: string;
    scopes: readonly McpScope[];
    expiresAt?: Date | null;
  },
  deps: ApiKeyAdminDeps = defaultAdminDeps,
): Promise<{ id: string; token: string }> {
  const scopes = normalizeScopes(input.scopes);
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && expiresAt.getTime() <= deps.now().getTime()) {
    throw new Error("API key expiry must be in the future.");
  }

  if (!(await deps.hasMembership(input.orgId, input.userId))) {
    throw new Error("The API key user is not a member of this organization.");
  }

  const token = deps.mintToken();
  const row = await deps.insert({
    orgId: input.orgId,
    userId: input.userId,
    name: input.name,
    tokenHash: hashEdnToken(token),
    scopes,
    expiresAt,
  });

  await deps.audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "api_key.created",
    target: row.id,
    meta: {
      name: input.name,
      scopes,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });
  return { id: row.id, token };
}

/** Metadata only; hashes and plaintext credentials are never returned. */
export function listApiKeys(
  orgId: string,
  deps: ApiKeyAdminDeps = defaultAdminDeps,
) {
  return deps.list(orgId);
}

/** Revoke an active org-owned key and audit the operation. */
export async function revokeApiKey(
  input: {
    orgId: string;
    apiKeyId: string;
    actorUserId: string;
  },
  deps: ApiKeyAdminDeps = defaultAdminDeps,
): Promise<boolean> {
  const row = await deps.revoke(input.orgId, input.apiKeyId, deps.now());
  if (!row) return false;

  await deps.audit({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action: "api_key.revoked",
    target: row.id,
    meta: { name: row.name },
  });
  return true;
}

/**
 * Verify an API credential, its requested scopes, and the issuing user's current membership.
 * Invalid, expired, revoked, under-scoped, and orphaned credentials all fail closed as `null`.
 */
export async function verifyApiKey(
  authorizationHeader: string | null,
  requiredScopes: McpScope | readonly McpScope[],
  deps: ApiKeyVerifierDeps = defaultVerifierDeps,
): Promise<VerifiedApiKey | null> {
  const token = parseEdnAuthorizationHeader(authorizationHeader);
  if (!token) return null;
  if (!isEdnToken(token)) return null;
  const row = await deps.findByTokenHash(hashEdnToken(token));
  if (!row) return null;

  const now = deps.now();
  if (
    row.revokedAt ||
    (row.expiresAt && row.expiresAt.getTime() <= now.getTime())
  ) {
    return null;
  }
  const required = Array.isArray(requiredScopes)
    ? requiredScopes
    : [requiredScopes];
  if (required.some((scope) => !row.scopes.includes(scope))) return null;
  if (!(await deps.hasMembership(row.orgId, row.userId))) return null;

  await deps.markUsed(row.keyId, now);
  return {
    keyId: row.keyId,
    orgId: row.orgId,
    userId: row.userId,
    scopes: row.scopes,
  };
}

/** Authenticate a Bearer request with the same parser as the ingest endpoint. */
export function verifyApiKeyRequest(
  request: Request,
  requiredScopes: McpScope | readonly McpScope[],
): Promise<VerifiedApiKey | null> {
  return verifyApiKey(request.headers.get("authorization"), requiredScopes);
}
