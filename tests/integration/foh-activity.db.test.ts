/**
 * FOH activity feed against a REAL Postgres (WP8): seed the synthetic sam → ivy scenario —
 * deployment, human-opened session, delegation with its linked teammate run (+ steps),
 * agent-opened session, and a plain run — then assert the projection reconstructs it in
 * wall-clock order with the exchange expandable from the linked run (§6 legibility in DB
 * form), tolerating a delegation whose run recording never landed. Also covers the point-of-
 * view attribution (#212 §3: foh-channel runs read "Aaron messaged sam") and the viewer
 * policy (issue #221 finding 3): members see only sessions they can open, and run events keep
 * their metadata but redact input/error — and the actor — unless the run is theirs to read.
 *
 * Opt-in: runs only when HARNESST_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`HARNESST_DB_SMOKE=1 npx vitest run tests/integration/foh-activity.db.test.ts` with
 * .env.local sourced). Creates its own rows and deletes them, so it's safe to re-run.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("FOH activity projection against real Postgres", () => {
  it("reconstructs the sam → ivy scenario in order, with the exchange expansion", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const {
      projects,
      agents,
      environments,
      releases,
      deployments,
      playgroundSessions,
      delegations,
      runs,
      runSteps,
      sessions,
    } = await import("~/db/schema");
    const { listTeamActivity, getDelegationExchange } = await import(
      "~/foh/activity.server"
    );

    const ORG = "org_foh_activity";
    const USER = "user_foh_activity";
    const USER2 = "user_foh_activit2";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, USER2));
    await db.insert(organization).values({
      id: ORG,
      name: "foh activity",
      slug: "foh-activity-smoke",
      createdAt: now,
    });
    await db.insert(user).values({
      id: USER,
      name: "Aaron",
      email: "foh-activity@smoke.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(user).values({
      id: USER2,
      name: "Blair",
      email: "foh-activity-2@smoke.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "agency", slug: "foh-activity-smoke" })
      .returning();
    const [sam] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "sam", root: "agents/sam/agent" })
      .returning();
    const [ivy] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();

    const t = (min: number) => new Date(Date.UTC(2026, 6, 24, 10, min, 0));

    // 10:00 — ivy's deployment goes live.
    const [env] = await db
      .insert(environments)
      .values({ projectId: project.id, agentId: ivy.id, name: "default" })
      .returning();
    const [release] = await db
      .insert(releases)
      .values({ projectId: project.id, agentId: ivy.id, version: "v3", gitSha: "abc123" })
      .returning();
    const [deployment] = await db
      .insert(deployments)
      .values({
        environmentId: env.id,
        releaseId: release.id,
        status: "live",
        url: "http://127.0.0.1:1",
        createdAt: t(0),
      })
      .returning();

    // 10:10 — Aaron opens a session with sam. The eve session id links the FOH session to its
    // observability session, so his foh-channel run below both attributes back to him (#212)
    // and stays a session he can open (issue #221 F3).
    const AARON_EVE_SESSION = "wses_foh_activity_aaron";
    const [humanSession] = await db
      .insert(playgroundSessions)
      .values({
        projectId: project.id,
        agentId: sam.id,
        createdBy: USER,
        surface: "foh",
        externalSessionId: AARON_EVE_SESSION,
        title: "the pricing page is broken",
        createdAt: t(10),
      })
      .returning();

    // Builder-surface noise must never appear in the feed.
    await db.insert(playgroundSessions).values({
      projectId: project.id,
      agentId: sam.id,
      createdBy: USER,
      surface: "playground",
      title: "builder noise",
      createdAt: t(11),
    });

    // 10:12 — Blair opens her own session with sam. Her title (and any run content of hers)
    // is invisible to other members.
    const [user2Session] = await db
      .insert(playgroundSessions)
      .values({
        projectId: project.id,
        agentId: sam.id,
        createdBy: USER2,
        surface: "foh",
        title: "am I being paid fairly?",
        createdAt: t(12),
      })
      .returning();

    // 10:20 — a plain (non-delegation) run for sam, attributed to Aaron's FOH session the way
    // the reconciler does it: an observability `sessions` row keyed by the eve external
    // session id, with runs.session_id holding that row's internal id. The feed reads it as
    // "Aaron messaged sam" (#212 §3), and only Aaron/back-of-house may read its content (F3).
    const [obsSession] = await db
      .insert(sessions)
      .values({
        projectId: project.id,
        agentId: sam.id,
        externalSessionId: AARON_EVE_SESSION,
        channel: "foh",
        startedAt: t(20),
      })
      .returning();
    const [plainRun] = await db
      .insert(runs)
      .values({
        projectId: project.id,
        agentId: sam.id,
        sessionId: obsSession.id,
        channel: "foh",
        status: "completed",
        metadata: { input: "look at the pricing page" },
        startedAt: t(20),
      })
      .returning();

    // 10:21 — an admin's assistant-channel run: the EVENT is team activity, its prompt and
    // error are back-of-house content.
    const [assistantRun] = await db
      .insert(runs)
      .values({
        projectId: project.id,
        agentId: sam.id,
        channel: "assistant",
        status: "failed",
        metadata: { input: "rotate the production API keys" },
        error: "the assistant blew up",
        startedAt: t(21),
      })
      .returning();

    // 10:44 — sam → ivy delegation: linked teammate run with the full exchange steps.
    const [delegationRun] = await db
      .insert(runs)
      .values({
        projectId: project.id,
        agentId: ivy.id,
        channel: "teammate",
        status: "completed",
        metadata: {
          input: "can you check DNS for harnesst.dev?",
          delegationId: "pending", // patched below once the delegation row exists
          fromAgentId: sam.id,
          fromAgentName: "sam",
        },
        startedAt: t(44),
      })
      .returning();
    const [delegationRow] = await db
      .insert(delegations)
      .values({
        projectId: project.id,
        fromAgentId: sam.id,
        fromEnvironmentId: env.id,
        toAgentId: ivy.id,
        toEnvironmentId: env.id,
        runId: delegationRun.id,
        status: "completed",
        startedAt: t(44),
        finishedAt: t(46),
      })
      .returning();
    await db
      .update(runs)
      .set({
        metadata: {
          input: "can you check DNS for harnesst.dev?",
          delegationId: delegationRow.id,
          fromAgentId: sam.id,
          fromAgentName: "sam",
        },
      })
      .where(eq(runs.id, delegationRun.id));
    await db.insert(runSteps).values([
      {
        runId: delegationRun.id,
        seq: 1,
        type: "message",
        data: { role: "user", text: "can you check DNS for harnesst.dev?" },
      },
      { runId: delegationRun.id, seq: 2, type: "model_call", data: {} },
      {
        runId: delegationRun.id,
        seq: 3,
        type: "tool_call",
        toolName: "bash",
        data: { summary: "dig harnesst.dev" },
      },
      {
        runId: delegationRun.id,
        seq: 4,
        type: "message",
        data: { role: "assistant", text: "DNS is healthy — A record points at the LB." },
      },
    ]);

    // 10:45 — a second delegation parks on a human and opens ivy's agent-side session.
    // The relayed ask lands in the linked run's metadata; the REAL exchange lives in the
    // FOH session's eve stream (relay parking), read best-effort against a live target.
    const PARKED_ASK = 'From your teammate "sam": which registrar for harnesst.dev?';
    const [parkedRun] = await db
      .insert(runs)
      .values({
        projectId: project.id,
        agentId: ivy.id,
        channel: "teammate",
        status: "completed",
        metadata: { input: PARKED_ASK, fromAgentId: sam.id, fromAgentName: "sam" },
        startedAt: t(45),
      })
      .returning();
    const [waitingDelegation] = await db
      .insert(delegations)
      .values({
        projectId: project.id,
        fromAgentId: sam.id,
        fromEnvironmentId: env.id,
        toAgentId: ivy.id,
        toEnvironmentId: env.id,
        runId: parkedRun.id,
        status: "waiting",
        startedAt: t(45),
        finishedAt: t(45),
      })
      .returning();
    await db
      .update(runs)
      .set({
        metadata: {
          input: PARKED_ASK,
          delegationId: waitingDelegation.id,
          fromAgentId: sam.id,
          fromAgentName: "sam",
        },
      })
      .where(eq(runs.id, parkedRun.id));
    const [agentSession] = await db
      .insert(playgroundSessions)
      .values({
        projectId: project.id,
        agentId: ivy.id,
        createdBy: null,
        openedByAgentId: sam.id,
        delegationId: waitingDelegation.id,
        surface: "foh",
        title: "Which registrar account should I use?",
        createdAt: t(46),
      })
      .returning();
    // A third delegation whose run recording never landed (runId null — best-effort)
    // and that opened no session: the expansion must degrade cleanly.
    const [bareDelegation] = await db
      .insert(delegations)
      .values({
        projectId: project.id,
        fromAgentId: sam.id,
        fromEnvironmentId: env.id,
        toAgentId: ivy.id,
        toEnvironmentId: env.id,
        status: "waiting",
        startedAt: t(47),
        finishedAt: t(47),
      })
      .returning();

    const asAdmin = { viewer: { userId: USER, backOfHouse: true } };
    const asAaron = { viewer: { userId: USER, backOfHouse: false } };
    const asBlair = { viewer: { userId: USER2, backOfHouse: false } };

    // The projection reconstructs the scenario newest-first, builder noise and the
    // delegation-linked run excluded. Back of house sees everything, unredacted.
    const page = await listTeamActivity(project.id, asAdmin);
    const ids = page.events.map((e) => e.id);
    expect(ids).toEqual([
      `delegation:${bareDelegation.id}`,
      `session:${agentSession.id}`,
      `delegation:${waitingDelegation.id}`,
      `delegation:${delegationRow.id}`,
      `run:${assistantRun.id}`,
      `run:${plainRun.id}`,
      `session:${user2Session.id}`,
      `session:${humanSession.id}`,
      `deployment:${deployment.id}`,
    ]);
    expect(page.events[0]).toMatchObject({
      type: "delegation",
      status: "waiting",
      ask: null, // runId never landed
      finishedAt: null, // park-time finishedAt is not an outcome
    });
    expect(page.events[1]).toMatchObject({
      type: "session",
      openedByAgentName: "sam",
      openedByUserName: null,
      agentName: "ivy",
    });
    expect(page.events[2]).toMatchObject({
      type: "delegation",
      status: "waiting",
      ask: PARKED_ASK,
      finishedAt: null,
    });
    expect(page.events[3]).toMatchObject({
      type: "delegation",
      fromAgentName: "sam",
      toAgentName: "ivy",
      ask: "can you check DNS for harnesst.dev?",
      status: "completed",
      finishedAt: t(46).toISOString(),
    });
    expect(page.events[4]).toMatchObject({
      type: "run",
      channel: "assistant",
      status: "failed",
      input: "rotate the production API keys",
      error: "the assistant blew up",
    });
    expect(page.events[5]).toMatchObject({
      type: "run",
      channel: "foh",
      agentName: "sam",
      // Resolved via runs.sessionId → sessions.externalSessionId → the FOH playground
      // session's creator — the read-time attribution join (#212 §3).
      actorUserName: "Aaron",
      input: "look at the pricing page",
    });
    expect(page.events[6]).toMatchObject({
      type: "session",
      openedByUserName: "Blair",
      title: "am I being paid fairly?",
    });
    expect(page.events[7]).toMatchObject({
      type: "session",
      openedByUserName: "Aaron",
      title: "the pricing page is broken",
    });
    expect(page.events[8]).toMatchObject({
      type: "deployment",
      agentName: "ivy",
      version: "v3",
      status: "live",
    });
    expect(page.nextBefore).toBeNull();

    // A member's feed (issue #221 finding 3): session events only for rows they can open
    // (their own + agent-opened — Blair's is absent, not redacted), every run EVENT kept,
    // but input/error only on runs attributable to their own FOH sessions. Delegation
    // entries are agent-authored and stay whole.
    const memberPage = await listTeamActivity(project.id, asAaron);
    expect(memberPage.events.map((e) => e.id)).toEqual([
      `delegation:${bareDelegation.id}`,
      `session:${agentSession.id}`,
      `delegation:${waitingDelegation.id}`,
      `delegation:${delegationRow.id}`,
      `run:${assistantRun.id}`,
      `run:${plainRun.id}`,
      `session:${humanSession.id}`,
      `deployment:${deployment.id}`,
    ]);
    expect(memberPage.events[4]).toMatchObject({
      type: "run",
      channel: "assistant",
      status: "failed", // the event survives —
      input: null, //       its human-authored content does not
      error: null,
    });
    expect(memberPage.events[5]).toMatchObject({
      type: "run",
      channel: "foh",
      input: "look at the pricing page", // his own session's run stays legible
      actorUserName: "Aaron", //           and he may see who messaged sam (it was him)
    });
    expect(memberPage.events[2]).toMatchObject({
      type: "delegation",
      ask: PARKED_ASK,
    });

    // Another member sees their own session but Aaron's run content redacted — including the
    // actor, so #212's "Aaron messaged sam" headline can't leak a session F3 hides from her.
    const member2Page = await listTeamActivity(project.id, asBlair);
    const member2Ids = member2Page.events.map((e) => e.id);
    expect(member2Ids).toContain(`session:${user2Session.id}`);
    expect(member2Ids).not.toContain(`session:${humanSession.id}`);
    expect(
      member2Page.events.find((e) => e.id === `run:${plainRun.id}`),
    ).toMatchObject({
      input: null,
      error: null,
      actorUserName: null,
      status: "completed",
    });

    // Cursor pagination: `before` excludes everything at/after the cutoff.
    const older = await listTeamActivity(project.id, {
      ...asAdmin,
      before: t(44),
    });
    expect(older.events.map((e) => e.id)).toEqual([
      `run:${assistantRun.id}`,
      `run:${plainRun.id}`,
      `session:${user2Session.id}`,
      `session:${humanSession.id}`,
      `deployment:${deployment.id}`,
    ]);

    // The exchange expansion reconstructs who said what and what was done. The leading
    // user message duplicates the ask (already in the header) and is deduped.
    const exchange = await getDelegationExchange(project.id, delegationRow.id);
    expect(exchange).toMatchObject({
      fromAgentName: "sam",
      toAgentName: "ivy",
      status: "completed",
      ask: "can you check DNS for harnesst.dev?",
    });
    expect(exchange?.steps).toEqual([
      { kind: "tool", toolName: "bash", summary: "dig harnesst.dev", isError: false },
      {
        kind: "message",
        role: "assistant",
        text: "DNS is healthy — A record points at the LB.",
      },
    ]);

    // A relay-parked delegation's exchange reads the agent-opened FOH session's eve stream
    // against a live target (#288). None is reachable in this DB-only test, so the steps are
    // omitted — best-effort by design; the header still carries the ask.
    const parked = await getDelegationExchange(project.id, waitingDelegation.id);
    expect(parked).toMatchObject({ status: "waiting", ask: PARKED_ASK });
    expect(parked?.steps).toEqual([]);

    // Null-runId expansion degrades cleanly; other projects' delegations are invisible.
    const bare = await getDelegationExchange(project.id, bareDelegation.id);
    expect(bare).toMatchObject({ ask: null, steps: [], status: "waiting" });
    expect(await getDelegationExchange("proj_nope_12", delegationRow.id)).toBeNull();

    // Cleanup (org cascade takes the project subtree; user rows are independent).
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, USER2));
  });
});
