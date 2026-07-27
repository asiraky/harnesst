/**
 * Pushed run reporting against REAL Postgres (WS2). The unit test covers the decision path; this
 * opt-in smoke proves the part that only a real database can: that a container POSTing its own
 * turn produces the same rows the playground does, on the same unique key, and that the hook's
 * repeated whole-turn flushes converge instead of accumulating.
 *
 * What it pins:
 *  - a settled `channel:github` turn → one `runs` row with channel "github" (NOT the namespaced
 *    kind), summed tokens, a `sessions` row and ordered `run_steps`;
 *  - the raw kind survives on run metadata, so classification loses nothing;
 *  - re-pushing the identical turn (the hook resends the whole buffer on every flush) does not
 *    duplicate the run OR its steps — `runs_external_uq` plus wholesale step replacement;
 *  - running → completed transitions the SAME row, and a late `running` push can never resurrect
 *    a run that already settled (the terminal-state guard);
 *  - an http-homed turn writes nothing at all.
 *
 * Run: `HARNESST_DB_SMOKE=1 npx vitest run tests/integration/push-runs.db.test.ts` with
 * `.env.local` sourced.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { PushedEvent } from "~/observability/push-ingest.server";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

function evt(
  type: string,
  data: Record<string, unknown>,
  at?: string,
): PushedEvent {
  return { type, data, meta: at ? { at } : undefined };
}

/** A settled GitHub turn: user comment → tool step → reply → completed. */
function settledTurn(): PushedEvent[] {
  return [
    evt("session.started", { runtime: { modelId: "m/x" } }),
    evt("turn.started", { turnId: "turn_0" }, "2026-07-27T00:00:00.000Z"),
    evt(
      "message.received",
      { turnId: "turn_0", message: "please look at #7" },
      "2026-07-27T00:00:00.000Z",
    ),
    evt("step.started", { turnId: "turn_0", sequence: 1 }, "2026-07-27T00:00:00.500Z"),
    evt("actions.requested", {
      turnId: "turn_0",
      sequence: 1,
      actions: [{ toolName: "bash", input: { command: "git log" }, callId: "c1" }],
    }),
    evt("action.result", {
      turnId: "turn_0",
      status: "completed",
      result: { callId: "c1", output: { stdout: "ok", exitCode: 0 } },
    }),
    evt(
      "step.completed",
      { turnId: "turn_0", sequence: 1, usage: { inputTokens: 31, outputTokens: 9 } },
      "2026-07-27T00:00:01.000Z",
    ),
    evt("message.completed", { turnId: "turn_0", message: "opened a PR" }),
    evt("turn.completed", { turnId: "turn_0" }, "2026-07-27T00:00:01.500Z"),
  ];
}

/** The same turn as the hook would flush it on `turn.started` — nothing settled yet. */
function runningPrefix(): PushedEvent[] {
  return settledTurn().slice(0, 4);
}

describe.runIf(LIVE)("pushed run ingest against real Postgres", () => {
  it("writes a github run, converges on re-push, and never resurrects a settled one", async () => {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { agents, deployments, environments, projects, releases, runs, runSteps, sessions } =
      await import("~/db/schema");
    const { defaultPushIngestDeps, ingestPushedTurn } = await import(
      "~/observability/push-ingest.server"
    );

    const ORG = "org_push_runs_ws2";
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({
      id: ORG,
      name: "push runs smoke",
      slug: "push-runs-smoke-ws2",
      createdAt: new Date(),
    });

    try {
      const [project] = await db
        .insert(projects)
        .values({ orgId: ORG, name: "push", slug: "push-ws2" })
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
        .values({
          projectId: project.id,
          agentId: agent.id,
          version: "v1",
          gitSha: "push-ws2",
        })
        .returning();
      const [deployment] = await db
        .insert(deployments)
        .values({
          environmentId: environment.id,
          releaseId: release.id,
          status: "live",
          url: "http://inst",
        })
        .returning();

      const deps = defaultPushIngestDeps();
      const push = (over: Record<string, unknown>) =>
        ingestPushedTurn(
          {
            deploymentId: deployment.id,
            sessionId: "wrun_gh",
            turnId: "turn_0",
            channelKind: "channel:github",
            modelId: "m/x",
            agentName: "agent",
            events: settledTurn(),
            ...over,
          } as never,
          deps,
        );

      const runRows = async () =>
        db.select().from(runs).where(eq(runs.projectId, project.id));

      // 1. The in-flight flush the hook sends on turn.started.
      expect(await push({ events: runningPrefix() })).toEqual({
        ok: true,
        recorded: true,
      });
      let rows = await runRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("running");
      expect(rows[0].channel).toBe("github");
      expect(rows[0].externalRunId).toBe("wrun_gh:turn_0");

      // 2. The settled flush on turn.completed — SAME row, now terminal.
      expect(await push({ final: true })).toEqual({ ok: true, recorded: true });
      rows = await runRows();
      expect(rows).toHaveLength(1);
      const run = rows[0];
      expect(run.status).toBe("completed");
      // The classified channel is what the Runs tab filters on; eve's namespaced kind never lands.
      expect(run.channel).toBe("github");
      expect(run.tokensInput).toBe(31);
      expect(run.tokensOutput).toBe(9);
      const metadata = run.metadata as Record<string, unknown>;
      // ...but it is preserved verbatim, so nothing is lost by classifying.
      expect(metadata.eveTrigger).toBe("channel:github");
      expect(metadata.eveSessionId).toBe("wrun_gh");
      expect(metadata.source).toBe("push");

      const stepRows = await db.select().from(runSteps).where(eq(runSteps.runId, run.id));
      expect(stepRows.length).toBeGreaterThan(0);
      const stepCount = stepRows.length;
      // Steps are numbered contiguously from 1 — the transcript renders in this order.
      expect(stepRows.map((s) => s.seq).sort((a, b) => a - b)).toEqual(
        stepRows.map((_, i) => i + 1),
      );

      const sessRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.projectId, project.id));
      expect(sessRows.map((s) => s.externalSessionId)).toEqual(["wrun_gh"]);
      expect(sessRows[0].channel).toBe("github");

      // 3. The hook re-sends the WHOLE turn on every flush, and a delivery may be retried by the
      //    ordering chain. Neither may duplicate a run or append its steps a second time.
      await push({ final: true });
      await push({ final: true });
      rows = await runRows();
      expect(rows).toHaveLength(1);
      expect(
        (await db.select().from(runSteps).where(eq(runSteps.runId, run.id))).length,
      ).toBe(stepCount);

      // 4. A late `running` report (a slow first POST landing after the completion) must not
      //    reopen a finished run.
      await push({ events: runningPrefix() });
      rows = await runRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("completed");

      // 5. An http-homed turn is the playground's business, already recorded in-process.
      expect(
        await push({ sessionId: "wrun_http", channelKind: "http", final: true }),
      ).toEqual({ ok: true, recorded: false, reason: "channel-not-recorded" });
      expect(await runRows()).toHaveLength(1);
      expect(
        (await db.select().from(sessions).where(eq(sessions.projectId, project.id))).length,
      ).toBe(1);
    } finally {
      await db.delete(organization).where(eq(organization.id, ORG));
    }
  });
});

describe.runIf(!LIVE)("pushed run ingest db smoke (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
