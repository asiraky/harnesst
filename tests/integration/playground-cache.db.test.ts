/**
 * Durable transcript cache against a REAL Postgres (issue #48): the reconnect fix persists raw Eve
 * events to `playground_events` as the turn-stream drain reads them, then reconstructs the
 * transcript from harnesst's DB on reconnect — no replay of Eve's whole log from index 0.
 *
 * This proves the two properties the unit fakes can't: (1) the same raw events that the Eve-replay
 * path projects (see tests/unit/playground-replay.test.ts) project IDENTICALLY when sourced from
 * the cache, and (2) the (session, streamIndex) PK makes re-drained writes idempotent.
 *
 * Opt-in: runs only when EDEN_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`EDEN_DB_SMOKE=1 npx vitest run tests/integration/playground-cache.db.test.ts` with .env.local
 * sourced). Creates its own org/project/agent/session rows and deletes them, so it's safe to re-run.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.EDEN_DB_SMOKE === "1";

describe.runIf(LIVE)(
  "playground transcript cache against real Postgres",
  () => {
    it("persists raw events and reprojects the transcript from the cache, idempotently", async () => {
      const { db } = await import("~/db/client.server");
      const { organization, user } = await import("~/db/auth-schema");
      const { projects, agents, playgroundSessions } =
        await import("~/db/schema");
      const {
        createPlaygroundSession,
        savePlaygroundEvents,
        loadPlaygroundEntriesFromCache,
        cachedStreamIndex,
        markPlaygroundSessionStopped,
        savePlaygroundSessionCursor,
        savePlaygroundSessionProgress,
      } = await import("~/playground/sessions.server");

      const ORG = "org_pgcache_smoke";
      const USER = "user_pgcache_smoke";
      const now = new Date();
      // Fresh scope each run (cascades clean up the session + its cached events).
      await db.delete(organization).where(eq(organization.id, ORG));
      await db.delete(user).where(eq(user.id, USER));
      await db.insert(organization).values({
        id: ORG,
        name: "pgcache smoke",
        slug: "pgcache-smoke",
        createdAt: now,
      });
      await db.insert(user).values({
        id: USER,
        name: "Playground Cache Smoke",
        email: "pgcache@smoke.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const [project] = await db
        .insert(projects)
        .values({ orgId: ORG, name: "pgcache", slug: "pgcache-smoke" })
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

      const at = new Date().toISOString();
      // The exact raw-event shape the drain buffers (streamIndex + type + data + meta) — the same
      // events tests/unit/playground-replay.test.ts feeds the Eve-replay path.
      const events = [
        {
          type: "session.started",
          data: { runtime: { modelId: "m/x" } },
          meta: { at },
        },
        { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
        {
          type: "message.received",
          data: { turnId: "turn_0", message: "finish the deploy" },
          meta: { at },
        },
        {
          type: "step.started",
          data: { turnId: "turn_0", sequence: 1 },
          meta: { at },
        },
        {
          type: "message.appended",
          data: { turnId: "turn_0", messageSoFar: "Working on it" },
          meta: { at },
        },
      ].map((e, i) => ({ streamIndex: i + 1, ...e }));

      await savePlaygroundEvents(session.id, events);

      const entries = await loadPlaygroundEntriesFromCache(session);
      expect(entries).toMatchObject([
        { role: "user", text: "finish the deploy" },
        { role: "assistant", text: "Working on it", modelId: "m/x" },
      ]);
      expect(await cachedStreamIndex(session.id)).toBe(5);

      // Idempotent re-drain: replaying the same indices is a no-op, not a duplicate-key crash, and the
      // transcript is unchanged.
      await savePlaygroundEvents(session.id, events);
      expect(await loadPlaygroundEntriesFromCache(session)).toEqual(entries);
      expect(await cachedStreamIndex(session.id)).toBe(5);

      // Stop is terminal for an already-running drain: both its queued progress write and its final
      // cursor write arrive after /stop in this ordering, and both must become no-ops. The fake target
      // deliberately has no FK rows, so either update escaping its status guard also fails loudly.
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
        externalSessionId: "wrun_pgcache_smoke",
        continuationToken: null,
        streamIndex: 5,
      });
      await savePlaygroundSessionCursor({
        id: session.id,
        target: staleDrainTarget,
        externalSessionId: "wrun_pgcache_smoke",
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
        lastDeploymentId: null,
      });

      // Cleanup.
      await db.delete(organization).where(eq(organization.id, ORG));
      await db.delete(user).where(eq(user.id, USER));
    });

    it("reseeds across a redeploy: preserves history, appends the new eve session past the offset (#71)", async () => {
      const { db } = await import("~/db/client.server");
      const { organization, user } = await import("~/db/auth-schema");
      const { projects, agents, playgroundSessions } =
        await import("~/db/schema");
      const {
        createPlaygroundSession,
        savePlaygroundEvents,
        loadPlaygroundEntriesFromCache,
        cachedStreamIndex,
        unbindPlaygroundSessionForReseed,
      } = await import("~/playground/sessions.server");

      const ORG = "org_pgreseed_smoke";
      const USER = "user_pgreseed_smoke";
      const now = new Date();
      await db.delete(organization).where(eq(organization.id, ORG));
      await db.delete(user).where(eq(user.id, USER));
      await db.insert(organization).values({
        id: ORG,
        name: "pgreseed smoke",
        slug: "pgreseed-smoke",
        createdAt: now,
      });
      await db.insert(user).values({
        id: USER,
        name: "Playground Reseed Smoke",
        email: "pgreseed@smoke.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const [project] = await db
        .insert(projects)
        .values({ orgId: ORG, name: "pgreseed", slug: "pgreseed-smoke" })
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
      });

      const at = new Date().toISOString();
      // First eve session's transcript — 5 events (turn_a), cache indices 1..5.
      const firstEvents = [
        {
          type: "session.started",
          data: { runtime: { modelId: "m/x" } },
          meta: { at },
        },
        { type: "turn.started", data: { turnId: "turn_a" }, meta: { at } },
        {
          type: "message.received",
          data: { turnId: "turn_a", message: "Please deploy my thing." },
          meta: { at },
        },
        {
          type: "message.completed",
          data: { turnId: "turn_a", message: "I need the credential first." },
          meta: { at },
        },
        { type: "turn.completed", data: { turnId: "turn_a" }, meta: { at } },
      ].map((e, i) => ({ streamIndex: i + 1, ...e }));
      await savePlaygroundEvents(session.id, firstEvents);
      expect(await cachedStreamIndex(session.id)).toBe(5);

      // Redeploy: the owning deployment is replaced. Unbind for reseed.
      const reseeded = await unbindPlaygroundSessionForReseed(session);
      expect(reseeded).toMatchObject({
        externalSessionId: null,
        continuationToken: null,
        streamIndex: 0,
        cacheIndexOffset: 5,
      });

      // The fresh eve session re-indexes from 1; the drain persists it with the reseed offset.
      const secondEvents = [
        { type: "turn.started", data: { turnId: "turn_b" }, meta: { at } },
        {
          type: "message.received",
          data: { turnId: "turn_b", message: "Can you try again?" },
          meta: { at },
        },
        {
          type: "message.completed",
          data: { turnId: "turn_b", message: "Retried successfully." },
          meta: { at },
        },
      ].map((e, i) => ({ streamIndex: i + 1, ...e }));
      await savePlaygroundEvents(
        session.id,
        secondEvents,
        reseeded.cacheIndexOffset,
      );
      // Appended after the preserved history: 6..8.
      expect(await cachedStreamIndex(session.id)).toBe(8);

      const entries = await loadPlaygroundEntriesFromCache(reseeded);
      expect(entries).toMatchObject([
        { role: "user", text: "Please deploy my thing." },
        { role: "assistant", text: "I need the credential first." },
        { role: "user", text: "Can you try again?" },
        { role: "assistant", text: "Retried successfully." },
      ]);

      // Re-running the offset insert is idempotent (PK + ON CONFLICT DO NOTHING).
      await savePlaygroundEvents(
        session.id,
        secondEvents,
        reseeded.cacheIndexOffset,
      );
      expect(await cachedStreamIndex(session.id)).toBe(8);
      expect(await loadPlaygroundEntriesFromCache(reseeded)).toEqual(entries);

      await db.delete(organization).where(eq(organization.id, ORG));
      await db.delete(user).where(eq(user.id, USER));
    });
  },
);
