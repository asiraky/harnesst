/**
 * Link a subagent's child run to the parent tool call that started it (issue #417).
 *
 * eve runs each subagent call in a new child session. The child's run hook forwards
 * `ctx.session.parent` (the parent's call id, session and turn), so a pushed child knows its
 * parent call but not the subagent's name, which only the parent's `actions.requested` carries.
 * Older agent images forward no parent; then only a parent drained in-process can link, from
 * `subagent.called` (call id + child session id). The two runs are recorded independently and in
 * either order, so whichever is recorded second completes the link:
 *   - a child recorded after its parent reads the subagent's name off the parent's tool call
 *     (`parentCallName`);
 *   - a parent recorded after its child stamps the child's steps (`linkChildRuns`).
 * Every query is scoped to one project and reaches `run_steps` through indexed `sessions` /
 * `runs` lookups. Best-effort: a failure leaves the runs unlinked and never fails the record.
 */
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";

import { db } from "~/db/client.server";
import { runSteps, runs, sessions } from "~/db/schema";
import type { SubagentCall } from "./turn-usage";

/** The subagent name the parent's recorded tool call carries, or null when it is not recorded. */
export async function parentCallName(
  projectId: string,
  parentSessionId: string,
  callId: string,
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ data: runSteps.data })
      .from(runSteps)
      .innerJoin(runs, eq(runs.id, runSteps.runId))
      .innerJoin(sessions, eq(sessions.id, runs.sessionId))
      .where(
        and(
          eq(sessions.projectId, projectId),
          eq(sessions.externalSessionId, parentSessionId),
          eq(runs.projectId, projectId),
          eq(runSteps.type, "tool_call"),
          eq(runSteps.callId, callId),
        ),
      )
      .limit(1);
    const name = row?.data?.subagentName;
    return typeof name === "string" && name ? name : null;
  } catch (error) {
    console.warn("[observability] parent call lookup failed", error);
    return null;
  }
}

const LINKED_STEP_TYPES = ["model_call", "tool_call"];

/**
 * Stamp the already-recorded steps of each call's child run with the subagent and the call. A
 * call with a known child session finds its child by that session; otherwise by the parent call
 * id the child recorded, among the project's runs started since the parent's turn began.
 */
export async function linkChildRuns(
  projectId: string,
  calls: SubagentCall[],
  since: Date,
): Promise<void> {
  for (const call of calls) {
    try {
      if (call.childSessionId) {
        const childRuns = db
          .select({ id: runs.id })
          .from(runs)
          .innerJoin(sessions, eq(sessions.id, runs.sessionId))
          .where(
            and(
              eq(sessions.projectId, projectId),
              eq(sessions.externalSessionId, call.childSessionId),
              eq(runs.projectId, projectId),
            ),
          );
        await db
          .update(runSteps)
          .set({
            parentCallId: call.callId,
            ...(call.name ? { subagentName: call.name } : {}),
          })
          .where(
            and(
              inArray(runSteps.runId, childRuns),
              inArray(runSteps.type, LINKED_STEP_TYPES),
              or(isNull(runSteps.parentCallId), isNull(runSteps.subagentName)),
            ),
          );
        continue;
      }
      if (!call.name) continue;
      const recentRuns = db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), gte(runs.startedAt, since)));
      await db
        .update(runSteps)
        .set({ subagentName: call.name })
        .where(
          and(
            inArray(runSteps.runId, recentRuns),
            eq(runSteps.parentCallId, call.callId),
            isNull(runSteps.subagentName),
          ),
        );
    } catch (error) {
      console.warn("[observability] linking a subagent's child run failed", error);
    }
  }
}
