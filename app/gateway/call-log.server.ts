/**
 * Persistence for the gateway call log and Codex plan headroom (issue #416).
 *
 * Every function here is best-effort: the route calls them after the response is under way and
 * never awaits them on the response path, and a failure is logged, never surfaced to the caller.
 */
import { eq, inArray, lt } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  codexRateLimits,
  codexRateLimitSamples,
  gatewayCalls,
} from "~/db/schema";
import { getProject } from "~/db/queries.server";
import { verifiedProjectId } from "./call-identity";
import type { GatewayCallRow } from "./call-record";
import {
  rateLimitsChanged,
  type CodexRateLimits,
  type RateLimitWindow,
} from "./rate-limits";

async function projectInOrg(orgId: string, projectId: string) {
  return !!(await getProject(orgId, projectId));
}

/** Insert one call row, keeping its project only when it belongs to the row's org. */
export async function writeGatewayCall(row: GatewayCallRow): Promise<void> {
  try {
    const projectId = await verifiedProjectId(
      row.orgId,
      row.projectId,
      projectInOrg,
    );
    await db.insert(gatewayCalls).values({
      ...row,
      projectId,
      composition: row.composition as unknown as Record<string, unknown>,
    });
  } catch (error) {
    console.error("[gateway] failed to write the call log row", error);
  }
}

function resetDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}

function columns(limits: CodexRateLimits) {
  const w = (window: RateLimitWindow | null) => ({
    usedPercent: window?.usedPercent ?? null,
    windowMinutes: window?.windowMinutes ?? null,
    resetsAt: resetDate(window?.resetsAt),
  });
  const primary = w(limits.primary);
  const secondary = w(limits.secondary);
  return {
    primaryUsedPercent: primary.usedPercent,
    primaryWindowMinutes: primary.windowMinutes,
    primaryResetsAt: primary.resetsAt,
    secondaryUsedPercent: secondary.usedPercent,
    secondaryWindowMinutes: secondary.windowMinutes,
    secondaryResetsAt: secondary.resetsAt,
  };
}

type StoredRateLimits = typeof codexRateLimits.$inferSelect;

function storedToLimits(row: StoredRateLimits): CodexRateLimits {
  const window = (
    usedPercent: number | null,
    windowMinutes: number | null,
    resetsAt: Date | null,
  ): RateLimitWindow | null =>
    usedPercent === null
      ? null
      : {
          usedPercent,
          windowMinutes,
          resetsAt: resetsAt ? Math.round(resetsAt.getTime() / 1000) : null,
        };
  return {
    primary: window(
      row.primaryUsedPercent,
      row.primaryWindowMinutes,
      row.primaryResetsAt,
    ),
    secondary: window(
      row.secondaryUsedPercent,
      row.secondaryWindowMinutes,
      row.secondaryResetsAt,
    ),
  };
}

/**
 * Store the latest headroom for a connection; add a sample when a value changed. Calls on one
 * connection overlap (an org's agents share it), so the read and write happen under a row lock,
 * and an observation older than the stored one is dropped rather than overwriting it.
 */
export async function recordRateLimits(input: {
  orgId: string;
  connectionId: string;
  limits: CodexRateLimits;
  observedAt?: Date;
}): Promise<void> {
  const observedAt = input.observedAt ?? new Date();
  const values = columns(input.limits);
  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(codexRateLimits)
        .where(eq(codexRateLimits.connectionId, input.connectionId))
        .limit(1)
        .for("update");
      if (current && current.observedAt > observedAt) return;
      if (current && !rateLimitsChanged(storedToLimits(current), input.limits)) {
        await tx
          .update(codexRateLimits)
          .set({ observedAt })
          .where(eq(codexRateLimits.connectionId, input.connectionId));
        return;
      }
      await tx
        .insert(codexRateLimits)
        .values({
          connectionId: input.connectionId,
          orgId: input.orgId,
          ...values,
          observedAt,
          changedAt: observedAt,
        })
        .onConflictDoUpdate({
          target: codexRateLimits.connectionId,
          set: { orgId: input.orgId, ...values, observedAt, changedAt: observedAt },
        });
      await tx.insert(codexRateLimitSamples).values({
        connectionId: input.connectionId,
        orgId: input.orgId,
        ...values,
        observedAt,
      });
    });
  } catch (error) {
    console.error("[gateway] failed to record Codex rate limits", error);
  }
}

export const CALL_LOG_RETENTION_DAYS = 90;
const PRUNE_BATCH = 5_000;

async function pruneBatch(
  table: typeof gatewayCalls | typeof codexRateLimitSamples,
  cutoff: Date,
): Promise<number> {
  const time =
    table === gatewayCalls
      ? gatewayCalls.startedAt
      : codexRateLimitSamples.observedAt;
  const batch = await db
    .select({ id: table.id })
    .from(table)
    .where(lt(time, cutoff))
    .limit(PRUNE_BATCH);
  if (batch.length === 0) return 0;
  await db.delete(table).where(
    inArray(
      table.id,
      batch.map((row) => row.id),
    ),
  );
  return batch.length;
}

/** Delete call log rows and headroom samples older than the retention window, in batches. */
export async function pruneCallLog(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(
    now.getTime() - CALL_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  let deleted = 0;
  for (const table of [gatewayCalls, codexRateLimitSamples]) {
    for (;;) {
      const n = await pruneBatch(table, cutoff);
      deleted += n;
      if (n < PRUNE_BATCH) break;
    }
  }
  return deleted;
}

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const globalForCallLog = globalThis as unknown as {
  __harnesstCallLogPruner?: ReturnType<typeof setInterval>;
};

/** Start the retention sweep once per process: now, then every six hours. */
export function ensureCallLogPrunerStarted(): void {
  if (globalForCallLog.__harnesstCallLogPruner) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const deleted = await pruneCallLog();
      if (deleted > 0)
        console.log(`[gateway] pruned ${deleted} call log row(s) past retention`);
    } catch (error) {
      console.warn("[gateway] call log prune failed", error);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(tick, PRUNE_INTERVAL_MS);
  interval.unref?.();
  globalForCallLog.__harnesstCallLogPruner = interval;
  void tick();
}
