/**
 * WP4 relay-parking lifecycle against a REAL Postgres: running → waiting (park) → completed
 * (wake-on-answer). `sendTurn` is faked through AskDeps and `streamTurn` is mocked for the
 * resume drain — everything below them (delegations, playground_sessions, inbox_items,
 * finalizeDelegationOnResume via the real drizzle store) is real.
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at a live dev database
 * (`set -a; source .env.local; set +a; HARNESST_DB_SMOKE=1 npx vitest run
 * tests/integration/foh-delegation.db.test.ts`). Seeds and removes its own rows.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { TalkEvent, TurnResult } from "~/agent/talk.server";

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

function turnResult(over: Partial<TurnResult>): TurnResult {
  return {
    ok: true,
    sessionId: "sess_ext_deleg",
    continuationToken: "tok_deleg",
    streamIndex: 2,
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

describe.runIf(LIVE)("FOH delegation parking against real Postgres", () => {
  it("runs the lifecycle running → waiting → completed", async () => {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const {
      agents,
      delegations,
      deployments,
      environments,
      playgroundSessions,
      projects,
      releases,
    } = await import("~/db/schema");
    const { drizzleDataStore } = await import("~/data/drizzle.server");
    const { runAsk } = await import("~/team/ask.server");
    const { createPlaygroundSession } =
      await import("~/playground/sessions.server");
    const { streamTurnResponse } = await import("~/chat/turn-stream.server");

    const ORG = "org_foh_deleg";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({
      id: ORG,
      name: "foh delegation smoke",
      slug: "foh-delegation-smoke",
      createdAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh-deleg", slug: "foh-delegation-smoke" })
      .returning();
    const [pm] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "sam", root: "agents/sam/agent" })
      .returning();
    const [ivy] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();
    const [pmEnv] = await db
      .insert(environments)
      .values({ projectId: project.id, agentId: pm.id, name: "production" })
      .returning();
    const [ivyEnv] = await db
      .insert(environments)
      .values({ projectId: project.id, agentId: ivy.id, name: "production" })
      .returning();
    const [pmRel] = await db
      .insert(releases)
      .values({
        projectId: project.id,
        agentId: pm.id,
        version: "v1",
        gitSha: "a".repeat(40),
      })
      .returning();
    const [ivyRel] = await db
      .insert(releases)
      .values({
        projectId: project.id,
        agentId: ivy.id,
        version: "v1",
        gitSha: "b".repeat(40),
      })
      .returning();
    const [pmDep] = await db
      .insert(deployments)
      .values({
        environmentId: pmEnv.id,
        releaseId: pmRel.id,
        status: "live",
        trafficWeight: 100,
        url: "http://sam.local",
      })
      .returning();
    await db.insert(deployments).values({
      environmentId: ivyEnv.id,
      releaseId: ivyRel.id,
      status: "live",
      trafficWeight: 100,
      url: "http://ivy.local",
    });

    // 1. The relay parks: ivy's turn ends on an input request.
    const parked = turnResult({
      inputRequests: [
        { requestId: "req_d1", prompt: "Which cluster should I deploy to?" },
      ],
    });
    const res = await runAsk(
      { deploymentId: pmDep.id, teammate: "ivy", message: "Deploy build 42" },
      {
        store: drizzleDataStore,
        sendTurn: async () => parked,
        recordStart: async () => true,
        recordFinish: async () => {},
        resolveRunId: async () => null,
        ensureLiveDeployment: async () => null,
        createSession: createPlaygroundSession,
        backfillSession: async () => {}, // no eve behind the fake url
        scheduleReattach: async () => {},
        now: () => new Date(),
        timeoutMs: 1_000,
      },
    );
    expect(res).toMatchObject({
      ok: true,
      status: "waiting_on_human",
      teammate: "ivy",
      question: "Which cluster should I deploy to?",
    });

    const [delegation] = await db
      .select()
      .from(delegations)
      .where(eq(delegations.projectId, project.id));
    expect(delegation).toMatchObject({
      status: "waiting",
      fromAgentId: pm.id,
      toAgentId: ivy.id,
      externalSessionId: "sess_ext_deleg",
    });

    const [session] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.delegationId, delegation.id));
    expect(session).toMatchObject({
      surface: "foh",
      createdBy: null,
      openedByAgentId: ivy.id,
      externalSessionId: "sess_ext_deleg",
      continuationToken: "tok_deleg",
      streamIndex: 2,
      status: "waiting",
      title: "Which cluster should I deploy to?",
    });
    expect(session.pendingInputAt).not.toBeNull();

    const pending = await drizzleDataStore.inboxItems.findPendingBySession(
      session.id,
    );
    expect(pending).toMatchObject([
      {
        kind: "question",
        prompt: "Which cluster should I deploy to?",
        requestId: "req_d1",
        userId: null,
        delegationId: delegation.id,
      },
    ]);

    // 2. Wake-on-answer: a human's continuation turn on the agent-opened session completes,
    //    and the drain's finally block finalizes the waiting delegation.
    script([
      {
        kind: "session",
        sessionId: "sess_ext_deleg",
        continuationToken: "tok_deleg",
      },
      {
        kind: "progress",
        sessionId: "sess_ext_deleg",
        continuationToken: "tok_deleg",
        streamIndex: 3,
        rawEvent: {
          type: "message.completed",
          data: { turnId: "turn_2", message: "Deployed to blue." },
        },
      },
      {
        kind: "done",
        result: turnResult({
          reply: "Deployed to blue.",
          streamIndex: 3,
          turnId: null,
        }),
      },
    ]);
    const target = {
      deploymentId: null,
      releaseId: null,
      environmentId: null,
      url: "http://fake-eve",
      version: null,
    } as unknown as import("~/chat/playground.server").Target;
    await readAll(
      streamTurnResponse({
        projectId: project.id,
        target,
        session,
        message: "blue",
        channel: "foh",
        title: null,
      }),
    );

    const [settled] = await db
      .select()
      .from(delegations)
      .where(eq(delegations.id, delegation.id));
    expect(settled.status).toBe("completed");

    const [sessionAfter] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, session.id));
    expect(sessionAfter.status).toBe("waiting");
    expect(sessionAfter.pendingInputAt).toBeNull();
    const after = await drizzleDataStore.inboxItems.findPendingBySession(
      session.id,
    );
    expect(after).toMatchObject([{ kind: "finished" }]);

    // Cleanup (org cascade removes project/agents/envs/deployments/session/delegation/inbox).
    await db.delete(organization).where(eq(organization.id, ORG));
  });
});
