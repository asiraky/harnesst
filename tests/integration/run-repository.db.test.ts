/**
 * Deployment-scoped run reconciliation against REAL Postgres (issue #83). The in-memory fake
 * covers orchestration; this opt-in smoke proves the guarded SQL update, duration expression, and
 * returned affected-row count (`HARNESST_DB_SMOKE=1 npx vitest run
 * tests/integration/run-repository.db.test.ts` with `.env.local` sourced).
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("run repository against real Postgres", () => {
  it("fails only running rows owned by one deployment", async () => {
    const { drizzleDataStore: store } = await import("~/data/drizzle.server");
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { ingestRun, ingestRunStart } =
      await import("~/observability/store.server");
    const { agents, deployments, environments, projects, releases, runs } =
      await import("~/db/schema");

    const ORG = "org_run_repo";
    const finishedAt = new Date("2026-07-11T05:00:00.000Z");
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({
      id: ORG,
      name: "run repository smoke",
      slug: "run-repository-smoke",
      createdAt: new Date(),
    });

    try {
      const [project] = await db
        .insert(projects)
        .values({
          orgId: ORG,
          name: "run repository",
          slug: "run-repository-smoke",
        })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({ projectId: project.id, name: "agent", root: "agent" })
        .returning();
      const [environment] = await db
        .insert(environments)
        .values({
          projectId: project.id,
          agentId: agent.id,
          name: "production",
        })
        .returning();
      const [release] = await db
        .insert(releases)
        .values({
          projectId: project.id,
          agentId: agent.id,
          version: "v1",
          gitSha: "run-repository-smoke",
        })
        .returning();
      const [targetDeployment, otherDeployment] = await db
        .insert(deployments)
        .values([
          {
            environmentId: environment.id,
            releaseId: release.id,
            status: "live",
          },
          {
            environmentId: environment.id,
            releaseId: release.id,
            status: "live",
          },
        ])
        .returning();

      await db.insert(runs).values([
        {
          id: "run_target_1",
          projectId: project.id,
          agentId: agent.id,
          deploymentId: targetDeployment.id,
          releaseId: release.id,
          status: "running",
          startedAt: new Date("2026-07-11T04:59:55.000Z"),
        },
        {
          id: "run_skew_01",
          projectId: project.id,
          agentId: agent.id,
          deploymentId: targetDeployment.id,
          releaseId: release.id,
          status: "running",
          startedAt: new Date("2026-07-11T05:00:01.000Z"),
        },
        {
          id: "run_stale_1",
          projectId: project.id,
          agentId: agent.id,
          deploymentId: targetDeployment.id,
          releaseId: release.id,
          status: "running",
          startedAt: new Date("2020-01-01T00:00:00.000Z"),
        },
        {
          id: "run_done_001",
          projectId: project.id,
          agentId: agent.id,
          deploymentId: targetDeployment.id,
          releaseId: release.id,
          status: "completed",
          wallClockMs: 123,
          startedAt: new Date("2026-07-11T04:59:58.000Z"),
          finishedAt: new Date("2026-07-11T04:59:59.000Z"),
        },
        {
          id: "run_other_1",
          projectId: project.id,
          agentId: agent.id,
          deploymentId: otherDeployment.id,
          releaseId: release.id,
          status: "running",
          startedAt: new Date("2026-07-11T04:59:50.000Z"),
        },
      ]);

      // The drain watcher's idle signal: only `running` rows of the given deployment are counted.
      await expect(
        store.runs.countRunningByDeployment(targetDeployment.id),
      ).resolves.toBe(3);
      await expect(
        store.runs.countRunningByDeployment(otherDeployment.id),
      ).resolves.toBe(1);

      await expect(
        store.runs.failRunningByDeployment(
          targetDeployment.id,
          "interrupted by redeploy",
          finishedAt,
        ),
      ).resolves.toBe(3);

      // After reconciliation the drained deployment reads idle.
      await expect(
        store.runs.countRunningByDeployment(targetDeployment.id),
      ).resolves.toBe(0);

      const rows = await db
        .select()
        .from(runs)
        .where(eq(runs.projectId, project.id));
      const byId = new Map(rows.map((run) => [run.id, run]));
      expect(byId.get("run_target_1")).toMatchObject({
        status: "failed",
        error: "interrupted by redeploy",
        wallClockMs: 5_000,
      });
      expect(byId.get("run_target_1")?.finishedAt?.getTime()).toBe(
        finishedAt.getTime(),
      );
      expect(byId.get("run_skew_01")?.wallClockMs).toBe(0);
      expect(byId.get("run_stale_1")?.wallClockMs).toBe(2_147_483_647);
      expect(byId.get("run_done_001")).toMatchObject({
        status: "completed",
        error: null,
        wallClockMs: 123,
      });
      expect(byId.get("run_done_001")?.finishedAt?.getTime()).toBe(
        new Date("2026-07-11T04:59:59.000Z").getTime(),
      );
      expect(byId.get("run_other_1")).toMatchObject({
        status: "running",
        error: null,
        wallClockMs: null,
        finishedAt: null,
      });
      await expect(
        store.runs.failRunningByDeployment(
          targetDeployment.id,
          "interrupted by redeploy",
          finishedAt,
        ),
      ).resolves.toBe(0);

      // A replayed start can reach a live deployment, but its upsert must not downgrade the
      // already-terminal row or clear the post-mortem fields.
      const terminalFinishedAt = new Date("2026-07-11T05:01:00.000Z");
      await ingestRun(project.id, {
        externalRunId: "discord:terminal-replay",
        deploymentId: otherDeployment.id,
        releaseId: release.id,
        status: "failed",
        error: "original terminal error",
        wallClockMs: 321,
        startedAt: "2026-07-11T05:00:59.679Z",
        finishedAt: terminalFinishedAt.toISOString(),
      });
      await expect(
        ingestRunStart(project.id, {
          externalRunId: "discord:terminal-replay",
          deploymentId: otherDeployment.id,
          releaseId: release.id,
          status: "running",
        }),
      ).resolves.toBe(true);
      const [terminal] = await db
        .select()
        .from(runs)
        .where(eq(runs.externalRunId, "discord:terminal-replay"));
      expect(terminal).toMatchObject({
        status: "failed",
        error: "original terminal error",
        wallClockMs: 321,
      });
      expect(terminal.finishedAt?.getTime()).toBe(terminalFinishedAt.getTime());

      // The deployment lock serializes start vs stop into two safe orders. A start that wins
      // lands before the stop and is swept; a start after the stopped marker inserts nothing.
      await expect(
        ingestRunStart(project.id, {
          externalRunId: "discord:before-stop",
          deploymentId: targetDeployment.id,
          releaseId: release.id,
          status: "running",
        }),
      ).resolves.toBe(true);
      await db
        .update(deployments)
        .set({ status: "stopped" })
        .where(eq(deployments.id, targetDeployment.id));
      await expect(
        store.runs.failRunningByDeployment(
          targetDeployment.id,
          "interrupted by stop",
        ),
      ).resolves.toBe(1);
      const [beforeStop] = await db
        .select()
        .from(runs)
        .where(eq(runs.externalRunId, "discord:before-stop"));
      expect(beforeStop.status).toBe("failed");

      await expect(
        ingestRunStart(project.id, {
          externalRunId: "discord:after-stop",
          deploymentId: targetDeployment.id,
          releaseId: release.id,
          status: "running",
        }),
      ).resolves.toBe(false);
      const afterStop = await db
        .select()
        .from(runs)
        .where(eq(runs.externalRunId, "discord:after-stop"));
      expect(afterStop).toEqual([]);
    } finally {
      await db.delete(organization).where(eq(organization.id, ORG));
    }
  });
});

describe.runIf(!LIVE)("run repository db smoke (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
