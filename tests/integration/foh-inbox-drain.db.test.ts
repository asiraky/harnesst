/**
 * End-to-end needs-you rows against a REAL Postgres (WP3): the shared drain runs with a
 * scripted fake eve stream (streamTurn mocked, everything below it real), with NO client
 * reading until the turn is over — proving the §6 "even with no client connected" loop in DB
 * form: park ⇒ pending flag + inbox row; requestId dedupe across re-observations; the
 * send-path supersede (`beginFohTurn`); completion ⇒ items resolved + `finished` filed;
 * read ⇒ visible notifications acknowledged.
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at a live dev database
 * (`set -a; source .env.local; set +a; HARNESST_DB_SMOKE=1 npx vitest run
 * tests/integration/foh-inbox-drain.db.test.ts`). Seeds and removes its own rows.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { TalkEvent, TurnResult } from "~/agent/talk.server";
import type { ChatInputRequest } from "~/chat/types";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

const mocks = vi.hoisted(() => ({ streamTurn: vi.fn() }));

vi.mock("~/agent/talk.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/agent/talk.server")>()),
  streamTurn: mocks.streamTurn,
}));

function script(events: TalkEvent[]) {
  mocks.streamTurn.mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

/** turnId stays null so the run recorder (FK'd to deployments) stays out of the way. */
function result(over: Partial<TurnResult>): TurnResult {
  return {
    ok: true,
    sessionId: "sess_ext_drain",
    continuationToken: "tok_1",
    streamIndex: 0,
    reply: null,
    replyIsStructured: false,
    inputRequests: [],
    modelId: null,
    turnId: null,
    steps: [],
    messages: [],
    error: null,
    ...over,
  };
}

