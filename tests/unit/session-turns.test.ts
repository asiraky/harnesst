/**
 * Pure fold of eve's replayed session stream into per-turn results (issue #119). Feeds hand-built
 * NDJSON-shaped event arrays and asserts steps/messages/tokens/duration/order, cursor math for
 * settled vs unsettled trailing turns, failure attribution, model carry-in, and channel mapping.
 */
import { describe, expect, it } from "vitest";

import { turnToSteps } from "~/observability/record.server";
import {
  channelForTrigger,
  foldSessionEvents,
  type IndexedEveEvent,
} from "~/observability/session-turns.server";
import type { RawEveEvent } from "~/agent/talk.server";

/** Label a raw event array with 1-based stream indices (startIndex 0 → first event is 1). */
function indexed(events: RawEveEvent[]): IndexedEveEvent[] {
  return events.map((e, i) => ({ ...e, streamIndex: i + 1 }));
}

function evt(
  type: string,
  data: Record<string, unknown>,
  at?: string,
): RawEveEvent {
  return { type, data, meta: at ? { at } : undefined };
}

describe("foldSessionEvents", () => {
  it("folds a completed turn with a model call, tool call, and interleaved messages", () => {
    const events = indexed([
      evt("session.started", { runtime: { modelId: "m/x" } }),
      evt("turn.started", { turnId: "turn_0" }, "2026-07-12T00:00:00.000Z"),
      evt(
        "message.received",
        { turnId: "turn_0", message: "do it" },
        "2026-07-12T00:00:00.000Z",
      ),
      evt("message.completed", { turnId: "turn_0", message: "thinking" }),
      evt(
        "step.started",
        { turnId: "turn_0", sequence: 1 },
        "2026-07-12T00:00:01.000Z",
      ),
      evt("actions.requested", {
        turnId: "turn_0",
        sequence: 1,
        actions: [{ toolName: "bash", input: { command: "ls" }, callId: "c1" }],
      }),
      evt("action.result", {
        turnId: "turn_0",
        status: "completed",
        result: { callId: "c1", output: { stdout: "ok", exitCode: 0 } },
      }),
      evt(
        "step.completed",
        {
          turnId: "turn_0",
          sequence: 1,
          usage: { inputTokens: 10, outputTokens: 4 },
        },
        "2026-07-12T00:00:01.500Z",
      ),
      evt("message.completed", { turnId: "turn_0", message: "all done" }),
      evt("turn.completed", { turnId: "turn_0" }, "2026-07-12T00:00:02.000Z"),
      evt("session.waiting", {}),
    ]);

    const fold = foldSessionEvents(events);
    expect(fold.modelId).toBe("m/x");
    expect(fold.turns).toHaveLength(1);

    const turn = fold.turns[0];
    expect(turn.turnId).toBe("turn_0");
    expect(turn.settled).toBe(true);
    expect(turn.userMessage).toBe("do it");
    expect(turn.startedAt.toISOString()).toBe("2026-07-12T00:00:00.000Z");
    expect(turn.finishedAt?.toISOString()).toBe("2026-07-12T00:00:02.000Z");

    expect(turn.result.ok).toBe(true);
    expect(turn.result.modelId).toBe("m/x");
    expect(turn.result.reply).toBe("thinking\n\nall done");
    expect(turn.result.steps).toHaveLength(1);
    expect(turn.result.steps[0]).toMatchObject({
      type: "step.completed",
      durationMs: 500,
      tokensIn: 10,
      tokensOut: 4,
      toolName: "bash",
    });
    expect(turn.result.steps[0].actions?.[0]).toMatchObject({
      toolName: "bash",
      input: { command: "ls" },
      output: { stdout: "ok", exitCode: 0 },
      exitCode: 0,
      isError: false,
    });
    // Messages tagged with the step count at completion → "thinking" before, "all done" after.
    expect(turn.result.messages).toEqual([
      { afterStepIndex: 0, text: "thinking" },
      { afterStepIndex: 1, text: "all done" },
    ]);

    // The fold's result feeds turnToSteps to the ingest shape the transcript renders.
    const steps = turnToSteps(turn.result, { userMessage: turn.userMessage });
    expect(steps.map((s) => s.type)).toEqual([
      "message", // user "do it"
      "message", // assistant "thinking" (afterStepIndex 0)
      "model_call",
      "tool_call",
      "message", // assistant "all done" (afterStepIndex 1)
    ]);
    expect(steps[0].data).toMatchObject({ role: "user", text: "do it" });
    expect(steps[2]).toMatchObject({
      type: "model_call",
      model: "m/x",
      tokensInput: 10,
      tokensOutput: 4,
    });

    // All settled → cursor advances to the end of consumed events.
    expect(fold.nextStreamIndex).toBe(events.length);
  });

  it("folds a multi-turn session into two settled turns and advances the cursor", () => {
    const events = indexed([
      evt("session.started", { runtime: { modelId: "m/x" } }),
      evt("message.received", { turnId: "turn_0", message: "one" }, "2026-07-12T00:00:00.000Z"),
      evt("message.completed", { turnId: "turn_0", message: "first" }),
      evt("turn.completed", { turnId: "turn_0" }, "2026-07-12T00:00:01.000Z"),
      evt("message.received", { turnId: "turn_1", message: "two" }, "2026-07-12T00:00:02.000Z"),
      evt("message.completed", { turnId: "turn_1", message: "second" }),
      evt("turn.completed", { turnId: "turn_1" }, "2026-07-12T00:00:03.000Z"),
    ]);

    const fold = foldSessionEvents(events);
    expect(fold.turns.map((t) => t.turnId)).toEqual(["turn_0", "turn_1"]);
    expect(fold.turns.every((t) => t.settled)).toBe(true);
    expect(fold.turns[0].result.reply).toBe("first");
    expect(fold.turns[1].result.reply).toBe("second");
    expect(fold.nextStreamIndex).toBe(events.length);
  });

  it("leaves a trailing unsettled turn running and parks the cursor before it", () => {
    const events = indexed([
      evt("message.received", { turnId: "turn_0", message: "one" }, "2026-07-12T00:00:00.000Z"),
      evt("message.completed", { turnId: "turn_0", message: "first" }),
      evt("turn.completed", { turnId: "turn_0" }, "2026-07-12T00:00:01.000Z"),
      // turn_1 starts but never settles (a hung cron turn — the #118 case).
      evt("message.received", { turnId: "turn_1", message: "two" }, "2026-07-12T00:00:02.000Z"),
      evt("step.started", { turnId: "turn_1", sequence: 1 }, "2026-07-12T00:00:02.500Z"),
    ]);

    const fold = foldSessionEvents(events);
    expect(fold.turns).toHaveLength(2);
    expect(fold.turns[0].settled).toBe(true);
    expect(fold.turns[1].settled).toBe(false);
    expect(fold.turns[1].result.ok).toBe(false);
    expect(fold.turns[1].result.error).toBeNull();

    // The earliest unsettled turn's first event is at streamIndex 4 → park one before it (3),
    // so the next drain re-reads turn_1 from its start while leaving turn_0 done.
    const firstEventOfTurn1 = fold.turns[1].firstEventStreamIndex;
    expect(firstEventOfTurn1).toBe(4);
    expect(fold.nextStreamIndex).toBe(3);
  });

  it("marks a failed turn not-ok with its error text", () => {
    const events = indexed([
      evt("message.received", { turnId: "turn_0", message: "boom" }, "2026-07-12T00:00:00.000Z"),
      evt("step.started", { turnId: "turn_0", sequence: 1 }, "2026-07-12T00:00:00.100Z"),
      evt("step.failed", {
        turnId: "turn_0",
        sequence: 1,
        message: "fetch failed",
        code: "AI_APICallError",
      }, "2026-07-12T00:00:00.200Z"),
      evt("turn.failed", { turnId: "turn_0", message: "The turn failed." }, "2026-07-12T00:00:00.300Z"),
    ]);

    const fold = foldSessionEvents(events);
    expect(fold.turns).toHaveLength(1);
    const turn = fold.turns[0];
    expect(turn.settled).toBe(true);
    expect(turn.result.ok).toBe(false);
    expect(turn.result.error).toContain("fetch failed");
    expect(turn.result.steps[0]).toMatchObject({
      isError: true,
      message: "fetch failed",
      code: "AI_APICallError",
    });
  });

  it("carries the model id in from opts when session.started is behind the cursor", () => {
    const events = indexed([
      evt("message.received", { turnId: "turn_5", message: "later" }, "2026-07-12T00:00:00.000Z"),
      evt("message.completed", { turnId: "turn_5", message: "ok" }),
      evt("turn.completed", { turnId: "turn_5" }, "2026-07-12T00:00:01.000Z"),
    ]);
    const fold = foldSessionEvents(events, { modelId: "carried/model" });
    expect(fold.modelId).toBe("carried/model");
    expect(fold.turns[0].result.modelId).toBe("carried/model");
  });
});

