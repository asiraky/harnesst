/** Database-backed scope and budget enforcement for assistant eval model calls. */
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { assistantEvalGrants } from "~/db/schema";
import type { ResolvedAgentModel } from "~/models/agent-model-config.server";
import { newId } from "~/lib/id";

export const EVAL_GRANT_TTL_MS = 10 * 60_000;
export const EVAL_MAX_CONCURRENT_CALLS = 4;
export const EVAL_MAX_CALLS = 64;
export const EVAL_MAX_TOKENS = 500_000;
export const EVAL_MAX_OUTPUT_TOKENS_PER_CALL = 16_384;

export type EvalGrant = typeof assistantEvalGrants.$inferSelect;

export class EvalGrantError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 409 | 429,
  ) {
    super(message);
    this.name = "EvalGrantError";
  }
}

export async function createEvalGrant(input: {
  orgId: string;
  projectId: string;
  conversationId: string;
  memberName: string;
  selection: ResolvedAgentModel;
  now?: Date;
}): Promise<EvalGrant> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + EVAL_GRANT_TTL_MS);
  try {
    return await db.transaction(async (tx) => {
      await tx
        .delete(assistantEvalGrants)
        .where(
          and(
            eq(assistantEvalGrants.projectId, input.projectId),
            or(
              lt(assistantEvalGrants.expiresAt, now),
              eq(assistantEvalGrants.expiresAt, now),
              sql`${assistantEvalGrants.revokedAt} is not null`,
            ),
          ),
        );
      const [row] = await tx
        .insert(assistantEvalGrants)
        .values({
          id: newId(),
          orgId: input.orgId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          memberName: input.memberName,
          model: input.selection.model,
          effort: input.selection.effort,
          modelSource: input.selection.source,
          expiresAt,
          maxConcurrentCalls: EVAL_MAX_CONCURRENT_CALLS,
          maxCalls: EVAL_MAX_CALLS,
          maxTokens: EVAL_MAX_TOKENS,
        })
        .returning();
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error, "assistant_eval_grants_project_uq")) {
      throw new EvalGrantError(
        "Another behavioral eval is already running for this project. Wait for it to finish, then retry.",
        409,
      );
    }
    throw error;
  }
}

export async function getActiveEvalGrant(
  grantId: string,
  now = new Date(),
): Promise<EvalGrant> {
  const [row] = await db
    .select()
    .from(assistantEvalGrants)
    .where(eq(assistantEvalGrants.id, grantId))
    .limit(1);
  const error = activeEvalGrantError(row ?? null, now);
  if (error) throw error;
  return row;
}

export function activeEvalGrantError(
  grant: EvalGrant | null,
  now = new Date(),
): EvalGrantError | null {
  if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= now.getTime()) {
    return new EvalGrantError(
      "This eval authorization is invalid, expired, or already cleaned up. Run the eval again from the harnesst assistant.",
      401,
    );
  }
  return null;
}

export function evalGrantLimitError(
  grant: EvalGrant,
  input: { model: string; reservedTokens: number },
): EvalGrantError {
  if (grant.model !== input.model) {
    return new EvalGrantError(
      `This eval is pinned to ${grant.model}; it cannot call ${input.model}.`,
      403,
    );
  }
  if (grant.activeCalls >= grant.maxConcurrentCalls) {
    return new EvalGrantError(
      `This eval has reached its ${grant.maxConcurrentCalls}-call concurrency limit.`,
      429,
    );
  }
  if (grant.usedCalls >= grant.maxCalls) {
    return new EvalGrantError(
      `This eval has exhausted its ${grant.maxCalls}-model-call limit.`,
      429,
    );
  }
  if (grant.reservedTokens + input.reservedTokens <= grant.maxTokens) {
    return new EvalGrantError(
      "This eval's model-call capacity changed concurrently. Retry this assertion once.",
      429,
    );
  }
  return new EvalGrantError(
    `This eval has exhausted its ${grant.maxTokens.toLocaleString()}-token spend limit.`,
    429,
  );
}

/** Atomically reserve one model call and its worst-case token spend. */
export async function beginEvalModelCall(input: {
  grantId: string;
  model: string;
  reservedTokens: number;
  now?: Date;
}): Promise<EvalGrant> {
  const now = input.now ?? new Date();
  const amount = Math.max(1, Math.floor(input.reservedTokens));
  const [row] = await db
    .update(assistantEvalGrants)
    .set({
      activeCalls: sql`${assistantEvalGrants.activeCalls} + 1`,
      usedCalls: sql`${assistantEvalGrants.usedCalls} + 1`,
      reservedTokens: sql`${assistantEvalGrants.reservedTokens} + ${amount}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(assistantEvalGrants.id, input.grantId),
        eq(assistantEvalGrants.model, input.model),
        isNull(assistantEvalGrants.revokedAt),
        gt(assistantEvalGrants.expiresAt, now),
        sql`${assistantEvalGrants.activeCalls} < ${assistantEvalGrants.maxConcurrentCalls}`,
        sql`${assistantEvalGrants.usedCalls} < ${assistantEvalGrants.maxCalls}`,
        sql`${assistantEvalGrants.reservedTokens} + ${amount} <= ${assistantEvalGrants.maxTokens}`,
      ),
    )
    .returning();
  if (row) return row;

  const current = await getActiveEvalGrant(input.grantId, now);
  throw evalGrantLimitError(current, {
    model: input.model,
    reservedTokens: amount,
  });
}

export async function finishEvalModelCall(grantId: string): Promise<void> {
  await db
    .update(assistantEvalGrants)
    .set({
      activeCalls: sql`greatest(${assistantEvalGrants.activeCalls} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(assistantEvalGrants.id, grantId));
}

export async function revokeEvalGrant(grantId: string): Promise<void> {
  await db
    .delete(assistantEvalGrants)
    .where(eq(assistantEvalGrants.id, grantId));
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    const pg = current as Error & { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === constraint) return true;
  }
  return false;
}
