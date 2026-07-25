/**
 * Operational audit log (ARCH §3.8). Records deploys, rollbacks, secret changes, and
 * spend-limit edits, keyed by tenant. Better Auth owns authentication state; this is the
 * operations audit harnesst owns.
 */
import { desc, eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { auditLog } from "~/db/schema";

export async function recordAudit(entry: {
  orgId: string;
  actorUserId?: string | null;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLog).values({
    orgId: entry.orgId,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    target: entry.target ?? null,
    meta: entry.meta ?? {},
  });
}

export function listAudit(orgId: string, limit = 100) {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}