describe("channelForTrigger", () => {
  it("maps triggers to run channels", () => {
    expect(channelForTrigger("http")).toBeNull();
    expect(channelForTrigger("")).toBeNull();
    expect(channelForTrigger("schedule")).toBe("cron");
    expect(channelForTrigger("discord")).toBe("discord");
    expect(channelForTrigger("github")).toBe("github");
    expect(channelForTrigger("slack")).toBe("slack");
  });

  /**
   * eve 0.22.6 namespaces every AUTHORED channel adapter: `resolveChannelDefinition` sets
   * `adapter.kind = "channel:" + name`, and only the built-in HTTP adapter keeps a bare kind.
   * A production run on 2026-07-26 observed `$eve.trigger: "channel:github"`. Before this fix
   * the classifier returned that literal, which would have written `runs.channel` values no
   * filter, badge or query in the app matches.
   */
  it("strips eve's `channel:` adapter namespace", () => {
    expect(channelForTrigger("channel:github")).toBe("github");
    expect(channelForTrigger("channel:discord")).toBe("discord");
    expect(channelForTrigger("channel:slack")).toBe("slack");
    expect(channelForTrigger("channel:schedule")).toBe("cron");
  });

  it("never yields the raw namespaced kind as a channel", () => {
    expect(channelForTrigger("channel:github")).not.toBe("channel:github");
  });

  it("skips http however it is spelled, and anything unclassifiable", () => {
    expect(channelForTrigger("channel:http")).toBeNull();
    expect(channelForTrigger("  ")).toBeNull();
    expect(channelForTrigger("channel:")).toBeNull();
    expect(channelForTrigger(null)).toBeNull();
    expect(channelForTrigger(undefined)).toBeNull();
  });
});
