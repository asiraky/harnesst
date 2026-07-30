/**
 * WS1 end-to-end against a REAL Postgres: an agent working a GitHub issue parks a question, and
 * it becomes an answerable Front of House item for the whole team.
 *
 * The two things only a real database can prove:
 *   - the park is idempotent through the actual unique indexes, not through fake-store bookkeeping
 *     (`playground_sessions_external_uq` on (project_id, external_session_id), and
 *     `inbox_items_session_request_pending_uq` on (session_id, request_id)). The agent's park
 *     fetch is best-effort with a 10s timeout, so a redelivery is the expected case, not the
 *     edge case;
 *   - `resume_via` survives the round trip as jsonb — the answer path reads the route and the
 *     stripped token straight off this column, and a string-vs-object mistake here would only
 *     ever show up at answer time, on a live issue thread.
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at a live dev database
 * (`set -a; source .env.local; set +a; HARNESST_DB_SMOKE=1 npx vitest run
 * tests/integration/foh-park.db.test.ts`). Seeds and removes its own rows.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

const ROUTE = "/eve/v1/github/harnesst/answer";
const STATE = {
  owner: "acme",
  repo: "widgets",
  issueNumber: 7,
  repositoryId: 1310524517,
  conversationKind: "issue",
};

describe.runIf(LIVE)("channel park against real Postgres", () => {
  it("parks once, stays parked on redelivery, and reads back as an answerable item", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const {
      agents,
      deployments,
      environments,
      playgroundSessions,
      projects,
      releases,
    } = await import("~/db/schema");
    const { drizzleDataStore } = await import("~/data/drizzle.server");
    const { defaultParkDeps, parkChannelQuestion } = await import(
      "~/foh/park.server"
    );
    const { beginFohTurn, listInboxForViewer } = await import("~/foh/inbox.server");

    const ORG = "org_foh_park";
    const USER = "user_foh_park";
    const OTHER = "user_foh_park_2";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, OTHER));
    await db.insert(organization).values({
      id: ORG,
      name: "foh park smoke",
      slug: "foh-park-smoke",
      createdAt: now,
    });
    for (const [id, email] of [
      [USER, "foh-park@smoke.test"],
      [OTHER, "foh-park-2@smoke.test"],
    ] as const) {
      await db.insert(user).values({
        id,
        name: "FOH Park",
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh-park", slug: "foh-park-smoke" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();
    const [environment] = await db
      .insert(environments)
      .values({ projectId: project.id, agentId: agent.id, name: "production" })
      .returning();
    const [release] = await db
      .insert(releases)
      .values({
        projectId: project.id,
        agentId: agent.id,
        version: "v1",
        gitSha: "e".repeat(40),
      })
      .returning();
    const [deployment] = await db
      .insert(deployments)
      .values({
        environmentId: environment.id,
        releaseId: release.id,
        status: "live",
        url: "http://fake-eve",
      })
      .returning();

    const park = () =>
      parkChannelQuestion(
        {
          deploymentId: deployment.id,
          channel: "github",
          routePath: ROUTE,
          eveSessionId: "sess_eve_park",
          continuationToken: "github:repo:1310524517:issue:7",
          state: STATE,
          title: "acme/widgets#7",
          requests: [
            {
              requestId: "req_park_1",
              prompt: "Which branch should I target?",
            },
          ],
        },
        {
          ...defaultParkDeps(),
          // The instance behind `url` is fake; the cursor advance is best-effort by design and
          // this test is about the park, not the cursor.
          advanceCursor: async () => {},
        },
      );

    // 1. First park: one session, one item.
    const first = await park();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(first.inboxItemIds).toHaveLength(1);

    let [row] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, first.sessionId));
    expect(row.surface).toBe("foh");
    // Team-wide: a question asked on a public issue belongs to whoever can answer it.
    expect(row.createdBy).toBeNull();
    expect(row.status).toBe("waiting");
    expect(row.pendingInputAt).not.toBeNull();
    expect(row.externalSessionId).toBe("sess_eve_park");
    // The row keeps eve's NAMESPACED token; the descriptor keeps the stripped one.
    expect(row.continuationToken).toBe("github:repo:1310524517:issue:7");
    expect(row.resumeVia).toEqual({
      channel: "github",
      routePath: ROUTE,
      rawToken: "repo:1310524517:issue:7",
      state: STATE,
    });

    // 2. Redelivery (the park fetch timed out on the agent's side and it retried): same ids,
    //    no second conversation and no second item — enforced by the real unique indexes.
    const second = await park();
    expect(second).toEqual(first);
    expect(
      await drizzleDataStore.inboxItems.findPendingBySession(first.sessionId),
    ).toHaveLength(1);

    // 3. Any member of the project sees it, with a jump path into the conversation.
    for (const viewer of [USER, OTHER]) {
      const inbox = await listInboxForViewer({
        userId: viewer,
        projectIds: [project.id],
      });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        kind: "question",
        prompt: "Which branch should I target?",
        sessionId: first.sessionId,
        sessionTitle: "acme/widgets#7",
        href: `/t/${project.id}/${agent.id}/s/${first.sessionId}`,
      });
    }

    // 4. Answering drains it through the ordinary FOH chokepoint — the park needs no special case.
    await beginFohTurn(first.sessionId);
    expect(
      await drizzleDataStore.inboxItems.findPendingBySession(first.sessionId),
    ).toHaveLength(0);
    [row] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, first.sessionId));
    expect(row.pendingInputAt).toBeNull();
    // …and the descriptor survives the drain: it is what routes the ANSWER.
    expect(row.resumeVia).not.toBeNull();

    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, OTHER));
  });

  it("refuses a cross-agent park and defers one that lands mid-turn", async () => {
    // Both guards are pure Postgres semantics — an `ON CONFLICT … WHERE` that matches nothing
    // returns no row — so a fake store cannot prove either of them.
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { agents, playgroundSessions, projects } = await import("~/db/schema");
    const { adoptChannelHomedSession } = await import("~/playground/sessions.server");

    const ORG = "org_foh_park_owner";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({
      id: ORG,
      name: "foh park owner",
      slug: "foh-park-owner",
      createdAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh-park-owner", slug: "foh-park-owner" })
      .returning();
    const [owner] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();
    const [intruder] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "mal", root: "agents/mal/agent" })
      .returning();

    const adopt = (agentId: string, state: Record<string, unknown>) =>
      adoptChannelHomedSession({
        projectId: project.id,
        agentId,
        environmentId: null,
        version: null,
        externalSessionId: "sess_eve_owned",
        continuationToken: "github:repo:1:issue:7",
        resumeVia: { channel: "github", routePath: ROUTE, rawToken: "repo:1:issue:7", state },
        title: "acme/widgets#7",
        staleAfterMs: 5 * 60_000,
        now: new Date(),
      });

    const first = await adopt(owner.id, STATE);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);

    // 1. Another agent in the SAME project, naming the same eve session: the upsert conflicts on
    //    `playground_sessions_external_uq`, the `agent_id` predicate rejects the update, and the
    //    read-back names the refusal. Nothing about the owner's row moves.
    const hijack = await adopt(intruder.id, { owner: "attacker", repo: "elsewhere" });
    expect(hijack).toEqual({ ok: false, reason: "session_not_owned" });
    const rows = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe(owner.id);
    expect(rows[0].resumeVia).toMatchObject({ state: STATE });

    // 2. A park landing inside a LIVE turn must not flip running → waiting under the claim
    //    holder. The resume handles still refresh — no turn owns those — and `parkDeferred` says
    //    the pending flag was left to the drain that holds the claim.
    await db
      .update(playgroundSessions)
      .set({ status: "running", turnClaimId: "claim_1", updatedAt: new Date() })
      .where(eq(playgroundSessions.id, first.session.id));

    const deferred = await adoptChannelHomedSession({
      projectId: project.id,
      agentId: owner.id,
      environmentId: null,
      version: null,
      externalSessionId: "sess_eve_owned",
      continuationToken: "github:repo:1:issue:8",
      resumeVia: {
        channel: "github",
        routePath: ROUTE,
        rawToken: "repo:1:issue:8",
        state: STATE,
      },
      staleAfterMs: 5 * 60_000,
      now: new Date(),
    });

    expect(deferred.ok).toBe(true);
    if (!deferred.ok) throw new Error(deferred.reason);
    expect(deferred.parkDeferred).toBe(true);
    const [after] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, first.session.id));
    expect(after.status).toBe("running");
    expect(after.turnClaimId).toBe("claim_1");
    expect(after.continuationToken).toBe("github:repo:1:issue:8");
    expect(after.resumeVia).toMatchObject({ rawToken: "repo:1:issue:8" });

    // 3. …and once the claim has gone stale the ordinary park path takes over again.
    await db
      .update(playgroundSessions)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(playgroundSessions.id, first.session.id));
    const stale = await adopt(owner.id, STATE);
    expect(stale.ok && stale.parkDeferred).toBe(false);
    const [reparked] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, first.session.id));
    expect(reparked.status).toBe("waiting");
    expect(reparked.pendingInputAt).not.toBeNull();

    await db.delete(organization).where(eq(organization.id, ORG));
  });

  it("clears resume_via with the handles when a dead channel binding is cleared (#288)", async () => {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { agents, playgroundSessions, projects } = await import("~/db/schema");
    const { clearSessionHandles, createPlaygroundSession } =
      await import("~/playground/sessions.server");

    const ORG = "org_foh_park_reseed";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({
      id: ORG,
      name: "foh park reseed",
      slug: "foh-park-reseed",
      createdAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh-park-reseed", slug: "foh-park-reseed" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();

    const session = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: null,
      surface: "foh",
      externalSessionId: "sess_eve_reseed",
      continuationToken: "github:repo:1:issue:1",
      resumeVia: {
        channel: "github",
        routePath: ROUTE,
        rawToken: "repo:1:issue:1",
        state: STATE,
      },
    });

    await clearSessionHandles(session.id);

    const [row] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, session.id));
    // A cleared row starts a NEW eve session on the next turn. Keeping the old descriptor would
    // aim that turn at a channel route holding a token for a session that no longer exists.
    expect(row.externalSessionId).toBeNull();
    expect(row.continuationToken).toBeNull();
    expect(row.resumeVia).toBeNull();
    expect(row.streamIndex).toBe(0);

    await db.delete(organization).where(eq(organization.id, ORG));
  });
});
