/**
 * Link a subagent's child run to the parent tool call that started it (issue #417).
 *
 * eve runs each subagent call in a new child session and says so only on the PARENT's stream
 * (`subagent.called`: call id, child session id, subagent name); the child's own stream names no
 * parent. The two runs are recorded independently and in either order, so the link is made from
 * whichever side is recorded second:
 *   - the parent's tool call stores the child session id (`run_steps.child_session_id`); a child
 *     recorded after it finds it with `findParentCall`;
 *   - a parent recorded after its child stamps the child's steps with `linkChildRuns`.
 * Both are scoped to one project, and best-effort: a failure leaves the runs unlinked, never
 * fails the record.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "~/db/client.server";
import { runSteps, runs, sessions } from "~/db/schema";
import type { SubagentCall, SubagentInvocation } from "./turn-usage";

/** The parent call recorded for a child session, or null when its parent is not recorded yet. */
export async function findParentCall(
  projectId: string,
  childSessionId: string,
): Promise<SubagentInvocation | null> {
  try {
    const [row] = await db
      .select({ callId: runSteps.callId, data: runSteps.data })
      .from(runSteps)
      .innerJoin(runs, eq(runs.id, runSteps.runId))
      .where(
        and(
          eq(runSteps.childSessionId, childSessionId),
          eq(runs.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row?.callId) return null;
    const name = row.data?.subagentName;
    return {
      name: typeof name === "string" ? name : null,
      parentCallId: row.callId,
      parentSessionId: null,
      parentTurnId: null,
    };
  } catch (error) {
    console.warn("[observability] parent call lookup failed", error);
    return null;
  }
}

/** Stamp the already-recorded steps of each call's child run with its subagent and call. */
export async function linkChildRuns(
  projectId: string,
  calls: SubagentCall[],
): Promise<void> {
  for (const call of calls) {
    try {
      const childRuns = db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(sessions, eq(sessions.id, runs.sessionId))
        .where(
          and(
            eq(sessions.projectId, projectId),
            eq(sessions.externalSessionId, call.childSessionId),
          ),
        );
      await db
        .update(runSteps)
        .set({ subagentName: call.name, parentCallId: call.callId })
        .where(
          and(
            inArray(runSteps.runId, childRuns),
            inArray(runSteps.type, ["model_call", "tool_call"]),
            isNull(runSteps.parentCallId),
          ),
        );
    } catch (error) {
      console.warn("[observability] linking a subagent's child run failed", error);
    }
  }
}
