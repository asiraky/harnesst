/**
 * FOH concurrent-turn rejection, end to end (issue #221 finding 5): while a scripted slow
 * eve turn holds the session `running` (fresh drain activity), a second POST to the REAL
 * stream action on the same session must 409 — losing the atomic claim BEFORE it touches
 * eve — and the winning drain must still settle the session cleanly afterwards.
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at the live dev database.
 */
import { describe, expect, it } from "vitest";

import { startFakeEve } from "./fake-eve";
import {
  actionArgs,
  cleanupWorkspace,
  createWorkspace,
  LIVE,
  openNdjson,
  seedTeamStack,
  signUp,
  statusOfThrown,
  uniqueSuffix,
  until,
  type TestUser,
} from "./harness";

describe.runIf(LIVE)("FOH concurrent turns on one session", () => {
  it("409s the second sender while a fresh turn runs, then settles the winner", async () => {
    const { db } = await import("~/db/client.server");
    const { eq } = await import("drizzle-orm");
    const { playgroundEvents, playgroundSessions } = await import("~/db/schema");
    const { drizzleDataStore } = await import("~/data/drizzle.server");
    const { action } = await import("~/routes/api.foh.stream");

    const suffix = uniqueSuffix("conc");
    const eve = await startFakeEve();
    let orgId: string | undefined;
    const users: TestUser[] = [];
    try {
      const owner = await signUp("Conc Owner", `foh-e2e-${suffix}@smoke.test`);
      users.push(owner);
      orgId = await createWorkspace(owner, "FOH E2E Conc", `foh-e2e-${suffix}`);
      const { project, agent } = await seedTeamStack({
        orgId,
        suffix,
        eveUrl: eve.url,
      });

      // A slow turn: eve starts working and deliberately never completes (yet).
      eve.onTurn((turn) => {
        eve.emit(turn.sessionId, "message.received", {
          message: turn.body.message,
          turnId: "turn_1",
        });
        eve.emit(turn.sessionId, "step.started", {
          turnId: "turn_1",
          sequence: 1,
          stepIndex: 0,
        });
      });

      const res1: Response = await action(
        actionArgs({
          path: `/api/foh/${project.id}/stream`,
          cookie: owner.cookie,
          params: { projectId: project.id },
          form: { agentId: agent.id, message: "Run the long migration" },
        }),
      );
      const ndjson1 = openNdjson(res1);
      const first = await until(() => ndjson1.next(), "the session event");
      const playgroundSessionId = String(first.playgroundSessionId);
      await ndjson1.abandon();

      // The claim holds: `running` with the winner's fencing token and fresh updatedAt.
      const running = await until(async () => {
        const [row] = await db
          .select()
          .from(playgroundSessions)
          .where(eq(playgroundSessions.id, playgroundSessionId));
        return row?.status === "running" && row.turnClaimId != null ? row : null;
      }, "the winning turn to hold the session `running`");
      const winningClaimId = running.turnClaimId;

      // Second sender (another tab / member / replica) races the SAME session → 409.
      let thrown: unknown = null;
      try {
        await action(
          actionArgs({
            path: `/api/foh/${project.id}/stream`,
            cookie: owner.cookie,
            params: { projectId: project.id },
            form: {
              agentId: agent.id,
              playgroundSessionId,
              message: "Are you done yet?",
            },
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(statusOfThrown(thrown)).toBe(409);

      // The loser lost BEFORE touching state: the fence is untouched and eve saw only the
      // winner's single session POST.
      const [afterLoss] = await db
        .select()
        .from(playgroundSessions)
        .where(eq(playgroundSessions.id, playgroundSessionId));
      expect(afterLoss.status).toBe("running");
      expect(afterLoss.turnClaimId).toBe(winningClaimId);
      expect(eve.turnPosts).toHaveLength(1);

      // Let the winner finish; its detached drain settles the session cleanly.
      const sid = eve.turnPosts[0].acceptedSessionId;
      eve.emit(sid, "step.completed", {
        turnId: "turn_1",
        sequence: 1,
        stepIndex: 0,
      });
      eve.emit(sid, "message.completed", {
        turnId: "turn_1",
        message: "Migration finished.",
      });
      eve.emit(sid, "turn.completed", { turnId: "turn_1" });
      eve.emit(sid, "session.waiting", {});
      eve.end(sid);

      const settled = await until(async () => {
        const [row] = await db
          .select()
          .from(playgroundSessions)
          .where(eq(playgroundSessions.id, playgroundSessionId));
        return row?.status === "waiting" ? row : null;
      }, "the winning turn to settle");
      expect(settled.turnClaimId).toBe(winningClaimId);
      expect(settled.streamIndex).toBe(6);
      const events = await db
        .select()
        .from(playgroundEvents)
        .where(eq(playgroundEvents.sessionId, playgroundSessionId));
      expect(events).toHaveLength(6);

      // Exactly one finished pointer — the losing request contributed nothing.
      const pending = await until(async () => {
        const items =
          await drizzleDataStore.inboxItems.findPendingBySession(
            playgroundSessionId,
          );
        return items.length > 0 ? items : null;
      }, "the finished inbox item");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: "finished",
        prompt: "Migration finished.",
      });

      expect(eve.scriptErrors).toEqual([]);
    } finally {
      await eve.close();
      await cleanupWorkspace(orgId, users);
    }
  });
});

describe.runIf(!LIVE)("FOH concurrent turns e2e (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
