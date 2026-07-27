/**
 * Channel-run reconciler orchestration (issue #119) against fully in-memory deps — no DB, no eve.
 * Covers: http sessions skipped, cron/discord folded and recorded with the right channels + run-id
 * shapes, Discord placeholder correlation (exact match, time fallback, claimed at most once), a
 * hung turn surfaced as `running`, cursor saves + the no-activity short-circuit on a second tick,
 * and graceful skips when world access is null or throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  reconcileTick,
  resetReconcileWarnings,
  type DiscordPlaceholder,
  type ReconcileCursor,
  type ReconcileDeps,
  type ReconcileTarget,
} from "~/observability/reconcile.server";
import type { IndexedEveEvent } from "~/observability/session-turns.server";
import type { RawEveEvent } from "~/agent/talk.server";
import type { WorldSessionSummary } from "~/seams/types";

const TARGET: ReconcileTarget = {
  deploymentId: "dep1",
  releaseId: "rel1",
  url: "http://inst",
  worldKey: "env1",
  projectId: "proj1",
};

function indexed(events: RawEveEvent[]): IndexedEveEvent[] {
  return events.map((e, i) => ({ ...e, streamIndex: i + 1 }));
}

/** A one-turn completed session stream (user message + reply). */
function completedTurn(message: string, reply: string): IndexedEveEvent[] {
  return indexed([
    { type: "session.started", data: { runtime: { modelId: "m/x" } } },
    {
      type: "message.received",
      data: { turnId: "turn_0", message },
      meta: { at: "2026-07-12T00:00:00.000Z" },
    },
    { type: "message.completed", data: { turnId: "turn_0", message: reply } },
    {
      type: "turn.completed",
      data: { turnId: "turn_0" },
      meta: { at: "2026-07-12T00:00:01.000Z" },
    },
  ]);
}

/** A one-turn session that starts but never settles (hung). */
function hungTurn(message: string): IndexedEveEvent[] {
  return indexed([
    {
      type: "message.received",
      data: { turnId: "turn_0", message },
      meta: { at: "2026-07-12T00:00:00.000Z" },
    },
    {
      type: "step.started",
      data: { turnId: "turn_0", sequence: 1 },
      meta: { at: "2026-07-12T00:00:00.500Z" },
    },
  ]);
}

interface FakeConfig {
  sessions: WorldSessionSummary[] | null | (() => never);
  streams: Record<string, IndexedEveEvent[]>;
  placeholders?: DiscordPlaceholder[];
  recordStartResult?: boolean;
}

function makeDeps(config: FakeConfig) {
  const cursors = new Map<string, ReconcileCursor>();
  const finishCalls: Parameters<ReconcileDeps["recordFinish"]>[0][] = [];
  const startCalls: { ids: unknown; startedAt: Date }[] = [];
  const readSessionEvents = vi.fn(
    async (_url: string, sessionId: string, startIndex: number) => {
      const all = config.streams[sessionId] ?? [];
      return all.filter((e) => e.streamIndex > startIndex);
    },
  );
  const listWorldSessions = vi.fn(async () => {
    if (typeof config.sessions === "function") return config.sessions();
    return config.sessions;
  });

  const deps: ReconcileDeps = {
    listTargets: async () => [TARGET],
    listWorldSessions,
    readSessionEvents,
    getCursor: async (projectId, sid) => cursors.get(`${projectId}:${sid}`) ?? null,
    saveCursor: async (projectId, sid, cursor) => {
      cursors.set(`${projectId}:${sid}`, cursor);
    },
    listDiscordPlaceholders: async () => config.placeholders ?? [],
    recordStart: async (ids, startedAt) => {
      startCalls.push({ ids, startedAt });
      return config.recordStartResult ?? true;
    },
    recordFinish: async (input) => {
      finishCalls.push(input);
    },
  };

  return { deps, cursors, finishCalls, startCalls, readSessionEvents, listWorldSessions };
}

function session(
  over: Partial<WorldSessionSummary> & Pick<WorldSessionSummary, "sessionId" | "trigger">,
): WorldSessionSummary {
  return {
    status: "completed",
    title: "t",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:05.000Z",
    ...over,
  };
}

