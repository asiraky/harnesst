/**
 * WS2 — `ingestPushedTurn` against in-memory fakes (the `runAsk`/`parkChannelQuestion` deps
 * pattern: zero I/O).
 *
 * What matters here: identity comes ONLY from the token's deployment id; `channel:github`
 * classifies to `github` and never lands verbatim; an http-homed turn writes NOTHING (harnesst
 * already records those in-process, and a second writer would fight the terminal-state guard);
 * an unsettled turn becomes a `running` row and a settled one a completed row with summed tokens
 * and its steps; and a re-push produces the identical `externalRunId`, which is what makes the
 * whole path idempotent against `runs_external_uq` without any cursor table.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  ingestPushedTurn,
  normalizePushedEvents,
  type PushIngestDeps,
  type PushedEvent,
} from "~/observability/push-ingest.server";
import type { recordTurnFinish, TurnIds } from "~/observability/record.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_1";

let store: FakeStore;

async function seedDeployment(): Promise<string> {
  store.seedProject({ id: PROJECT, orgId: "org_1" });
  store.seedAgent({ id: "agent_1", projectId: PROJECT, name: "dev" });
  store.seedEnvironment({
    id: "env_1",
    projectId: PROJECT,
    agentId: "agent_1",
    name: "production",
  });
  const release = await store.releases.insert({
    projectId: PROJECT,
    agentId: "agent_1",
    version: "v1",
    gitSha: "a".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: "env_1",
    releaseId: release.id,
    status: "live",
    trafficWeight: 100,
  });
  await store.deployments.update(dep.id, { url: "http://inst:4000" });
  return dep.id;
}

function makeDeps(over: { startAccepted?: boolean } = {}): PushIngestDeps & {
  starts: { ids: TurnIds; startedAt: Date }[];
  finishes: Parameters<typeof recordTurnFinish>[0][];
} {
  const starts: { ids: TurnIds; startedAt: Date }[] = [];
  const finishes: Parameters<typeof recordTurnFinish>[0][] = [];
  return {
    store,
    starts,
    finishes,
    recordStart: async (ids, startedAt = new Date()) => {
      starts.push({ ids, startedAt });
      return over.startAccepted ?? true;
    },
    recordFinish: async (input) => {
      finishes.push(input);
    },
  };
}

function evt(
  type: string,
  data: Record<string, unknown> = {},
  at = "2026-07-27T00:00:00.000Z",
): PushedEvent {
  return { type, data, meta: { at } };
}

/** A complete, settled GitHub turn: user message → tool step with usage → reply → completed. */
function settledTurn(): PushedEvent[] {
  return [
    evt("session.started", { runtime: { modelId: "anthropic/x" } }),
    evt("turn.started", { turnId: "turn_0", sequence: 0 }),
    evt("message.received", { turnId: "turn_0", message: "please fix #7", sequence: 0 }),
    evt("step.started", { turnId: "turn_0", stepIndex: 0, sequence: 1 }),
    evt("message.completed", {
      turnId: "turn_0",
      stepIndex: 0,
      sequence: 1,
      message: "on it",
      finishReason: "stop",
    }),
    evt(
      "step.completed",
      {
        turnId: "turn_0",
        stepIndex: 0,
        sequence: 1,
        finishReason: "stop",
        usage: { inputTokens: 120, outputTokens: 34 },
      },
      "2026-07-27T00:00:02.000Z",
    ),
    evt("turn.completed", { turnId: "turn_0", sequence: 1 }, "2026-07-27T00:00:03.000Z"),
  ];
}

/** The same turn, still in flight — no turn.completed. */
function runningTurn(): PushedEvent[] {
  return settledTurn().slice(0, 4);
}

beforeEach(() => {
  store = makeFakeStore();
});

