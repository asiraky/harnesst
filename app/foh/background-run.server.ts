/**
 * Which sandbox does a BACKGROUND publish read from? (issue #370)
 *
 * A live FOH turn carries its own answer — `liveFohTurnForDeployment` hands `publishArtifact` the
 * conversation row, whose predecessor/external eve session id names the volume subpath the docker
 * copy mounts. A cron/channel run has no FOH row, and the copy's container lookup is scoped only to
 * the ENVIRONMENT volume — per-session isolation is the subpath mount, not the filter — so letting
 * the request BODY claim a session id would let a compromised instance read any member's
 * confidential workspace on the same deployment. The session id must come from something the
 * control plane already knows.
 *
 * It does know one: the baked run hook POSTs `turn.started` for every non-FOH run
 * (`push-ingest.server.ts` drops http-homed turns before recording), so a `runs` row with
 * `status='running'`, `metadata.source='push'` and this AUTHENTICATED deployment id is the control
 * plane's own record that eve session X is executing on this deployment right now. That row's
 * `eveSessionId` is trustworthy for the same reason the live-turn path's is: the caller never
 * chose it.
 *
 * Same refusal shape as the live-turn resolver: zero candidate sessions means there is nothing to
 * read from, more than one means harnesst cannot tell whose files it would be copying — refuse
 * rather than guess, exactly the confidentiality rule the FOH path enforces.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { runs } from "~/db/schema";

/**
 * How stale a `running` row may be and still name the sandbox. Crashed hooks never post
 * `turn.finished`, so `running` rows can linger forever; a generous-but-finite window keeps a
 * week-old wreck from making every future publish "ambiguous". Long, because a background run
 * legitimately publishing at the END of a big job may have started hours ago.
 */
export const BACKGROUND_RUN_WINDOW_MS = 6 * 60 * 60 * 1000;

export type BackgroundRunResult =
  | { ok: true; sandboxSessionId: string }
  | { ok: false; reason: "none" | "ambiguous" };

export async function backgroundRunForDeployment(input: {
  deploymentId: string;
  now: Date;
}): Promise<BackgroundRunResult> {
  const rows = await db
    .select({ metadata: runs.metadata })
    .from(runs)
    .where(
      and(
        eq(runs.deploymentId, input.deploymentId),
        eq(runs.status, "running"),
        gte(
          runs.startedAt,
          new Date(input.now.getTime() - BACKGROUND_RUN_WINDOW_MS),
        ),
        sql`${runs.metadata}->>'source' = 'push'`,
      ),
    );
  // Distinct SESSIONS, not rows: one eve session can hold several concurrently-recorded turns
  // (subagents, retries), and they all read from the same subpath — that is not ambiguity.
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.metadata?.["eveSessionId"];
    if (typeof id === "string" && id) ids.add(id);
  }
  if (ids.size === 0) return { ok: false, reason: "none" };
  if (ids.size > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, sandboxSessionId: [...ids][0] };
}
