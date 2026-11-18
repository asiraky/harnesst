/**
 * Persistence for tool results the gateway withheld (see tool-result-limit.ts).
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "~/db/client.server";
import { withheldToolResults } from "~/db/schema";
import type { WithheldMark } from "~/observability/withheld-steps";
import type { WithheldToolResult } from "./tool-result-limit";

/**
 * Record withheld results, once per tool call. Never throws: a failed write costs visibility of
 * the rejection, not the agent's model call.
 */
export async function recordWithheldToolResults(
  orgId: string,
  model: string,
  withheld: WithheldToolResult[],
): Promise<void> {
  const rows = withheld
    .filter((w) => w.callId)
    .map((w) => ({
      orgId,
      callId: w.callId,
      toolName: w.toolName,
      tokens: w.tokens,
      limitTokens: w.limitTokens,
      model,
    }));
  if (rows.length === 0) return;
  try {
    await db.insert(withheldToolResults).values(rows).onConflictDoNothing();
  } catch (error) {
    console.error("[gateway] failed to record withheld tool results", error);
  }
}

export async function withheldByCallId(
  orgId: string,
  callIds: string[],
): Promise<Map<string, WithheldMark>> {
  if (callIds.length === 0) return new Map();
  const rows = await db
    .select({
      callId: withheldToolResults.callId,
      tokens: withheldToolResults.tokens,
      limitTokens: withheldToolResults.limitTokens,
    })
    .from(withheldToolResults)
    .where(
      and(eq(withheldToolResults.orgId, orgId), inArray(withheldToolResults.callId, callIds)),
    );
  return new Map(rows.map((r) => [r.callId, { tokens: r.tokens, limitTokens: r.limitTokens }]));
}
