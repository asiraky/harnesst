/**
 * FOH session substrate against a REAL Postgres (WP2): the surface discriminator's isolation
 * guarantee (foh/playground/assistant are three disjoint spaces — each list sees only its own
 * surface's rows, the §6 regression criterion in DB form), the 0018 legacy-assistant backfill,
 * agent-opened rows (nullable created_by + opened_by_agent_id),
 * conversation_reads upsert/unread math, inbox insert/resolve, pending-input stop-wins guard,
 * and the FK cascades that keep a deleted session from stranding inbox/read rows.
 *
 * Second scenario: the archive lifecycle (#278). Every part of it is a SQL predicate — which
 * rows a list can see, which rows a mutation may touch, and what the ON DELETE cascades take
 * with them — so it can only be proved here, against a real database.
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

  it("archives, hides, restores and permanently deletes FOH conversations", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const {
      projects,
      agents,
      playgroundSessions,
      assistantCheckouts,
      inboxItems,
      conversationReads,
    } = await import("~/db/schema");
    const {
      adoptChannelHomedSession,
      archiveFohSession,
      countArchivedFohSessions,
      createPlaygroundSession,
      deleteFohSessionPermanently,
      getFohSessionForViewer,
      listArchivedFohSessions,
      listFohSessionsForAgent,
      markSessionPendingInput,
      restoreFohSession,
      unarchiveFohSessionForViewer,
    } = await import("~/playground/sessions.server");
    const { listTeamActivity } = await import("~/foh/activity.server");
    const { drizzleDataStore } = await import("~/data/drizzle.server");

    const ORG = "org_foh_archive";
    const USER = "user_foh_archive";
    const OTHER = "user_foh_archive2";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, OTHER));
    await db.insert(organization).values({
      id: ORG,
      name: "foh archive",
      slug: "foh-archive",
      createdAt: now,
    });
    await db.insert(user).values([
      {
        id: USER,
        name: "Archie",
        email: "archie@smoke.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: OTHER,
        name: "Otto",
        email: "otto@smoke.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh", slug: "foh-archive" })
      .returning();
    const [otherProject] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh2", slug: "foh-archive-2" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();
    const [otherAgent] = await db
      .insert(agents)
      .values({
        projectId: otherProject.id,
        name: "ivy",
        root: "agents/ivy/agent",
      })
      .returning();

    const scope = { projectId: project.id, agentId: agent.id };
    const mine = await createPlaygroundSession({
      ...scope,
      userId: USER,
      surface: "foh",
      title: "Invoice run",
    });
    const theirs = await createPlaygroundSession({
      ...scope,
      userId: OTHER,
      surface: "foh",
      title: "Otto's thread",
    });
    const agentOpened = await createPlaygroundSession({
      ...scope,
      userId: null,
      surface: "foh",
      openedByAgentId: agent.id,
    });

    const listFor = async (viewerId: string, includeAll = false) =>
      (
        await listFohSessionsForAgent({ ...scope, viewerId, includeAll })
      ).map((s) => s.id);

    // 1. Archive hides the row from the list and from every single-row read — which is what
    //    404s a bookmarked URL and the stream/stop/read posts without an extra check anywhere.
    expect(await listFor(USER)).toContain(mine.id);
    const archived = await archiveFohSession({
      id: mine.id,
      projectId: project.id,
      viewerId: USER,
    });
    expect(archived.ok).toBe(true);
    expect(await listFor(USER)).not.toContain(mine.id);
    expect(await listFor(OTHER, true)).not.toContain(mine.id);
    expect(
      await getFohSessionForViewer({
        id: mine.id,
        projectId: project.id,
        viewerId: USER,
      }),
    ).toBeNull();
    // The archive mutations themselves must still find it (undo, idempotent re-archive).
    expect(
      await getFohSessionForViewer({
        id: mine.id,
        projectId: project.id,
        viewerId: USER,
        includeArchived: true,
      }),
    ).toMatchObject({ id: mine.id, archivedBy: USER });

    // 2. Undo round-trips it back into the list, marks cleared.
    const undone = await unarchiveFohSessionForViewer({
      id: mine.id,
      projectId: project.id,
      viewerId: USER,
    });
    expect(undone).toMatchObject({
      ok: true,
      session: { archivedAt: null, archivedBy: null },
    });
    expect(await listFor(USER)).toContain(mine.id);

    // 3. Visibility: a member cannot archive another member's conversation; an admin can.
    expect(
      await archiveFohSession({
        id: theirs.id,
        projectId: project.id,
        viewerId: USER,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    const [stillThere] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, theirs.id));
    expect(stillThere.archivedAt).toBeNull();
    expect(
      await archiveFohSession({
        id: theirs.id,
        projectId: project.id,
        viewerId: USER,
        includeAll: true,
      }),
    ).toMatchObject({ ok: true });

    // 4. A live turn is refused outright — stop it first.
    await db
      .update(playgroundSessions)
      .set({ status: "running" })
      .where(eq(playgroundSessions.id, agentOpened.id));
    expect(
      await archiveFohSession({
        id: agentOpened.id,
        projectId: project.id,
        viewerId: USER,
      }),
    ).toEqual({ ok: false, reason: "working" });
    await db
      .update(playgroundSessions)
      .set({ status: "waiting" })
      .where(eq(playgroundSessions.id, agentOpened.id));

    // 5. Archiving resolves EVERY pending inbox item — a stop leaves `finished` to be
    //    acknowledged by opening the session, but an archived row can never be opened, so an
    //    item left behind would be a bell entry whose link 404s.
    const parkedItem = await drizzleDataStore.inboxItems.insert({
      projectId: project.id,
      sessionId: agentOpened.id,
      kind: "question",
      prompt: "Which account?",
      requestId: "req_archive_1",
      agentId: agent.id,
      userId: null,
    });
    const finishedItem = await drizzleDataStore.inboxItems.insert({
      projectId: project.id,
      sessionId: agentOpened.id,
      kind: "finished",
      agentId: agent.id,
      userId: null,
    });
    await archiveFohSession({
      id: agentOpened.id,
      projectId: project.id,
      viewerId: USER,
    });
    expect(
      await drizzleDataStore.inboxItems.findPendingBySession(agentOpened.id),
    ).toHaveLength(0);
    const [resolvedItem] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, parkedItem.id));
    expect(resolvedItem.status).toBe("resolved");
    const [resolvedFinished] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, finishedItem.id));
    expect(resolvedFinished.status).toBe("resolved");

    // 5b. A drain or reattach that settles a moment AFTER the archive must lose the way a stop
    //     makes it lose: no park flag on a row no FOH read can see, and `false` back so the
    //     caller skips its inbox inserts.
    expect(await markSessionPendingInput(agentOpened.id)).toBe(false);
    const [stillArchived] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, agentOpened.id));
    expect(stillArchived.pendingInputAt).toBeNull();

    // 6. A fresh question RESURFACES an archived conversation: adopt un-archives, on the
    //    winning upsert and on the mid-turn fallback alike. A lost question is the worst
    //    failure mode this feature could have.
    const parkInput = {
      projectId: project.id,
      agentId: agent.id,
      environmentId: null,
      version: null,
      externalSessionId: agentOpened.externalSessionId ?? "eve_archive_1",
      continuationToken: "tok_archive_1",
      resumeVia: null as never,
      staleAfterMs: 300_000,
      now: new Date(),
    };
    await db
      .update(playgroundSessions)
      .set({ externalSessionId: parkInput.externalSessionId })
      .where(eq(playgroundSessions.id, agentOpened.id));
    const parked = await adoptChannelHomedSession(parkInput);
    expect(parked).toMatchObject({
      ok: true,
      parkDeferred: false,
      session: { id: agentOpened.id, archivedAt: null, archivedBy: null },
    });
    expect(await listFor(USER)).toContain(agentOpened.id);

    // Mid-turn: the fenced upsert skips under a live claim, but the narrow fallback still
    // clears the archive marks — nothing about them is owned by the turn.
    await db
      .update(playgroundSessions)
      .set({
        status: "running",
        updatedAt: new Date(),
        archivedAt: new Date(),
        archivedBy: USER,
      })
      .where(eq(playgroundSessions.id, agentOpened.id));
    const deferred = await adoptChannelHomedSession({
      ...parkInput,
      now: new Date(),
    });
    expect(deferred).toMatchObject({
      ok: true,
      parkDeferred: true,
      session: { archivedAt: null, archivedBy: null },
    });
    await db
      .update(playgroundSessions)
      .set({ status: "waiting" })
      .where(eq(playgroundSessions.id, agentOpened.id));

    // 7. The row-spam guard counts UNARCHIVED rows: 100 tidied-away conversations plus three
    //    live ones is three, so tidying up genuinely makes room for new work.
    const [spamAgent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "spam", root: "agents/spam/agent" })
      .returning();
    await db.insert(playgroundSessions).values(
      Array.from({ length: 100 }, () => ({
        projectId: project.id,
        agentId: spamAgent.id,
        createdBy: USER,
        surface: "foh" as const,
        archivedAt: new Date(),
        archivedBy: USER,
      })),
    );
    for (let i = 0; i < 3; i++) {
      await createPlaygroundSession({
        projectId: project.id,
        agentId: spamAgent.id,
        userId: USER,
        surface: "foh",
      });
    }
    const spamList = await listFohSessionsForAgent({
      projectId: project.id,
      agentId: spamAgent.id,
      viewerId: USER,
    });
    expect(spamList).toHaveLength(3);

    // 8. The team feed drops the "session opened" entry with the conversation.
    const feed = await listTeamActivity(project.id, {
      viewer: { userId: USER, backOfHouse: true },
      limit: 200,
    });
    const openedIds = feed.events
      .filter((event) => event.type === "session")
      .map((event) => event.sessionId);
    expect(openedIds).toContain(mine.id); // restored in step 2
    expect(openedIds).not.toContain(theirs.id); // archived in step 3

    // 9. The back-of-house listing is repo-scoped, FOH-only, archived-only.
    const foreignArchived = await createPlaygroundSession({
      projectId: otherProject.id,
      agentId: otherAgent.id,
      userId: USER,
      surface: "foh",
    });
    const builderArchived = await createPlaygroundSession({
      ...scope,
      userId: USER,
      surface: "playground",
    });
    await db
      .update(playgroundSessions)
      .set({ archivedAt: new Date(), archivedBy: USER })
      .where(eq(playgroundSessions.id, foreignArchived.id));
    await db
      .update(playgroundSessions)
      .set({ archivedAt: new Date(), archivedBy: USER })
      .where(eq(playgroundSessions.id, builderArchived.id));

    const listed = await listArchivedFohSessions(project.id);
    const listedIds = listed.map((row) => row.id);
    expect(listedIds).toContain(theirs.id);
    expect(listedIds).not.toContain(mine.id); // restored, so not archived
    expect(listedIds).not.toContain(foreignArchived.id); // another repo
    expect(listedIds).not.toContain(builderArchived.id); // another surface
    expect(listed.find((row) => row.id === theirs.id)).toMatchObject({
      title: "Otto's thread",
      agentName: "ivy",
      openedBy: "Otto",
      archivedBy: "Archie",
    });
    expect(await countArchivedFohSessions(project.id)).toBe(listed.length);
    expect(await countArchivedFohSessions(otherProject.id)).toBe(1);

    // 10. Permanent delete refuses anything that is not archived — archiving first is the
    //     mandatory, reversible step, and it is the only thing standing between the back of
    //     house and a live conversation.
    expect(
      await deleteFohSessionPermanently({
        id: mine.id,
        projectId: project.id,
        backOfHouse: true,
      }),
    ).toBe(false);
    const [survivor] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, mine.id));
    expect(survivor).toBeDefined();

    // 11. …and takes every child row with it once the session IS archived: read cursors,
    //     inbox items and the assistant checkout, all by ON DELETE cascade.
    await archiveFohSession({
      id: mine.id,
      projectId: project.id,
      viewerId: USER,
    });
    await drizzleDataStore.conversationReads.upsert(mine.id, USER, new Date());
    const doomedItem = await drizzleDataStore.inboxItems.insert({
      projectId: project.id,
      sessionId: mine.id,
      kind: "approval",
      userId: USER,
    });
    const [checkout] = await db
      .insert(assistantCheckouts)
      .values({
        conversationId: mine.id,
        projectId: project.id,
        branch: "harnesst/conv-x",
        baseBranch: "main",
      })
      .returning();

    expect(
      await deleteFohSessionPermanently({
        id: mine.id,
        projectId: project.id,
        backOfHouse: true,
      }),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(playgroundSessions)
        .where(eq(playgroundSessions.id, mine.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(conversationReads)
        .where(eq(conversationReads.sessionId, mine.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(inboxItems).where(eq(inboxItems.id, doomedItem.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(assistantCheckouts)
        .where(eq(assistantCheckouts.id, checkout.id)),
    ).toHaveLength(0);

    // A restore from the back of house is the same transition as the FOH undo.
    expect(
      await restoreFohSession({
        id: theirs.id,
        projectId: project.id,
        backOfHouse: true,
      }),
    ).toMatchObject({ archivedAt: null, archivedBy: null });
    expect(await listFor(OTHER)).toContain(theirs.id);

    // Cleanup (org/user cascade the rest).
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, OTHER));
  });
});
