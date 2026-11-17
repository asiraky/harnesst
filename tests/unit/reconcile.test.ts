/**
 * Channel-run reconciler orchestration (issue #119) against fully in-memory deps — no DB, no eve.
 * Covers: http sessions skipped, cron/discord folded and recorded with the right channels + run-id
 * shapes, Discord placeholder correlation (exact match, time fallback, claimed at most once), a
 * hung turn surfaced as `running`, cursor saves + the no-activity short-circuit on a second tick,
 * and graceful skips when world access is null or throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ABANDONED_TURN_MS,
  readSessionBounded,
  reconcileTick,
  resetReconcileWarnings,
  resetStaleRunChecks,
  settleStaleRuns,
  STALE_RUN_RECHECK_MS,
  UNREADABLE_SESSION_MS,
  type StaleRun,
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
  staleRuns?: StaleRun[];
  /** Sessions whose stream read throws (eve hangs on an unknown id until the connect timeout). */
  unreadable?: string[];
  /** Sessions whose bounded read is cut short before the stream ends. */
  incomplete?: string[];
}

function makeDeps(config: FakeConfig) {
  const cursors = new Map<string, ReconcileCursor>();
  const finishCalls: Parameters<ReconcileDeps["recordFinish"]>[0][] = [];
  const startCalls: { ids: unknown; startedAt: Date }[] = [];
  const readSessionEvents = vi.fn(
    async (_url: string, sessionId: string, startIndex: number) => {
      if (config.unreadable?.includes(sessionId)) throw new Error("aborted");
      const all = config.streams[sessionId] ?? [];
      return all.filter((e) => e.streamIndex > startIndex);
    },
  );
  const readSessionBounded = vi.fn(async (_url: string, sessionId: string) => {
    if (config.unreadable?.includes(sessionId)) throw new Error("aborted");
    return {
      events: config.streams[sessionId] ?? [],
      complete: !config.incomplete?.includes(sessionId),
    };
  });
  const listWorldSessions = vi.fn(async () => {
    if (typeof config.sessions === "function") return config.sessions();
    return config.sessions;
  });

  const deps: ReconcileDeps = {
    listTargets: async () => [TARGET],
    listStaleRuns: async () => config.staleRuns ?? [],
    listWorldSessions,
    readSessionEvents,
    readSessionBounded,
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

  return {
    deps,
    cursors,
    finishCalls,
    startCalls,
    readSessionEvents,
    readSessionBounded,
    listWorldSessions,
  };
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

describe("settleStaleRuns", () => {
  const STARTED = new Date("2026-07-12T00:00:00.000Z");
  const staleRun = (sessionId: string): StaleRun => ({
    runId: `run_${sessionId}`,
    externalRunId: `${sessionId}:turn_0`,
    channel: "ledger-wake",
    metadata: { eveSessionId: sessionId, source: "push", input: "Ledger: item x" },
    startedAt: STARTED,
  });
  const at = (ms: number) => STARTED.getTime() + ms;

  beforeEach(() => {
    resetStaleRunChecks();
  });

  it("settles a row as failed from the session.failed eve wrote only to the stream", async () => {
    const { deps, finishCalls } = makeDeps({
      sessions: [],
      staleRuns: [staleRun("wrun_a")],
      streams: {
        wrun_a: indexed([
          { type: "message.received", data: { turnId: "turn_0", message: "Ledger: item x" }, meta: { at: "2026-07-12T00:00:00.000Z" } },
          { type: "step.started", data: { turnId: "turn_0", sequence: 1 }, meta: { at: "2026-07-12T00:00:01.000Z" } },
          {
            type: "session.failed",
            data: { code: "AI_RetryError", message: "Codex backend error (HTTP 429): usage_limit_reached" },
            meta: { at: "2026-07-12T00:05:00.000Z" },
          },
        ]),
      },
    });

    await settleStaleRuns(TARGET, deps, at(20 * 60_000));

    expect(finishCalls).toHaveLength(1);
    const call = finishCalls[0];
    expect(call.externalRunId).toBe("wrun_a:turn_0");
    expect(call.channel).toBe("ledger-wake");
    expect(call.result.ok).toBe(false);
    expect(call.result.error).toContain("usage_limit_reached");
    expect(call.finishedAt?.toISOString()).toBe("2026-07-12T00:05:00.000Z");
    expect(call.metadata).toMatchObject({ source: "push", settledBy: "stale-run-sweep" });
  });

  it("settles a row as completed when the stream shows the turn finished", async () => {
    const { deps, finishCalls } = makeDeps({
      sessions: [],
      staleRuns: [staleRun("wrun_done")],
      streams: { wrun_done: completedTurn("go", "all done") },
    });

    await settleStaleRuns(TARGET, deps, at(20 * 60_000));

    expect(finishCalls[0]?.result.ok).toBe(true);
    expect(finishCalls[0]?.result.reply).toBe("all done");
  });

  it("leaves a live turn alone and does not re-read it until the recheck interval passes", async () => {
    const { deps, finishCalls, readSessionBounded } = makeDeps({
      sessions: [],
      staleRuns: [staleRun("wrun_live")],
      streams: { wrun_live: hungTurn("long job") },
    });

    const now = at(60 * 60_000); // an hour in, last event at +0.5s: well under the abandon cap
    await settleStaleRuns(TARGET, deps, now);
    await settleStaleRuns(TARGET, deps, now + STALE_RUN_RECHECK_MS - 1);
    expect(readSessionBounded).toHaveBeenCalledTimes(1);
    await settleStaleRuns(TARGET, deps, now + STALE_RUN_RECHECK_MS);
    expect(readSessionBounded).toHaveBeenCalledTimes(2);
    expect(finishCalls).toHaveLength(0);
  });

  it("fails a turn whose stream went silent past the abandon cap", async () => {
    const { deps, finishCalls } = makeDeps({
      sessions: [],
      staleRuns: [staleRun("wrun_dead")],
      streams: { wrun_dead: hungTurn("long job") },
    });

    await settleStaleRuns(TARGET, deps, at(500 + ABANDONED_TURN_MS));

    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0].result.ok).toBe(false);
    expect(finishCalls[0].result.error).toContain("restarted mid-turn");
    // Finished when it last reported, not when harnesst noticed.
    expect(finishCalls[0].finishedAt?.toISOString()).toBe("2026-07-12T00:00:00.500Z");
  });

  it("gives up on an unreadable session only after a day", async () => {
    const config: FakeConfig = {
      sessions: [],
      staleRuns: [staleRun("wrun_gone")],
      streams: {},
      unreadable: ["wrun_gone"],
    };
    const { deps, finishCalls } = makeDeps(config);

    await settleStaleRuns(TARGET, deps, at(UNREADABLE_SESSION_MS - 1));
    expect(finishCalls).toHaveLength(0);

    resetStaleRunChecks();
    await settleStaleRuns(TARGET, deps, at(UNREADABLE_SESSION_MS));
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0].result.ok).toBe(false);
    expect(finishCalls[0].userMessage).toBe("Ledger: item x");
  });

  it("does not act on a read that was cut short, even past the abandon cap", async () => {
    const { deps, finishCalls } = makeDeps({
      sessions: [],
      staleRuns: [staleRun("wrun_big")],
      streams: { wrun_big: hungTurn("long job") },
      incomplete: ["wrun_big"],
    });

    await settleStaleRuns(TARGET, deps, at(500 + ABANDONED_TURN_MS));

    expect(finishCalls).toHaveLength(0);
  });

  it("caps the stream reads one deployment does per tick", async () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    const { deps, readSessionBounded } = makeDeps({
      sessions: [],
      staleRuns: ids.map(staleRun),
      streams: Object.fromEntries(ids.map((id) => [id, hungTurn("job")])),
    });

    await settleStaleRuns(TARGET, deps, at(60 * 60_000));
    expect(readSessionBounded).toHaveBeenCalledTimes(5);
    await settleStaleRuns(TARGET, deps, at(60 * 60_000 + 1));
    expect(readSessionBounded.mock.calls.slice(5).map((c) => c[1])).toEqual(["s6", "s7"]);
  });
});