describe("ingestPushedTurn", () => {
  it("records a settled channel:github turn as a completed `github` run", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await ingestPushedTurn(
      {
        deploymentId,
        sessionId: "wrun_1",
        turnId: "turn_0",
        turnSequence: 0,
        channelKind: "channel:github",
        modelId: "anthropic/x",
        agentName: "deputy",
        final: true,
        events: settledTurn(),
      },
      deps,
    );

    expect(result).toEqual({ ok: true, recorded: true });
    expect(deps.starts).toHaveLength(0);
    expect(deps.finishes).toHaveLength(1);
    const [finish] = deps.finishes;
    expect(finish.projectId).toBe(PROJECT);
    expect(finish.deploymentId).toBe(deploymentId);
    // The classified channel is what the Runs tab filters on — never eve's namespaced kind.
    expect(finish.channel).toBe("github");
    expect(finish.externalRunId).toBe("wrun_1:turn_0");
    expect(finish.externalSessionId).toBe("wrun_1");
    expect(finish.result.ok).toBe(true);
    expect(finish.result.reply).toBe("on it");
    expect(finish.wallClockMs).toBe(3_000);
    // The raw kind survives on metadata, so nothing is lost by classifying.
    expect(finish.metadata).toMatchObject({
      eveSessionId: "wrun_1",
      eveTrigger: "channel:github",
      source: "push",
      eveAgentName: "deputy",
    });
  });

  it("sums the turn's token usage onto the run", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    await ingestPushedTurn(
      {
        deploymentId,
        sessionId: "wrun_1",
        turnId: "turn_0",
        channelKind: "channel:github",
        events: settledTurn(),
      },
      deps,
    );
    const steps = deps.finishes[0].result.steps;
    expect(steps.reduce((n, s) => n + (s.tokensIn ?? 0), 0)).toBe(120);
    expect(steps.reduce((n, s) => n + (s.tokensOut ?? 0), 0)).toBe(34);
  });

  it("records an in-flight turn as a `running` row (the #118 win)", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await ingestPushedTurn(
      {
        deploymentId,
        sessionId: "wrun_1",
        turnId: "turn_0",
        channelKind: "channel:github",
        events: runningTurn(),
      },
      deps,
    );

    expect(result).toEqual({ ok: true, recorded: true });
    expect(deps.finishes).toHaveLength(0);
    expect(deps.starts).toHaveLength(1);
    expect(deps.starts[0].ids.channel).toBe("github");
    expect(deps.starts[0].ids.externalRunId).toBe("wrun_1:turn_0");
    expect(deps.starts[0].ids.userMessage).toBe("please fix #7");
  });

  it("re-pushing the same turn yields the identical externalRunId (idempotent by construction)", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    const payload = {
      deploymentId,
      sessionId: "wrun_1",
      turnId: "turn_0",
      channelKind: "channel:github",
      events: settledTurn(),
    };
    await ingestPushedTurn(payload, deps);
    await ingestPushedTurn(payload, deps);

    expect(deps.finishes).toHaveLength(2);
    expect(deps.finishes[0].externalRunId).toBe(deps.finishes[1].externalRunId);
    // The whole turn is resent each flush, so the second write carries the same transcript —
    // that is what lets `ingestRunWith` replace steps wholesale without ever truncating one.
    expect(deps.finishes[1].result.steps).toEqual(deps.finishes[0].result.steps);
  });

  it("a running push then a settled push transitions the same run", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    await ingestPushedTurn(
      {
        deploymentId,
        sessionId: "wrun_1",
        turnId: "turn_0",
        channelKind: "channel:github",
        events: runningTurn(),
      },
      deps,
    );
    await ingestPushedTurn(
      {
        deploymentId,
        sessionId: "wrun_1",
        turnId: "turn_0",
        channelKind: "channel:github",
        final: true,
        events: settledTurn(),
      },
      deps,
    );
    expect(deps.starts[0].ids.externalRunId).toBe(deps.finishes[0].externalRunId);
  });

  it("writes nothing for an http-homed turn and does not ask it to retry", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    for (const channelKind of ["http", "channel:http", "", null, undefined]) {
      const result = await ingestPushedTurn(
        {
          deploymentId,
          sessionId: "wrun_1",
          turnId: "turn_0",
          channelKind,
          events: settledTurn(),
        },
        deps,
      );
      expect(result).toEqual({
        ok: true,
        recorded: false,
        reason: "channel-not-recorded",
      });
    }
    expect(deps.starts).toHaveLength(0);
    expect(deps.finishes).toHaveLength(0);
  });

  it("skips silently when the batch does not contain the claimed turn", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    const result = await ingestPushedTurn(
      {
        deploymentId,
        sessionId: "wrun_1",
        turnId: "turn_99",
        channelKind: "channel:github",
        events: settledTurn(),
      },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      recorded: false,
      reason: "turn-not-in-batch",
    });
    expect(deps.starts).toHaveLength(0);
    expect(deps.finishes).toHaveLength(0);
  });

  it("reports a stopped deployment as a skip, not a failure", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({ startAccepted: false });
    const result = await ingestPushedTurn(
      {
        deploymentId,
        sessionId: "wrun_1",
        turnId: "turn_0",
        channelKind: "channel:github",
        events: runningTurn(),
      },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      recorded: false,
      reason: "deployment-not-live",
    });
  });

  it("refuses a deployment the control plane no longer knows", async () => {
    await seedDeployment();
    const deps = makeDeps();
    const result = await ingestPushedTurn(
      {
        deploymentId: "dep_gone",
        sessionId: "wrun_1",
        turnId: "turn_0",
        channelKind: "channel:github",
        events: settledTurn(),
      },
      deps,
    );
    expect(result).toEqual({
      ok: false,
      error: "Your deployment is no longer known to harnesst.",
    });
    expect(deps.finishes).toHaveLength(0);
  });

  it("never takes project or release off the wire", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    await ingestPushedTurn(
      {
        deploymentId,
        sessionId: "wrun_1",
        turnId: "turn_0",
        channelKind: "channel:github",
        events: settledTurn(),
        // A hostile agent naming someone else's project/release.
        ...({ projectId: "proj_evil", releaseId: "rel_evil" } as object),
      },
      deps,
    );
    const dep = await store.deployments.findById(deploymentId);
    expect(deps.finishes[0].projectId).toBe(PROJECT);
    expect(deps.finishes[0].releaseId).toBe(dep!.releaseId);
  });
});

describe("normalizePushedEvents", () => {
  it("keeps well-formed events and drops junk without failing the batch", () => {
    const events = normalizePushedEvents([
      { type: "turn.started", data: { turnId: "turn_0" }, meta: { at: "x" } },
      { type: "", data: {} },
      null,
      "nope",
      { data: { turnId: "turn_0" } },
      { type: "turn.completed", data: "not-an-object" },
    ]);
    expect(events).toEqual([
      { type: "turn.started", data: { turnId: "turn_0" }, meta: { at: "x" } },
      { type: "turn.completed", data: {}, meta: undefined },
    ]);
  });

  it("rejects a non-array and an oversized batch", () => {
    expect(normalizePushedEvents("nope")).toBeNull();
    expect(normalizePushedEvents({})).toBeNull();
    expect(
      normalizePushedEvents(
        Array.from({ length: 2_501 }, () => ({ type: "step.started", data: {} })),
      ),
    ).toBeNull();
  });
});
