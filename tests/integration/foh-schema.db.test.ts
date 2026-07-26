/**
 * FOH session substrate against a REAL Postgres (WP2): the surface discriminator's isolation
 * guarantee (foh/playground/assistant are three disjoint spaces — each list sees only its own
 * surface's rows, the §6 regression criterion in DB form), the 0018 legacy-assistant backfill,
 * agent-opened rows (nullable created_by + opened_by_agent_id),
 * conversation_reads upsert/unread math, inbox insert/resolve, pending-input stop-wins guard,
 * and the FK cascades that keep a deleted session from stranding inbox/read rows.
 *
 * Opt-in: runs only when HARNESST_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`HARNESST_DB_SMOKE=1 npx vitest run tests/integration/foh-schema.db.test.ts` with .env.local
 * sourced). Creates its own org/user/project/agent rows and deletes them, so it's safe to re-run.
 */
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("FOH session substrate against real Postgres", () => {
  it("isolates surfaces, tracks reads/unread, and cascades inbox rows with the session", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const { projects, agents, playgroundSessions, inboxItems, conversationReads } =
      await import("~/db/schema");
    const {
      createPlaygroundSession,
      listPlaygroundSessions,
      getPlaygroundSession,
      listFohSessionsForAgent,
      markSessionPendingInput,
      clearSessionPendingInput,
      markPlaygroundSessionStopped,
    } = await import("~/playground/sessions.server");
    const { drizzleDataStore } = await import("~/data/drizzle.server");

    const ORG = "org_foh_smoke";
    const USER = "user_foh_smoke";
    const OTHER = "user_foh_smoke2";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, OTHER));
    await db.insert(organization).values({
      id: ORG,
      name: "foh smoke",
      slug: "foh-smoke",
      createdAt: now,
    });
    await db.insert(user).values([
      {
        id: USER,
        name: "FOH Smoke",
        email: "foh@smoke.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: OTHER,
        name: "FOH Smoke 2",
        email: "foh2@smoke.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh", slug: "foh-smoke" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();

    const scope = { projectId: project.id, agentId: agent.id, userId: USER };

    // One session per surface, same (project, agent, creator).
    const playgroundRow = await createPlaygroundSession({ ...scope });
    const assistantRow = await createPlaygroundSession({
      ...scope,
      surface: "assistant",
    });
    const fohRow = await createPlaygroundSession({ ...scope, surface: "foh" });
    // Agent-opened FOH row (D6): no human creator.
    const agentOpened = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: null,
      surface: "foh",
      openedByAgentId: agent.id,
    });
    expect(agentOpened).toMatchObject({
      createdBy: null,
      surface: "foh",
      openedByAgentId: agent.id,
    });

    // Three-way surface isolation (issue #221 PRD gap 2): each surface's list sees ONLY its
    // own rows, even for the same (project, agent, creator).
    const builderIds = (await listPlaygroundSessions(scope)).map((s) => s.id);
    expect(builderIds).toContain(playgroundRow.id);
    expect(builderIds).not.toContain(assistantRow.id);
    expect(builderIds).not.toContain(fohRow.id);
    expect(builderIds).not.toContain(agentOpened.id);
    const assistantIds = (
      await listPlaygroundSessions({ ...scope, surface: "assistant" })
    ).map((s) => s.id);
    expect(assistantIds).toContain(assistantRow.id);
    expect(assistantIds).not.toContain(playgroundRow.id);
    expect(assistantIds).not.toContain(fohRow.id);
    expect(
      await getPlaygroundSession({ ...scope, id: fohRow.id }),
    ).toBeNull();
    expect(
      await getPlaygroundSession({ ...scope, id: assistantRow.id }),
    ).toBeNull();
    expect(
      await getPlaygroundSession({
        ...scope,
        id: assistantRow.id,
        surface: "assistant",
      }),
    ).not.toBeNull();

    // Backfill proof (migration 0018): a legacy-shaped row — surface 'playground' (0015's
    // column default) on a kind-'assistant' agent — flips to 'assistant' under the backfill
    // UPDATE, and a genuine playground row on a member agent is untouched.
    const [assistantAgent] = await db
      .insert(agents)
      .values({
        projectId: project.id,
        name: "harnesst-assistant",
        root: "agents/harnesst-assistant/agent",
        kind: "assistant",
      })
      .returning();
    const legacyRow = await createPlaygroundSession({
      projectId: project.id,
      agentId: assistantAgent.id,
      userId: USER,
      // No surface passed: legacy rows carry the 0015 default 'playground'.
    });
    await db.execute(sql`
      UPDATE "playground_sessions"
      SET "surface" = 'assistant'
      WHERE "surface" = 'playground'
        AND "agent_id" IN (SELECT "id" FROM "agents" WHERE "kind" = 'assistant')
    `);
    const [backfilled] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, legacyRow.id));
    expect(backfilled.surface).toBe("assistant");
    const [untouched] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, playgroundRow.id));
    expect(untouched.surface).toBe("playground");

    const fohIds = (
      await listFohSessionsForAgent({
        projectId: project.id,
        agentId: agent.id,
        viewerId: USER,
      })
    ).map((s) => s.id);
    expect(fohIds).toContain(fohRow.id);
    expect(fohIds).toContain(agentOpened.id); // created_by IS NULL is member-visible
    expect(fohIds).not.toContain(playgroundRow.id);
    expect(fohIds).not.toContain(assistantRow.id);

    // Member scoping: another member sees only agent-opened rows, unless includeAll (admin).
    const otherView = await listFohSessionsForAgent({
      projectId: project.id,
      agentId: agent.id,
      viewerId: OTHER,
    });
    expect(otherView.map((s) => s.id)).toEqual([agentOpened.id]);
    const adminView = await listFohSessionsForAgent({
      projectId: project.id,
      agentId: agent.id,
      viewerId: OTHER,
      includeAll: true,
    });
    expect(new Set(adminView.map((s) => s.id))).toEqual(
      new Set([fohRow.id, agentOpened.id]),
    );

    // Unread math (D3): lastEventAt vs the viewer's read cursor, only-advance upsert.
    const eventAt = new Date("2026-07-01T10:00:00Z");
    await db
      .update(playgroundSessions)
      .set({ lastEventAt: eventAt })
      .where(eq(playgroundSessions.id, fohRow.id));
    let [listed] = (
      await listFohSessionsForAgent({
        projectId: project.id,
        agentId: agent.id,
        viewerId: USER,
      })
    ).filter((s) => s.id === fohRow.id);
    expect(listed.unread).toBe(true);

    await drizzleDataStore.conversationReads.upsert(fohRow.id, USER, new Date("2026-07-01T11:00:00Z"));
    [listed] = (
      await listFohSessionsForAgent({
        projectId: project.id,
        agentId: agent.id,
        viewerId: USER,
      })
    ).filter((s) => s.id === fohRow.id);
    expect(listed.unread).toBe(false);

    // Only-advance: a stale rewind attempt is a no-op…
    await drizzleDataStore.conversationReads.upsert(fohRow.id, USER, new Date("2026-07-01T09:00:00Z"));
    const reads = await drizzleDataStore.conversationReads.listForUser(USER, [fohRow.id]);
    expect(reads[0].lastReadAt.toISOString()).toBe("2026-07-01T11:00:00.000Z");
    // …and a newer event flips unread back on.
    await db
      .update(playgroundSessions)
      .set({ lastEventAt: new Date("2026-07-01T12:00:00Z") })
      .where(eq(playgroundSessions.id, fohRow.id));
    [listed] = (
      await listFohSessionsForAgent({
        projectId: project.id,
        agentId: agent.id,
        viewerId: USER,
      })
    ).filter((s) => s.id === fohRow.id);
    expect(listed.unread).toBe(true);

    // pending-input chokepoint writers: set → needs-you-first ordering; clear; stop-wins guard.
    await markSessionPendingInput(fohRow.id, new Date("2026-07-01T12:30:00Z"));
    const ordered = await listFohSessionsForAgent({
      projectId: project.id,
      agentId: agent.id,
      viewerId: USER,
    });
    expect(ordered[0].id).toBe(fohRow.id);
    expect(ordered[0].pendingInputAt?.toISOString()).toBe("2026-07-01T12:30:00.000Z");
    await clearSessionPendingInput(fohRow.id);
    const [cleared] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, fohRow.id));
    expect(cleared.pendingInputAt).toBeNull();
    // Stop wins: a late park write on a stopped session is a no-op.
    await markPlaygroundSessionStopped({ id: agentOpened.id });
    await markSessionPendingInput(agentOpened.id);
    const [stopped] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, agentOpened.id));
    expect(stopped.pendingInputAt).toBeNull();

    // Inbox insert/resolve against real rows.
    const item = await drizzleDataStore.inboxItems.insert({
      projectId: project.id,
      sessionId: fohRow.id,
      kind: "question",
      prompt: "Which account?",
      requestId: "req_smoke_1",
      agentId: agent.id,
      userId: USER,
    });
    const teamItem = await drizzleDataStore.inboxItems.insert({
      projectId: project.id,
      sessionId: agentOpened.id,
      kind: "approval",
      userId: null,
    });
    expect(
      await drizzleDataStore.inboxItems.countPendingForProjects([project.id], OTHER),
    ).toBe(1); // only the team-wide item
    expect(
      await drizzleDataStore.inboxItems.countPendingForProjects([project.id], USER),
    ).toBe(2);
    await drizzleDataStore.inboxItems.resolveBySession(fohRow.id, [
      "question",
      "approval",
    ]);
    const pendingAfter = await drizzleDataStore.inboxItems.findPendingBySession(fohRow.id);
    expect(pendingAfter).toHaveLength(0);
    expect(
      await drizzleDataStore.inboxItems.listPendingForProjects([project.id], USER),
    ).toMatchObject([{ id: teamItem.id }]);

    // Cascade: deleting the session removes its inbox items and read cursors.
    await db.delete(playgroundSessions).where(eq(playgroundSessions.id, fohRow.id));
    const [orphanItem] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, item.id));
    expect(orphanItem).toBeUndefined();
    const orphanReads = await db
      .select()
      .from(conversationReads)
      .where(
        and(
          eq(conversationReads.sessionId, fohRow.id),
          eq(conversationReads.userId, USER),
        ),
      );
    expect(orphanReads).toHaveLength(0);

    // Cleanup (org/user cascade the rest).
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, OTHER));
  });
});