describe("reconcileTick", () => {
  it("records cron + discord sessions and skips http", async () => {
    const { deps, finishCalls, cursors, readSessionEvents } = makeDeps({
      sessions: [
        session({ sessionId: "wrun_cron", trigger: "schedule" }),
        session({ sessionId: "wrun_disc", trigger: "discord" }),
        session({ sessionId: "wrun_http", trigger: "http" }),
      ],
      streams: {
        wrun_cron: completedTurn("cron fired", "cron done"),
        wrun_disc: completedTurn("hello bot", "hi there"),
      },
      placeholders: [
        {
          runId: "run_ph",
          externalRunId: "discord:i1",
          input: "hello bot",
          startedAt: new Date("2026-07-12T00:00:00.000Z"),
        },
      ],
    });

    await reconcileTick(deps);

    // http session never touched.
    expect(readSessionEvents.mock.calls.map((c) => c[1])).not.toContain("wrun_http");
    expect(cursors.has("proj1:wrun_http")).toBe(false);

    const cron = finishCalls.find((c) => c.channel === "cron");
    expect(cron?.externalRunId).toBe("wrun_cron:turn_0");
    expect(cron?.externalSessionId).toBe("wrun_cron");
    expect(cron?.result.reply).toBe("cron done");

    // Discord placeholder claimed by exact message match → settled under its own run id.
    const disc = finishCalls.find((c) => c.channel === "discord");
    expect(disc?.externalRunId).toBe("discord:i1");
    expect(disc?.externalSessionId).toBe("wrun_disc");

    // Cursors saved for both recorded sessions.
    expect(cursors.get("proj1:wrun_cron")?.streamIndex).toBe(4);
    expect(cursors.get("proj1:wrun_disc")?.state.modelId).toBe("m/x");
  });

  it("short-circuits a session with no new activity on the next tick", async () => {
    const config: FakeConfig = {
      sessions: [session({ sessionId: "wrun_cron", trigger: "schedule" })],
      streams: { wrun_cron: completedTurn("go", "done") },
    };
    const { deps, readSessionEvents } = makeDeps(config);

    await reconcileTick(deps);
    expect(readSessionEvents).toHaveBeenCalledTimes(1);

    // Second tick: updatedAt (00:00:05) <= cursor.lastActivityAt (00:00:05) → skipped.
    await reconcileTick(deps);
    expect(readSessionEvents).toHaveBeenCalledTimes(1);
  });

  it("surfaces a hung turn as a running row", async () => {
    const { deps, startCalls, finishCalls } = makeDeps({
      sessions: [session({ sessionId: "wrun_cron", trigger: "schedule", status: "running" })],
      streams: { wrun_cron: hungTurn("long job") },
    });

    await reconcileTick(deps);

    expect(finishCalls).toHaveLength(0);
    expect(startCalls).toHaveLength(1);
    const ids = startCalls[0].ids as { channel: string; externalRunId: string };
    expect(ids.channel).toBe("cron");
    expect(ids.externalRunId).toBe("wrun_cron:turn_0");
  });

  it("claims a discord placeholder by time proximity and never twice", async () => {
    const { deps, finishCalls } = makeDeps({
      sessions: [
        session({
          sessionId: "wrun_d1",
          trigger: "discord",
          createdAt: "2026-07-12T00:00:00.000Z",
        }),
        session({
          sessionId: "wrun_d2",
          trigger: "discord",
          createdAt: "2026-07-12T00:00:10.000Z",
        }),
      ],
      streams: {
        // Neither message matches the placeholder's stored input → fall back to time.
        wrun_d1: completedTurn("synthesized /ask", "a1"),
        wrun_d2: completedTurn("another synthesized", "a2"),
      },
      placeholders: [
        {
          runId: "run_only",
          externalRunId: "discord:only",
          input: null,
          startedAt: new Date("2026-07-12T00:00:00.000Z"),
        },
      ],
    });

    await reconcileTick(deps);

    const claimed = finishCalls.filter((c) => c.externalRunId === "discord:only");
    expect(claimed).toHaveLength(1); // the single placeholder is claimed at most once
    // The unmatched discord session falls back to the eve-session run id.
    const fallback = finishCalls.filter((c) => c.externalRunId.startsWith("wrun_"));
    expect(fallback).toHaveLength(1);
    expect(fallback[0].externalRunId).toBe("wrun_d2:turn_0");
  });

  it("skips gracefully when world access is unavailable (null)", async () => {
    const { deps, finishCalls, startCalls } = makeDeps({
      sessions: null,
      streams: {},
    });
    await reconcileTick(deps);
    expect(finishCalls).toHaveLength(0);
    expect(startCalls).toHaveLength(0);
  });

  it("does not throw when a deployment sweep errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeDeps({
      sessions: () => {
        throw new Error("world db unreachable");
      },
      streams: {},
    });
    await expect(reconcileTick(deps)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * WS2 — the silent failure this workstream exists to end.
 *
 * `reconcileDeploymentSessions` returned on an empty/absent world without a word, so an operator
 * reading logs could not tell "this agent has done no channel work" from "the database this reads
 * has never existed, and never will, because the deployed eve has no Postgres workflow backend".
 * Every production tick since the reconciler shipped has taken this branch. It must now say which
 * of the two it is — and say it ONCE, since the sweep repeats every 60s forever and a line
 * repeated 1,440 times a day is filtered, i.e. silent again.
 */
describe("empty-world diagnostics", () => {
  beforeEach(() => {
    resetReconcileWarnings();
  });

  async function sweep(sessions: WorldSessionSummary[] | null) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeDeps({ sessions, streams: {} });
    await reconcileTick(deps);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    return { deps, lines };
  }

  it("names the architectural case when the deploy target exposes no world listing", async () => {
    const { lines } = await sweep(null);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("dep1");
    expect(lines[0]).toContain("exposes no world-session listing");
    // An operator must be told runs still arrive — otherwise this reads as total breakage.
    expect(lines[0]).toContain("/api/agent/runs");
  });

  it("distinguishes an empty world from an absent one", async () => {
    const { lines } = await sweep([]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('world "env1" reports no sessions');
    expect(lines[0]).not.toContain("exposes no world-session listing");
  });

  it("warns once per deployment, not once per 60s tick", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeDeps({ sessions: [], streams: {} });

    await reconcileTick(deps);
    await reconcileTick(deps);
    await reconcileTick(deps);

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("dep1"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("says nothing when the world does have sessions", async () => {
    const { lines } = await sweep([
      session({ sessionId: "wrun_h1", trigger: "http" }),
    ]);

    expect(lines).toHaveLength(0);
  });
});
