/**
 * FOH read cursors against a REAL Postgres (WP7): markSessionRead advances the viewer's
 * conversation_reads cursor to the session's lastEventAt (only-advance, D3) and auto-resolves
 * the viewer's `finished` inbox items (D13) while leaving question/approval items and other
 * users' finished items pending.
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at a live dev database
 * (`HARNESST_DB_SMOKE=1 npx vitest run tests/integration/foh-reads.db.test.ts` with .env.local
 * sourced). Creates and removes its own rows; safe to re-run.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("FOH read cursor against real Postgres", () => {
  it("advances only forward and resolves the viewer's finished items on read", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const { projects, agents } = await import("~/db/schema");
    const { createPlaygroundSession } = await import(
      "~/playground/sessions.server"
    );
    const { markSessionRead } = await import("~/foh/reads.server");
    const { drizzleDataStore } = await import("~/data/drizzle.server");

    const ORG = "org_foh_reads";
    const USER = "user_foh_reads";
    const OTHER = "user_foh_reads2";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.delete(user).where(eq(user.id, OTHER));
    await db.insert(organization).values({
      id: ORG,
      name: "foh reads",
      slug: "foh-reads-smoke",
      createdAt: now,
    });
    await db.insert(user).values([
      {
        id: USER,
        name: "Reads Smoke",
        email: "foh-reads@smoke.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: OTHER,
        name: "Reads Smoke 2",
        email: "foh-reads2@smoke.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh-reads", slug: "foh-reads-smoke" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();

    try {
      const lastEventAt = new Date("2026-07-24T10:00:00Z");
      const session = await createPlaygroundSession({
        projectId: project.id,
        agentId: agent.id,
        userId: USER,
        surface: "foh",
        lastEventAt,
      });

      const finishedMine = await drizzleDataStore.inboxItems.insert({
        projectId: project.id,
        sessionId: session.id,
        kind: "finished",
        userId: USER,
      });
      const finishedOther = await drizzleDataStore.inboxItems.insert({
        projectId: project.id,
        sessionId: session.id,
        kind: "finished",
        userId: OTHER,
      });
      const question = await drizzleDataStore.inboxItems.insert({
        projectId: project.id,
        sessionId: session.id,
        kind: "question",
        userId: null,
        requestId: "req_1",
        prompt: "Which one?",
      });

      await markSessionRead(session, USER, drizzleDataStore);

      // Cursor sits at lastEventAt → the session reads as caught-up.
      const reads = await drizzleDataStore.conversationReads.listForUser(USER, [
        session.id,
      ]);
      expect(reads).toHaveLength(1);
      expect(reads[0].lastReadAt.getTime()).toBe(lastEventAt.getTime());

      // The viewer's finished item resolved; the question and the OTHER user's finished
      // item stay pending.
      const pending = await drizzleDataStore.inboxItems.findPendingBySession(
        session.id,
      );
      expect(new Set(pending.map((item) => item.id))).toEqual(
        new Set([finishedOther.id, question.id]),
      );
      expect(pending.find((i) => i.id === finishedMine.id)).toBeUndefined();

      // Only-advance: a stale re-read with an older lastEventAt never rewinds the cursor.
      await markSessionRead(
        { id: session.id, lastEventAt: new Date("2026-07-24T09:00:00Z") },
        USER,
        drizzleDataStore,
      );
      const after = await drizzleDataStore.conversationReads.listForUser(USER, [
        session.id,
      ]);
      expect(after[0].lastReadAt.getTime()).toBe(lastEventAt.getTime());

      // A newer event advances it.
      const newer = new Date("2026-07-24T11:00:00Z");
      await markSessionRead(
        { id: session.id, lastEventAt: newer },
        USER,
        drizzleDataStore,
      );
      const advanced = await drizzleDataStore.conversationReads.listForUser(
        USER,
        [session.id],
      );
      expect(advanced[0].lastReadAt.getTime()).toBe(newer.getTime());
    } finally {
      await db.delete(organization).where(eq(organization.id, ORG));
      await db.delete(user).where(eq(user.id, USER));
      await db.delete(user).where(eq(user.id, OTHER));
    }
  });
});
