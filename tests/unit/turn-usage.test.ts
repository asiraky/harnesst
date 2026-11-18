import { describe, expect, it } from "vitest";

import {
  actionToolName,
  applyCompactionEvent,
  readStepUsage,
  readSubagentCall,
  readSubagentInvocation,
  stepKeyOf,
  type TurnCompaction,
} from "~/observability/turn-usage";

describe("readStepUsage", () => {
  it("reads every usage field eve reports", () => {
    expect(
      readStepUsage({
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 1000,
        cacheWriteTokens: 150,
        costUsd: 0.0123,
      }),
    ).toEqual({
      tokensIn: 1200,
      tokensOut: 80,
      cacheReadTokens: 1000,
      cacheWriteTokens: 150,
      costUsd: 0.0123,
    });
  });

  it("leaves out fields the provider did not report, keeping a reported zero", () => {
    expect(readStepUsage({ inputTokens: 10, outputTokens: 0 })).toEqual({
      tokensIn: 10,
      tokensOut: 0,
    });
  });

  it("drops values that are not usable counts", () => {
    expect(
      readStepUsage({
        inputTokens: "10",
        outputTokens: Number.NaN,
        cacheReadTokens: -1,
        costUsd: null,
      }),
    ).toEqual({});
  });

  it("returns nothing when there is no usage object", () => {
    expect(readStepUsage(undefined)).toEqual({});
    expect(readStepUsage("x")).toEqual({});
  });
});

describe("applyCompactionEvent", () => {
  const at = new Date("2026-11-18T00:00:00.000Z");
  const later = new Date("2026-11-18T00:00:05.000Z");

  it("records a request and settles it on the matching completion", () => {
    const list: TurnCompaction[] = [];
    applyCompactionEvent(
      list,
      "compaction.requested",
      { sequence: 3, modelId: "harnesst.chat/anthropic/claude-x", usageInputTokens: 180000 },
      at,
      2,
    );
    applyCompactionEvent(list, "compaction.completed", { sequence: 3 }, later, 2);
    expect(list).toEqual([
      {
        afterStepIndex: 2,
        at: at.toISOString(),
        sequence: 3,
        usageInputTokens: 180000,
        modelId: "anthropic/claude-x",
        completed: true,
      },
    ]);
  });

  it("keeps a request with no completion open, and an uncounted trigger as null", () => {
    const list: TurnCompaction[] = [];
    applyCompactionEvent(
      list,
      "compaction.requested",
      { sequence: 1, modelId: "m", usageInputTokens: null },
      at,
      0,
    );
    expect(list[0]).toMatchObject({ completed: false, usageInputTokens: null });
  });

  it("does not settle a request of a different sequence", () => {
    const list: TurnCompaction[] = [];
    applyCompactionEvent(list, "compaction.requested", { sequence: 1 }, at, 0);
    applyCompactionEvent(list, "compaction.completed", { sequence: 2 }, later, 1);
    expect(list.map((c) => [c.sequence, c.completed])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("records a completion whose request was not read as a completed pass", () => {
    const list: TurnCompaction[] = [];
    applyCompactionEvent(
      list,
      "compaction.completed",
      { sequence: 4, modelId: "m/y" },
      later,
      5,
    );
    expect(list).toEqual([
      {
        afterStepIndex: 5,
        at: later.toISOString(),
        sequence: 4,
        usageInputTokens: null,
        modelId: "m/y",
        completed: true,
      },
    ]);
  });
});

describe("readSubagentInvocation", () => {
  it("reads the parent call off a subagent child session", () => {
    expect(
      readSubagentInvocation({
        invocation: {
          kind: "subagent",
          name: "researcher",
          parentCallId: "call_9",
          parentSessionId: "sess_parent",
          parentTurnId: "turn_2",
        },
      }),
    ).toEqual({
      name: "researcher",
      parentCallId: "call_9",
      parentSessionId: "sess_parent",
      parentTurnId: "turn_2",
    });
  });

  it("returns null for a top-level session or an incomplete invocation", () => {
    expect(readSubagentInvocation({})).toBeNull();
    expect(readSubagentInvocation({ invocation: { kind: "channel" } })).toBeNull();
    expect(
      readSubagentInvocation({ invocation: { kind: "subagent", name: "x" } }),
    ).toBeNull();
  });
});

describe("stepKeyOf", () => {
  it("keeps the turn number and step index eve sent", () => {
    expect(stepKeyOf({ sequence: 2, stepIndex: 0 })).toEqual({ sequence: 2, stepIndex: 0 });
  });

  it("leaves out an index eve did not send instead of guessing one", () => {
    expect(stepKeyOf({ sequence: 2 })).toEqual({ sequence: 2 });
    expect(stepKeyOf({})).toEqual({});
  });
});

describe("readSubagentCall", () => {
  it("takes the subagent's name from toolName, where eve puts it", () => {
    expect(
      readSubagentCall({
        callId: "c1",
        childSessionId: "wrun_1",
        name: "ask_researcher",
        toolName: "researcher",
      }),
    ).toEqual({ callId: "c1", name: "researcher", childSessionId: "wrun_1" });
  });

  it("falls back to name, then to no name", () => {
    expect(readSubagentCall({ callId: "c1", childSessionId: "w", name: "x" })?.name).toBe("x");
    expect(readSubagentCall({ callId: "c1", childSessionId: "w" })?.name).toBeNull();
  });

  it("returns null without a call id or child session id", () => {
    expect(readSubagentCall({ childSessionId: "w" })).toBeNull();
    expect(readSubagentCall({ callId: "c1", childSessionId: "" })).toBeNull();
  });
});

describe("actionToolName", () => {
  it("uses toolName, else a runtime action's name, else a placeholder", () => {
    expect(actionToolName({ toolName: "bash", name: "x" })).toBe("bash");
    expect(actionToolName({ kind: "subagent-call", name: "researcher" })).toBe("researcher");
    expect(actionToolName({})).toBe("tool");
  });
});