describe("readSessionBounded", () => {
  function ndjsonResponse(lines: string[], close: boolean): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
        if (close) controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }
  const event = (i: number, pad = 0) =>
    JSON.stringify({ type: "action.result", data: { i, pad: "x".repeat(pad) } });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the opening and the end of a long stream and drops the middle", async () => {
    // 200 head events, then 3000 ~1KB events: only the last ~1MB of them can be kept.
    const lines = [
      ...Array.from({ length: 200 }, (_, i) => event(i)),
      ...Array.from({ length: 3000 }, (_, i) => event(200 + i, 1000)),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse(lines, true)));

    const { events, complete } = await readSessionBounded("http://inst", "wrun_x");

    expect(complete).toBe(true);
    const ids = events.map((e) => e.data.i as number);
    expect(ids.slice(0, 200)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(ids.at(-1)).toBe(3199);
    expect(events.length).toBeLessThan(1500);
    // Stream positions survive the trim, so the tail still knows where it sits.
    expect(events.at(-1)?.streamIndex).toBe(3200);
    // What is kept is contiguous: only the middle went.
    const tail = ids.slice(200);
    expect(tail).toEqual(Array.from({ length: tail.length }, (_, i) => 3200 - tail.length + i));
  });

  it("counts a stream that goes quiet as read to the end", async () => {
    // eve keeps a finished session's stream open; the idle cutoff is how a read ends.
    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse([event(0), event(1)], false)));

    const { events, complete } = await readSessionBounded("http://inst", "wrun_open");

    expect(complete).toBe(true);
    expect(events).toHaveLength(2);
  });
});
