/**
 * FOH core loop, end to end (PRD-FRONT-OF-HOUSE §6 "core loop"): a real Better Auth user
 * sends a message through the REAL /api/foh/:projectId/stream action into a fresh FOH
 * session against a protocol-faithful fake eve — then ABANDONS the response reader mid-turn
 * (the away-mid-turn criterion). The detached drain must still consume eve to `done`,
 * persist the durable transcript (playground_events), land the session `waiting`, and file
 * the `finished` inbox item, with no client attached.
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at the live dev database
 * (`set -a; source .env.local; set +a; HARNESST_DB_SMOKE=1 npm run test:e2e`).
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
  uniqueSuffix,
  until,
  type TestUser,
} from "./harness";

describe.runIf(LIVE)("FOH core loop (real routes + drain + fake eve)", () => {
  it("streams a turn, survives mid-turn abandonment, and settles everything in the DB", async () => {
    const { db } = await import("~/db/client.server");
    const { eq } = await import("drizzle-orm");
    const { playgroundEvents, playgroundSessions } = await import("~/db/schema");
    const { drizzleDataStore } = await import("~/data/drizzle.server");
    const { action } = await import("~/routes/api.foh.stream");

    const suffix = uniqueSuffix("core");
    const eve = await startFakeEve();
    let orgId: string | undefined;
    const users: TestUser[] = [];
    let ndjson: ReturnType<typeof openNdjson> | null = null;
    try {
      const owner = await signUp("Core Owner", `foh-e2e-${suffix}@smoke.test`);
      users.push(owner);
      orgId = await createWorkspace(owner, "FOH E2E Core", `foh-e2e-${suffix}`);
      const { project, agent } = await seedTeamStack({
        orgId,
        suffix,
        eveUrl: eve.url,
      });

      // Phase 1 of the scripted turn: eve accepts and starts working. The completion is
      // deliberately withheld until the client has walked away.
      eve.onTurn((turn) => {
        eve.emit(turn.sessionId, "session.started", {
          runtime: { modelId: "anthropic/claude-sonnet-5" },
        });
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

      const res: Response = await action(
        actionArgs({
          path: `/api/foh/${project.id}/stream`,
          cookie: owner.cookie,
          params: { projectId: project.id },
          form: { agentId: agent.id, message: "Ship the release notes" },
        }),
      );
      expect(res.headers.get("content-type")).toContain("x-ndjson");

      // The live stream reaches the browser: first event names the session row.
      ndjson = openNdjson(res);
      const first = await until(
        () => ndjson!.next(),
        "the first NDJSON event",
      );
      expect(first).toMatchObject({ type: "session" });
      const playgroundSessionId = String(first.playgroundSessionId);

      // Away-mid-turn: the human closes the tab while the agent is still working.
      await ndjson.abandon();

      // Now eve finishes the turn with nobody watching.
      const sid = eve.turnPosts[0].acceptedSessionId;
      eve.emit(sid, "message.appended", {
        turnId: "turn_1",
        messageSoFar: "Done — shipped.",
      });
      eve.emit(sid, "message.completed", {
        turnId: "turn_1",
        message: "Done — shipped.",
      });
      eve.emit(sid, "step.completed", {
        turnId: "turn_1",
        sequence: 1,
        stepIndex: 0,
        usage: { inputTokens: 12, outputTokens: 7 },
      });
      eve.emit(sid, "turn.completed", { turnId: "turn_1" });
      eve.emit(sid, "session.waiting", {});
      eve.end(sid);

      // The detached drain settles the session with no client attached.
      const settled = await until(async () => {
        const [row] = await db
          .select()
          .from(playgroundSessions)
          .where(eq(playgroundSessions.id, playgroundSessionId));
        return row?.status === "waiting" ? row : null;
      }, "the abandoned session to settle to `waiting`");
      expect(settled.externalSessionId).toBe(sid);
      expect(settled.continuationToken).toBe("tok_e2e_1");
      expect(settled.streamIndex).toBe(8);
      expect(settled.pendingInputAt).toBeNull();
      expect(settled.title).toBe("Ship the release notes");
      expect(settled.lastEventAt).not.toBeNull();

      // Durable transcript: every eve event landed in playground_events.
      const events = await db
        .select()
        .from(playgroundEvents)
        .where(eq(playgroundEvents.sessionId, playgroundSessionId));
      expect(events).toHaveLength(8);
      expect(events.map((event) => event.type)).toContain("message.completed");

      // The finished turn filed the viewer's inbox pointer (D13).
      const inbox = await until(async () => {
        const pending =
          await drizzleDataStore.inboxItems.findPendingBySession(
            playgroundSessionId,
          );
        return pending.length > 0 ? pending : null;
      }, "the finished inbox item");
      expect(inbox).toMatchObject([
        {
          kind: "finished",
          prompt: "Done — shipped.",
          userId: owner.userId,
          projectId: project.id,
        },
      ]);

      expect(eve.scriptErrors).toEqual([]);
    } finally {
      if (ndjson) await ndjson.abandon();
      await eve.close();
      await cleanupWorkspace(orgId, users);
    }
  });
});

describe.runIf(!LIVE)("FOH core loop e2e (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
