/**
 * Post-commit draft cleanup against a REAL Postgres — the regression the in-memory fake cannot
 * express.
 *
 * `drafts.deletePublished` removes the drafts a publish landed, guarded per row by the `updatedAt`
 * the pipeline captured at its start so a save that raced the multi-minute build/commit window
 * stays saved. The guard was comparing a MICROSECOND-precision `timestamptz` against a captured
 * value that had round-tripped through a JS `Date` (milliseconds): `.780099 <= .780` is false, so
 * the delete matched nothing and every published draft survived its own publish — the header's
 * "Publish N changes" never cleared and each republish re-committed the same files under a new
 * version.
 *
 * The fake store models timestamps as JS Dates end to end, so this only reproduces against real
 * Postgres, where `defaultNow()` writes sub-millisecond digits.
 *
 * Opt-in: runs only when HARNESST_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`HARNESST_DB_SMOKE=1 npx vitest run tests/integration/publish-draft-cleanup.db.test.ts` with
 * .env.local sourced). Creates its own org/project rows and deletes them, so it's safe to re-run.
 */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("deletePublished against real Postgres", () => {
  it("deletes the captured rows despite sub-millisecond updated_at, and keeps a raced re-save", async () => {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { projects, draftChanges } = await import("~/db/schema");
    const { drizzleDataStore: store } = await import("~/data/drizzle.server");

    const ORG = "org_pubclean_smoke";
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({
      id: ORG,
      name: "publish cleanup smoke",
      slug: "pubclean-smoke",
      createdAt: new Date(),
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "pubclean", slug: "pubclean-smoke" })
      .returning();

    try {
      for (const path of ["agents/deputy/agent/agent.ts", "agents/deputy/package.json"]) {
        await store.drafts.upsert({ projectId: project.id, agentId: null, path, content: "x" });
      }
      // Force the shape production hits: `defaultNow()` stores microseconds, which is what the
      // captured JS Date silently truncates. Assert the fixture really has sub-ms digits, so this
      // test can never pass for the wrong reason (a whole-millisecond timestamp).
      await db
        .update(draftChanges)
        .set({ updatedAt: sql`date_trunc('milliseconds', now()) + interval '99 microseconds'` })
        .where(eq(draftChanges.projectId, project.id));
      const [{ subMs }] = await db
        .select({ subMs: sql<number>`min(extract(microseconds from updated_at)::int % 1000)` })
        .from(draftChanges)
        .where(eq(draftChanges.projectId, project.id));
      expect(subMs).toBeGreaterThan(0);

      // What the pipeline captures at its start: rows read back through the store (JS Dates).
      const captured = await store.drafts.listByProject(project.id);
      expect(captured).toHaveLength(2);

      // A save that lands DURING the build/commit window must survive the cleanup.
      await store.drafts.upsert({
        projectId: project.id,
        agentId: null,
        path: "agents/deputy/package.json",
        content: "raced",
      });

      await store.drafts.deletePublished(
        project.id,
        captured.map((d) => ({ path: d.path, updatedAt: d.updatedAt })),
      );

      const left = await store.drafts.listByProject(project.id);
      expect(left.map((d) => d.path)).toEqual(["agents/deputy/package.json"]);
      expect(left[0].content).toBe("raced");
    } finally {
      await db.delete(organization).where(eq(organization.id, ORG));
    }
  });
});
