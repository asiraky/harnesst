/**
 * FOH park + answer, end to end (PRD-FRONT-OF-HOUSE §6 needs-you loop, issue #221 finding 2):
 * a scripted eve turn parks on TWO tool-approval requests (`input.requested` then
 * `session.waiting`) with no client attached — the drain must set the pendingInputAt park and
 * file one pending inbox item per requestId. Answering ONE approval through the real stream
 * action must forward `inputResponses` containing EXACTLY that requestId on the continuation
 * POST (never batch-wide text resolution), and the supersede rule (D13) must resolve BOTH
 * pending items — the un-answered request's item included — before the new turn streams.
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
  uniqueSuffix,
  until,
  type TestUser,
} from "./harness";

const REQUEST_A = {
  requestId: "req_a",
  prompt: "Deploy api to production?",
  display: "confirmation",
  options: [
    { id: "approve", label: "Approve", style: "primary" },
    { id: "deny", label: "Deny", style: "danger" },
  ],
  allowFreeform: false,
  action: {
    callId: "req_a",
    kind: "tool-call",
    toolName: "confirm_action",
    input: { prompt: "Deploy api to production?" },
  },
};

const REQUEST_B = {
  ...REQUEST_A,
  requestId: "req_b",
  prompt: "Rotate the signing key too?",
  action: { ...REQUEST_A.action, callId: "req_b" },
};

describe.runIf(LIVE)("FOH park and request-correlated answer", () => {
  it("parks two approvals, answers one with a correlated inputResponse, supersedes both", async () => {
    const { db } = await import("~/db/client.server");
    const { eq } = await import("drizzle-orm");
    const { inboxItems, playgroundSessions } = await import("~/db/schema");
    const { drizzleDataStore } = await import("~/data/drizzle.server");
    const { action } = await import("~/routes/api.foh.stream");

    const suffix = uniqueSuffix("park");
    const eve = await startFakeEve();
    let orgId: string | undefined;
    const users: TestUser[] = [];
    try {
      const owner = await signUp("Park Owner", `foh-e2e-${suffix}@smoke.test`);
      users.push(owner);
      orgId = await createWorkspace(owner, "FOH E2E Park", `foh-e2e-${suffix}`);
      const { project, agent } = await seedTeamStack({
        orgId,
        suffix,
        eveUrl: eve.url,
      });

      // Turn 1: eve asks for two confirmations and parks.
      eve.onTurn((turn) => {
        eve.emit(turn.sessionId, "message.received", {
          message: turn.body.message,
          turnId: "turn_1",
        });
        eve.emit(turn.sessionId, "message.completed", {
          turnId: "turn_1",
          message: "Two deploys need a decision.",
        });
        eve.emit(turn.sessionId, "input.requested", {
          turnId: "turn_1",
          requests: [REQUEST_A, REQUEST_B],
        });
        eve.emit(turn.sessionId, "session.waiting", {});
        eve.end(turn.sessionId);
      });

      const res1: Response = await action(
        actionArgs({
          path: `/api/foh/${project.id}/stream`,
          cookie: owner.cookie,
          params: { projectId: project.id },
          form: { agentId: agent.id, message: "Deploy everything" },
        }),
      );
      const ndjson1 = openNdjson(res1);
      const first = await until(() => ndjson1.next(), "the session event");
      const playgroundSessionId = String(first.playgroundSessionId);
      // No client watches the park land — the needs-you records must appear regardless.
      await ndjson1.abandon();

      const parked = await until(async () => {
        const [row] = await db
          .select()
          .from(playgroundSessions)
          .where(eq(playgroundSessions.id, playgroundSessionId));
        return row?.pendingInputAt != null &&
          row.status === "waiting" &&
          row.continuationToken != null
          ? row
          : null;
      }, "the parked session (pendingInputAt + continuation handles)");
      const sid = eve.turnPosts[0].acceptedSessionId;
      expect(parked.externalSessionId).toBe(sid);

      // One pending approval item PER requestId, both addressed to the asking viewer.
      const pendingItems = await until(async () => {
        const pending =
          await drizzleDataStore.inboxItems.findPendingBySession(
            playgroundSessionId,
          );
        return pending.length === 2 ? pending : null;
      }, "both approval inbox items");
      expect(
        pendingItems.map((item) => ({
          kind: item.kind,
          requestId: item.requestId,
          userId: item.userId,
        })),
      ).toEqual(
        expect.arrayContaining([
          { kind: "approval", requestId: "req_a", userId: owner.userId },
          { kind: "approval", requestId: "req_b", userId: owner.userId },
        ]),
      );
      const itemB = pendingItems.find((item) => item.requestId === "req_b")!;

      // Turn 2: the human answers request A only.
      eve.onTurn((turn) => {
        eve.emit(turn.sessionId, "message.received", {
          message: turn.body.message,
          turnId: "turn_2",
        });
        eve.emit(turn.sessionId, "message.completed", {
          turnId: "turn_2",
          message: "Approved and deployed.",
        });
        eve.emit(turn.sessionId, "turn.completed", { turnId: "turn_2" });
        eve.emit(turn.sessionId, "session.waiting", {});
        eve.end(turn.sessionId);
      });

      const res2: Response = await action(
        actionArgs({
          path: `/api/foh/${project.id}/stream`,
          cookie: owner.cookie,
          params: { projectId: project.id },
          form: {
            agentId: agent.id,
            playgroundSessionId,
            message: "Approve — ship it.",
            inputResponses: JSON.stringify([
              { requestId: "req_a", optionId: "approve" },
            ]),
          },
        }),
      );

      // Supersede (D13) ran BEFORE the turn streamed: the park is cleared and BOTH pending
      // approval items — the un-answered req_b included — are resolved.
      const [afterSend] = await db
        .select()
        .from(playgroundSessions)
        .where(eq(playgroundSessions.id, playgroundSessionId));
      expect(afterSend.pendingInputAt).toBeNull();
      const [itemBAfter] = await db
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.id, itemB.id));
      expect(itemBAfter.status).toBe("resolved");

      const ndjson2 = openNdjson(res2);
      await until(() => ndjson2.next(), "the answer turn's session event");
      await ndjson2.abandon();

      // The multi-request approval proof: the continuation POST reached the SAME eve session
      // carrying EXACTLY the one clicked requestId — not both, not a batch-wide text answer.
      const followUp = await until(
        async () => eve.turnPosts.find((post) => post.sessionId === sid),
        "the continuation POST recorded by fake eve",
      );
      expect(followUp.body.message).toBe("Approve — ship it.");
      expect(followUp.body.continuationToken).toBe(parked.continuationToken);
      expect(followUp.body.inputResponses).toEqual([
        { requestId: "req_a", optionId: "approve" },
      ]);

      // The answered turn settles: waiting, un-parked, with a fresh `finished` pointer only.
      const settled = await until(async () => {
        const [row] = await db
          .select()
          .from(playgroundSessions)
          .where(eq(playgroundSessions.id, playgroundSessionId));
        return row?.status === "waiting" && row.streamIndex >= 8 ? row : null;
      }, "the answered turn to settle");
      expect(settled.pendingInputAt).toBeNull();
      const finalPending = await until(async () => {
        const pending =
          await drizzleDataStore.inboxItems.findPendingBySession(
            playgroundSessionId,
          );
        return pending.length === 1 ? pending : null;
      }, "exactly one pending (finished) item");
      expect(finalPending[0]).toMatchObject({
        kind: "finished",
        prompt: "Approved and deployed.",
      });

      expect(eve.scriptErrors).toEqual([]);
    } finally {
      await eve.close();
      await cleanupWorkspace(orgId, users);
    }
  });
});

describe.runIf(!LIVE)("FOH park/answer e2e (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