async function readAll(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe.runIf(LIVE)("FOH inbox drain against real Postgres", () => {
  it("parks, dedupes, supersedes on send, finishes, and resolves on read", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const { agents, playgroundSessions, projects } = await import("~/db/schema");
    const { createPlaygroundSession } = await import(
      "~/playground/sessions.server"
    );
    const { streamTurnResponse } = await import("~/chat/turn-stream.server");
    const { beginFohTurn, acknowledgeVisibleInboxOnRead } = await import(
      "~/foh/inbox.server"
    );
    const { drizzleDataStore } = await import("~/data/drizzle.server");

    const ORG = "org_foh_drain";
    const USER = "user_foh_drain";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.insert(organization).values({
      id: ORG,
      name: "foh drain smoke",
      slug: "foh-drain-smoke",
      createdAt: now,
    });
    await db.insert(user).values({
      id: USER,
      name: "FOH Drain",
      email: "foh-drain@smoke.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh-drain", slug: "foh-drain-smoke" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();

    const session = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: USER,
      surface: "foh",
    });

    // Null FK-ish fields: the fake turn has no real deployment/environment behind it.
    const target = {
      deploymentId: null,
      releaseId: null,
      environmentId: null,
      url: "http://fake-eve",
      version: null,
    } as unknown as import("~/chat/playground.server").Target;

    const request: ChatInputRequest = {
      requestId: "req_drain_1",
      prompt: "Which account should I use?",
    };
    const parked: TalkEvent[] = [
      { kind: "session", sessionId: "sess_ext_drain", continuationToken: "tok_1" },
      {
        kind: "progress",
        sessionId: "sess_ext_drain",
        continuationToken: "tok_1",
        streamIndex: 1,
        rawEvent: {
          type: "message.received",
          data: { turnId: "turn_1", message: "do the thing" },
        },
      },
      { kind: "input", requests: [request] },
      {
        kind: "progress",
        sessionId: "sess_ext_drain",
        continuationToken: "tok_1",
        streamIndex: 2,
        rawEvent: {
          type: "input.requested",
          data: { turnId: "turn_1", requests: [request] },
        },
      },
      {
        kind: "done",
        result: result({ inputRequests: [request], streamIndex: 2 }),
      },
    ];

    const turn = (events: TalkEvent[]) => {
      script(events);
      return readAll(
        streamTurnResponse({
          projectId: project.id,
          target,
          session,
          message: "do the thing",
          channel: "foh",
          title: "Do the thing",
        }),
      );
    };

    // 1. Park with no client attached: pending flag + one pending question item.
    await turn(parked);
    let [row] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, session.id));
    expect(row.status).toBe("waiting");
    expect(row.pendingInputAt).not.toBeNull();
    expect(row.streamIndex).toBe(2);
    let pending = await drizzleDataStore.inboxItems.findPendingBySession(session.id);
    expect(pending).toMatchObject([
      {
        kind: "question",
        prompt: "Which account should I use?",
        requestId: "req_drain_1",
        userId: USER,
        projectId: project.id,
      },
    ]);

    // 2. The same eve request observed again (drain + reconcile overlap) dedupes.
    await turn(parked);
    pending = await drizzleDataStore.inboxItems.findPendingBySession(session.id);
    expect(pending).toHaveLength(1);

    // 3. Send path: beginFohTurn supersedes the ask, then the answered turn completes.
    await beginFohTurn(session.id);
    [row] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, session.id));
    expect(row.pendingInputAt).toBeNull();
    expect(
      await drizzleDataStore.inboxItems.findPendingBySession(session.id),
    ).toHaveLength(0);

    await turn([
      { kind: "session", sessionId: "sess_ext_drain", continuationToken: "tok_1" },
      {
        kind: "progress",
        sessionId: "sess_ext_drain",
        continuationToken: "tok_1",
        streamIndex: 3,
        rawEvent: {
          type: "message.completed",
          data: { turnId: "turn_2", message: "Done — used the blue one." },
        },
      },
      {
        kind: "done",
        result: result({ reply: "Done — used the blue one.", streamIndex: 3 }),
      },
    ]);

    [row] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, session.id));
    expect(row.status).toBe("waiting");
    expect(row.pendingInputAt).toBeNull();
    pending = await drizzleDataStore.inboxItems.findPendingBySession(session.id);
    expect(pending).toMatchObject([
      { kind: "finished", prompt: "Done — used the blue one.", userId: USER },
    ]);

    // 4. Opening the session (read) acknowledges the finished notification (D13).
    await acknowledgeVisibleInboxOnRead(session.id, USER);
    expect(
      await drizzleDataStore.inboxItems.findPendingBySession(session.id),
    ).toHaveLength(0);

    // Cleanup (org cascade removes project/agent/session/inbox rows).
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
  });

  it("yields ONE pending row for concurrent same-request openInboxQuestion calls", async () => {
    // Two writers (drain + reconcile, or two replicas) race the same eve request: both pass
    // the read-then-insert fast path, and the partial unique index + ON CONFLICT DO NOTHING
    // collapse them to one pending row (issue #221 finding 4).
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const { agents, projects } = await import("~/db/schema");
    const { createPlaygroundSession } = await import(
      "~/playground/sessions.server"
    );
    const { openInboxQuestion } = await import("~/foh/inbox.server");
    const { drizzleDataStore } = await import("~/data/drizzle.server");

    const ORG = "org_foh_race";
    const USER = "user_foh_race";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.insert(organization).values({
      id: ORG,
      name: "foh race smoke",
      slug: "foh-race-smoke",
      createdAt: now,
    });
    await db.insert(user).values({
      id: USER,
      name: "FOH Race",
      email: "foh-race@smoke.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh-race", slug: "foh-race-smoke" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();
    const session = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: USER,
      surface: "foh",
    });

    const open = () =>
      openInboxQuestion({
        projectId: project.id,
        sessionId: session.id,
        agentId: agent.id,
        userId: USER,
        request: { requestId: "req_race_1", prompt: "Race me?" },
      });
    const [a, b] = await Promise.all([open(), open()]);
    expect(a.id).toBe(b.id);
    const pending = await drizzleDataStore.inboxItems.findPendingBySession(
      session.id,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      requestId: "req_race_1",
      kind: "question",
      status: "pending",
    });

    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
  });
});
