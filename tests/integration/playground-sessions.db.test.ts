/**
 * Session-row guards against a REAL Postgres. The transcript itself lives in eve's durable
 * stream (#288) — harnesst keeps only the session row — so what needs proving here is the
 * write discipline on that row: a deliberate /stop is terminal for an already-running drain's
 * queued writes, and clearing a dead channel binding resets the handles and the cursor.
 *
 * Opt-in: runs only when HARNESST_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`HARNESST_DB_SMOKE=1 npx vitest run tests/integration/playground-sessions.db.test.ts` with
 * .env.local sourced). Creates its own org/project/agent/session rows and deletes them, so it's
 * safe to re-run.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("playground session rows against real Postgres", () => {
  it("stop wins over stale drain writes; clearing handles resets the cursor", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const { projects, agents, playgroundSessions } = await import("~/db/schema");
    const {
      clearSessionHandles,
      createPlaygroundSession,
      markPlaygroundSessionStopped,
      savePlaygroundSessionCursor,
      savePlaygroundSessionProgress,
    } = await import("~/playground/sessions.server");

    const ORG = "org_pgsession_smoke";
    const USER = "user_pgsession_smoke";
    const now = new Date();
    // Fresh scope each run (cascades clean up the sessions).
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.insert(organization).values({
      id: ORG,
      name: "pgsession smoke",
      slug: "pgsession-smoke",
      createdAt: now,
    });
    await db.insert(user).values({
      id: USER,
      name: "Playground Session Smoke",
      email: "pgsession@smoke.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "pgsession", slug: "pgsession-smoke" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        projectId: project.id,
        name: "engineer",
        root: "agents/engineer/agent",
      })
      .returning();
    const session = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: USER,
      modelId: "openai/abcdefghijkl/gpt-5.4",
      effort: "high",
    });
    expect(session).toMatchObject({
      modelId: "openai/abcdefghijkl/gpt-5.4",
      effort: "high",
    });

    // Stop is terminal for an already-running drain: both its queued progress write and its
    // final cursor write arrive after /stop in this ordering, and both must become no-ops. The
    // fake target deliberately has no FK rows, so either update escaping its status guard also
    // fails loudly.
    await markPlaygroundSessionStopped({ id: session.id });
    const staleDrainTarget = {
      deploymentId: "dep_pgsmoke",
      environmentId: "env_pgsmoke",
      releaseId: "rel_pgsmoke",
      url: "http://127.0.0.1:1",
      version: "v1",
      environmentName: "smoke",
      gitSha: "deadbeef",
    };
    await savePlaygroundSessionProgress({
      id: session.id,
      target: staleDrainTarget,
      externalSessionId: "wrun_pgsession_smoke",
      continuationToken: null,
      streamIndex: 5,
    });
    await savePlaygroundSessionCursor({
      id: session.id,
      target: staleDrainTarget,
      externalSessionId: "wrun_pgsession_smoke",
      continuationToken: null,
      streamIndex: 5,
      status: "waiting",
    });
    const [afterStaleDrain] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, session.id));
    expect(afterStaleDrain).toMatchObject({
      status: "stopped",
      externalSessionId: null,
      streamIndex: 0,
    });

    // A dead channel binding clears handles + descriptor + cursor together, so the next send
    // starts a fresh HTTP-homed eve session reading its stream from index 0.
    const bound = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: USER,
      surface: "foh",
      externalSessionId: "wrun_pgsession_bound",
      continuationToken: "github:tok",
      resumeVia: {
        channel: "github",
        routePath: "/eve/v1/github/harnesst/answer",
        rawToken: "tok",
        state: {},
      },
      streamIndex: 7,
      status: "waiting",
    });
    await clearSessionHandles(bound.id);
    const [cleared] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, bound.id));
    expect(cleared).toMatchObject({
      externalSessionId: null,
      continuationToken: null,
      resumeVia: null,
      streamIndex: 0,
    });

    // Cleanup.
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
  });

  it("counts only notification rows toward the notify ceiling; the compensation delete only reaps bare ones", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const { projects, agents, playgroundSessions } = await import("~/db/schema");
    const {
      countAgentInitiatedFohSessions,
      createPlaygroundSession,
      deleteBareNotificationSession,
    } = await import("~/playground/sessions.server");

    const ORG = "org_notifycap_smoke";
    const USER = "user_notifycap_smoke";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.insert(organization).values({
      id: ORG,
      name: "notifycap smoke",
      slug: "notifycap-smoke",
      createdAt: now,
    });
    await db.insert(user).values({
      id: USER,
      name: "Notify Cap Smoke",
      email: "notifycap@smoke.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "notifycap", slug: "notifycap-smoke" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        projectId: project.id,
        name: "engineer",
        root: "agents/engineer/agent",
      })
      .returning();

    // A channel-parked conversation shares the null creator/delegation shape but has no
    // opening message — it must NOT eat the agent's notification budget.
    const parked = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: null,
      surface: "foh",
      externalSessionId: "wrun_notifycap_parked",
      continuationToken: "github:tok",
      status: "waiting",
    });
    // A human-opened FOH conversation never counts.
    await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: USER,
      surface: "foh",
    });
    expect(await countAgentInitiatedFohSessions(agent.id)).toBe(0);

    // The notification row — createdBy null, no delegation, an opening message — is the ONLY
    // shape the ceiling counts, and archiving frees it (#278).
    const notification = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: null,
      surface: "foh",
      openedByAgentId: agent.id,
      openingMessage: "The nightly import finished.",
      lastEventAt: now,
    });
    expect(await countAgentInitiatedFohSessions(agent.id)).toBe(1);
    await db
      .update(playgroundSessions)
      .set({ archivedAt: now })
      .where(eq(playgroundSessions.id, notification.id));
    expect(await countAgentInitiatedFohSessions(agent.id)).toBe(0);

    // The compensation delete refuses everything that is not a bare notification: the parked
    // row has handles and no opening message, and the archived notification — restore it
    // first — grows an eve session once a human replies.
    await deleteBareNotificationSession(parked.id);
    const [parkedStill] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, parked.id));
    expect(parkedStill).toBeDefined();
    await db
      .update(playgroundSessions)
      .set({ archivedAt: null, externalSessionId: "wrun_notifycap_replied" })
      .where(eq(playgroundSessions.id, notification.id));
    await deleteBareNotificationSession(notification.id);
    const [engagedStill] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, notification.id));
    expect(engagedStill).toBeDefined();

    // Only the bare shape — the row a failed notice insert would orphan — goes through.
    await db
      .update(playgroundSessions)
      .set({ externalSessionId: null })
      .where(eq(playgroundSessions.id, notification.id));
    await deleteBareNotificationSession(notification.id);
    const gone = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, notification.id));
    expect(gone).toHaveLength(0);

    // Cleanup.
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
  });
});
