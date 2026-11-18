/**
 * Run metadata across re-ingest against REAL Postgres (#419): a finish merges its keys onto the
 * row (the stale sweep's `settledBy`), and ingest stores repeated identical tool calls
 * (`toolRepeats`) that a later replayed start doesn't erase. Opt-in:
 * `HARNESST_DB_SMOKE=1 npx vitest run tests/integration/run-metadata.db.test.ts` with
 * `.env.local` sourced.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("run metadata against real Postgres", () => {
  it("merges finish metadata and keeps ingest-time repeats", async () => {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { ingestRun } = await import("~/observability/store.server");
    const { projects, runs } = await import("~/db/schema");

    const ORG = "org_run_metadata";
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({ id: ORG, name: "run metadata smoke", slug: "run-metadata-smoke", createdAt: new Date() });
    try {
      const [project] = await db
        .insert(projects)
        .values({ orgId: ORG, name: "run metadata", slug: "run-metadata-smoke" })
        .returning();
      const externalRunId = "smoke:metadata";
      const call = (seq: number) => ({ seq, type: "tool_call" as const, toolName: "bash", data: { input: { cmd: "sleep 30" } } });

      await ingestRun(project.id, { externalRunId, status: "running", metadata: { input: "hello" } });
      await ingestRun(project.id, {
        externalRunId,
        status: "failed",
        metadata: { settledBy: "stale-run-sweep" },
        // A fractional or oversized reading is rounded or dropped, never fails the insert.
        peakContextTokens: 288661.5,
        wallClockMs: 3_369_109.4,
        tokensInput: 3_000_000_000,
        finishedAt: new Date().toISOString(),
        steps: [call(1), call(2), call(3)],
      });
      const read = async () => (await db.select().from(runs).where(eq(runs.externalRunId, externalRunId)))[0];
      expect(await read()).toMatchObject({ peakContextTokens: 288662, wallClockMs: 3_369_109, tokensInput: 2_147_483_647 });
      expect((await read()).metadata).toMatchObject({
        input: "hello",
        settledBy: "stale-run-sweep",
        toolRepeats: [{ tool: "bash", count: 3, firstSeq: 1 }],
      });

      // A replayed start can't touch the terminal row, so nothing it carries lands.
      await ingestRun(project.id, { externalRunId, status: "running", metadata: { input: "replay" } });
      expect((await read()).metadata).toMatchObject({ input: "hello", toolRepeats: [{ count: 3 }] });
    } finally {
      await db.delete(organization).where(eq(organization.id, ORG));
    }
  });
});
