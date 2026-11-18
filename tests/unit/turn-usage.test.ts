import { describe, expect, it } from "vitest";

import {
  actionToolName,
  applyCompactionEvent,
  readStepUsage,
  applySubagentCalled,
  readSubagentAction,
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

describe("readSubagentAction", () => {
  it("reads a subagent or remote-agent call off its runtime action", () => {
    expect(
      readSubagentAction({ kind: "subagent-call", callId: "c1", name: "ask", subagentName: "researcher" }),
    ).toEqual({ callId: "c1", name: "researcher", childSessionId: null });
    expect(
      readSubagentAction({ kind: "remote-agent-call", callId: "c2", name: "ask", remoteAgentName: "billing" }),
    ).toEqual({ callId: "c2", name: "billing", childSessionId: null });
  });

  it("returns null for an ordinary tool call or a call without an id", () => {
    expect(readSubagentAction({ toolName: "bash", callId: "c1" })).toBeNull();
    expect(readSubagentAction({ kind: "subagent-call", subagentName: "x" })).toBeNull();
  });
});

describe("applySubagentCalled", () => {
  const action = { callId: "c1", name: "researcher", childSessionId: null };

  it("adds the child session and keeps the action's name", () => {
    expect(
      applySubagentCalled(action, { callId: "c1", childSessionId: "wrun_1", name: "ask", toolName: "other" }),
    ).toEqual({ callId: "c1", name: "researcher", childSessionId: "wrun_1" });
  });

  it("takes the name from toolName, where eve puts it, when the action had none", () => {
    expect(
      applySubagentCalled(undefined, { callId: "c1", childSessionId: "w", name: "ask", toolName: "researcher" }),
    ).toEqual({ callId: "c1", name: "researcher", childSessionId: "w" });
    expect(applySubagentCalled(undefined, { callId: "c1", childSessionId: "w", name: "ask" })?.name).toBe("ask");
  });

  it("leaves the call alone without a child session, or for another call id", () => {
    expect(applySubagentCalled(action, { callId: "c1" })).toBe(action);
    expect(applySubagentCalled(action, { callId: "c9", childSessionId: "w" })).toBe(action);
    expect(applySubagentCalled(undefined, { callId: "c1", childSessionId: "" })).toBeUndefined();
  });
});

describe("actionToolName", () => {
  it("uses toolName, else a runtime action's name, else a placeholder", () => {
    expect(actionToolName({ toolName: "bash", name: "x" })).toBe("bash");
    expect(actionToolName({ kind: "subagent-call", name: "researcher" })).toBe("researcher");
    expect(actionToolName({})).toBe("tool");
  });
});
