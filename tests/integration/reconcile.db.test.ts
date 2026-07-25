/**
 * Channel-run reconciler against REAL Postgres (issue #119). The unit test covers orchestration;
 * this opt-in smoke proves the real cursor store + real record chokepoint end to end:
 * cron/discord/hung sessions become runs + run_steps + sessions + reconcile cursors, a hung turn
 * lands as a `running` row, a Discord placeholder is settled IN PLACE (channel + metadata
 * preserved), and a second sweep is idempotent (no duplicate runs; steps replaced, not appended).
 *
 * Run: `HARNESST_DB_SMOKE=1 npx vitest run tests/integration/reconcile.db.test.ts` with `.env.local`
 * sourced.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { RawEveEvent } from "~/agent/talk.server";
import type { IndexedEveEvent } from "~/observability/session-turns.server";
import type { ReconcileDeps, ReconcileTarget } from "~/observability/reconcile.server";
import type { WorldSessionSummary } from "~/seams/types";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

function indexed(events: RawEveEvent[]): IndexedEveEvent[] {
  return events.map((e, i) => ({ ...e, streamIndex: i + 1 }));
}

function cronTurn(): IndexedEveEvent[] {
  return indexed([
    { type: "session.started", data: { runtime: { modelId: "m/x" } } },
    {
      type: "message.received",
      data: { turnId: "turn_0", message: "run report" },
      meta: { at: "2026-07-12T00:00:00.000Z" },
    },
    {
      type: "step.started",
      data: { turnId: "turn_0", sequence: 1 },
      meta: { at: "2026-07-12T00:00:00.500Z" },
    },
    {
      type: "actions.requested",
      data: {
        turnId: "turn_0",
        sequence: 1,
        actions: [{ toolName: "bash", input: { command: "make report" }, callId: "c1" }],
      },
    },
    {
      type: "action.result",
      data: {
        turnId: "turn_0",
        status: "completed",
        result: { callId: "c1", output: { stdout: "ok", exitCode: 0 } },
      },
    },
    {
      type: "step.completed",
      data: { turnId: "turn_0", sequence: 1, usage: { inputTokens: 12, outputTokens: 5 } },
      meta: { at: "2026-07-12T00:00:01.000Z" },
    },
    { type: "message.completed", data: { turnId: "turn_0", message: "report done" } },
    {
      type: "turn.completed",
      data: { turnId: "turn_0" },
      meta: { at: "2026-07-12T00:00:01.500Z" },
    },
  ]);
}

function discordTurn(): IndexedEveEvent[] {
  return indexed([
    { type: "session.started", data: { runtime: { modelId: "m/x" } } },
    {
      type: "message.received",
      data: { turnId: "turn_0", message: "hello" },
      meta: { at: "2026-07-12T00:00:00.000Z" },
    },
    { type: "message.completed", data: { turnId: "turn_0", message: "hi there" } },
    {
      type: "turn.completed",
      data: { turnId: "turn_0" },
      meta: { at: "2026-07-12T00:00:01.000Z" },
    },
  ]);
}

function hungTurn(): IndexedEveEvent[] {
  return indexed([
    {
      type: "message.received",
      data: { turnId: "turn_0", message: "long job" },
      meta: { at: "2026-07-12T00:00:00.000Z" },
    },
    {
      type: "step.started",
      data: { turnId: "turn_0", sequence: 1 },
      meta: { at: "2026-07-12T00:00:00.500Z" },
    },
  ]);
}

describe.runIf(LIVE)("run reconciler against real Postgres", () => {
  it("records cron/discord/hung sessions, settles the discord placeholder, and is idempotent", async () => {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { agents, deployments, environments, projects, releases, runs, runSteps, sessions, runReconcileCursors } =
      await import("~/db/schema");
    const { recordTurnStart } = await import("~/observability/record.server");
    const { reconcileDeps, reconcileTick } = await import("~/observability/reconcile.server");

    const ORG = "org_reconcile_119";
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({
      id: ORG,
      name: "reconcile smoke",
      slug: "reconcile-smoke-119",
      createdAt: new Date(),
    });

    try {
      const [project] = await db
        .insert(projects)
        .values({ orgId: ORG, name: "reconcile", slug: "reconcile-119" })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({ projectId: project.id, name: "agent", root: "agent" })
        .returning();
      const [environment] = await db
        .insert(environments)
        .values({ projectId: project.id, agentId: agent.id, name: "production" })
        .returning();
      const [release] = await db
        .insert(releases)
        .values({ projectId: project.id, agentId: agent.id, version: "v1", gitSha: "reconcile-119" })
        .returning();
      const [deployment] = await db
        .insert(deployments)
        .values({ environmentId: environment.id, releaseId: release.id, status: "live", url: "http://inst" })
        .returning();

      // Seed the Discord placeholder the relay would have left behind.
      await recordTurnStart(
        {
          projectId: project.id,
          deploymentId: deployment.id,
          releaseId: release.id,
          externalRunId: "discord:i123",
          externalSessionId: "discord:i123",
          userMessage: "hello",
          channel: "discord",
          metadata: { discordInteractionId: "i123", discordGuildName: "guild" },
        },
        new Date("2026-07-12T00:00:00.000Z"),
      );

      const target: ReconcileTarget = {
        deploymentId: deployment.id,
        releaseId: release.id,
        url: "http://inst",
        worldKey: environment.id,
        projectId: project.id,
      };

      // World sessions are mutable so a second sweep can advance updatedAt; cron uses a full
      // re-read (ignores startIndex) so we can prove step-replacement idempotency for a stable id.
      let updatedAt = "2026-07-12T00:00:05.000Z";
      const worldSessions = (): WorldSessionSummary[] => [
        { sessionId: "wrun_sched", trigger: "schedule", status: "completed", title: "cron", createdAt: "2026-07-12T00:00:00.000Z", updatedAt },
        { sessionId: "wrun_disc", trigger: "discord", status: "completed", title: "disc", createdAt: "2026-07-12T00:00:01.000Z", updatedAt },
        { sessionId: "wrun_hung", trigger: "schedule", status: "running", title: "hung", createdAt: "2026-07-12T00:00:02.000Z", updatedAt },
        { sessionId: "wrun_http", trigger: "http", status: "completed", title: "pg", createdAt: "2026-07-12T00:00:03.000Z", updatedAt },
      ];
      const streams: Record<string, IndexedEveEvent[]> = {
        wrun_sched: cronTurn(),
        wrun_disc: discordTurn(),
        wrun_hung: hungTurn(),
      };
      const fullRead = new Set(["wrun_sched"]);

      const base = reconcileDeps();
      const deps: ReconcileDeps = {
        ...base,
        listTargets: async () => [target],
        listWorldSessions: async () => worldSessions(),
        readSessionEvents: async (_url, sessionId, startIndex) => {
          const all = streams[sessionId] ?? [];
          return fullRead.has(sessionId)
            ? all
            : all.filter((e) => e.streamIndex > startIndex);
        },
      };

      await reconcileTick(deps);

      const runsById = async () => {
        const rows = await db.select().from(runs).where(eq(runs.projectId, project.id));
        return new Map(rows.map((r) => [r.externalRunId, r]));
      };
      let byId = await runsById();

      // http session is never recorded.
      expect([...byId.keys()].some((k) => k?.startsWith("wrun_http"))).toBe(false);

      // Cron run: completed, with steps + summed tokens.
      const cron = byId.get("wrun_sched:turn_0");
      expect(cron?.status).toBe("completed");
      expect(cron?.channel).toBe("cron");
      expect(cron?.tokensInput).toBe(12);
      expect(cron?.tokensOutput).toBe(5);
      const cronSteps = await db.select().from(runSteps).where(eq(runSteps.runId, cron!.id));
      expect(cronSteps.length).toBeGreaterThan(0);
      const cronStepCount = cronSteps.length;

      // Discord placeholder settled IN PLACE — same run id, channel + metadata preserved.
      const disc = byId.get("discord:i123");
      expect(disc?.status).toBe("completed");
      expect(disc?.channel).toBe("discord");
      expect((disc?.metadata as Record<string, unknown>).discordInteractionId).toBe("i123");
      expect((disc?.metadata as Record<string, unknown>).discordGuildName).toBe("guild");
      expect(byId.has("wrun_disc:turn_0")).toBe(false); // no parallel run created
      const discSteps = await db.select().from(runSteps).where(eq(runSteps.runId, disc!.id));
      expect(discSteps.length).toBeGreaterThan(0);

      // Hung turn: a visible running row (the #118 win).
      const hung = byId.get("wrun_hung:turn_0");
      expect(hung?.status).toBe("running");
      expect(hung?.channel).toBe("cron");

      // Sessions + cursors persisted for every non-http session.
      const sessRows = await db.select().from(sessions).where(eq(sessions.projectId, project.id));
      const extSessions = sessRows.map((s) => s.externalSessionId);
      expect(extSessions).toEqual(expect.arrayContaining(["wrun_sched", "wrun_disc", "wrun_hung", "discord:i123"]));
      const cursorRows = await db
        .select()
        .from(runReconcileCursors)
        .where(eq(runReconcileCursors.projectId, project.id));
      expect(cursorRows.map((c) => c.externalSessionId).sort()).toEqual(
        ["wrun_disc", "wrun_hung", "wrun_sched"].sort(),
      );

      // Second sweep with advanced activity → idempotent: no duplicate runs, cron steps replaced.
      updatedAt = "2026-07-12T00:00:20.000Z";
      await reconcileTick(deps);

      byId = await runsById();
      const runRows = await db.select().from(runs).where(eq(runs.projectId, project.id));
      // 3 recorded runs total (cron, discord-placeholder, hung) — no duplicates.
      expect(runRows.length).toBe(3);
      const cronAfter = byId.get("wrun_sched:turn_0");
      const cronStepsAfter = await db.select().from(runSteps).where(eq(runSteps.runId, cronAfter!.id));
      expect(cronStepsAfter.length).toBe(cronStepCount); // replaced, not appended
      expect(byId.get("wrun_hung:turn_0")?.status).toBe("running");
    } finally {
      await db.delete(organization).where(eq(organization.id, ORG));
    }
  });
});

describe.runIf(!LIVE)("run reconciler db smoke (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
