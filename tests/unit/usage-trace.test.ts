/**
 * The run trace (#418): model calls joined to gateway rows, tools attached to the call before
 * them, retries and 429s folded into one call, compactions splitting turns into cycles.
 */
import { describe, expect, it } from "vitest";

import {
  buildTrace,
  compositionParts,
  groupTurns,
  repeatedCalls,
  type TraceGatewayRow,
  type TraceStepRow,
} from "~/usage/trace";

function step(over: Partial<TraceStepRow> & { seq: number; type: string }): TraceStepRow {
  return {
    model: null,
    toolName: null,
    tokensInput: null,
    tokensOutput: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costUsd: null,
    contextWindow: null,
    eveSessionId: "s1",
    turnId: "t1",
    stepIndex: null,
    subagentName: null,
    callId: null,
    childSessionId: null,
    resultTokens: null,
    resultCapped: null,
    durationMs: null,
    isError: false,
    startedAt: null,
    withheld: null,
    compaction: null,
    errorCode: null,
    summary: null,
    inputHash: null,
    ...over,
  };
}

function gw(over: Partial<TraceGatewayRow>): TraceGatewayRow {
  return {
    sessionId: "s1",
    turnId: "t1",
    stepIndex: 0,
    startedAt: "2026-11-01T00:00:00.000Z",
    ttftMs: null,
    durationMs: 1000,
    httpStatus: 200,
    errorCode: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    contextWindow: null,
    composition: null,
    connectionId: "conn",
    planType: null,
    reasoningEffort: null,
    model: "gpt-x",
    ...over,
  };
}

describe("buildTrace", () => {
  it("attaches each tool call to the model call before it", () => {
    const t = buildTrace(
      [
        step({ seq: 1, type: "model_call", stepIndex: 0 }),
        step({ seq: 2, type: "tool_call", toolName: "read" }),
        step({ seq: 3, type: "tool_call", toolName: "bash" }),
        step({ seq: 4, type: "model_call", stepIndex: 1 }),
        step({ seq: 5, type: "tool_call", toolName: "grep" }),
      ],
      [],
    );
    expect(t.calls.map((c) => c.tools.map((x) => x.toolName))).toEqual([["read", "bash"], ["grep"]]);
    expect(t.calls.map((c) => c.index)).toEqual([1, 2]);
  });

  it("keeps step values over gateway values and leaves unjoined fields null", () => {
    const t = buildTrace(
      [
        step({ seq: 1, type: "model_call", stepIndex: 0, tokensInput: 500 }),
        step({ seq: 2, type: "model_call", stepIndex: 1 }),
      ],
      [gw({ stepIndex: 0, inputTokens: 480, reasoningTokens: 30, ttftMs: 200 })],
    );
    const [a, b] = t.calls;
    expect(a.input).toBe(500);
    expect(a.reasoning).toBe(30);
    expect(a.ttftMs).toBe(200);
    expect(a.startedAt).not.toBeNull();
    expect(b.input).toBeNull();
    expect(b.reasoning).toBeNull();
    expect(b.startedAt).toBeNull();
    expect(t.metrics.timedCalls).toBe(1);
  });

  it("shows the latest attempt for a retried step and counts the 429", () => {
    const t = buildTrace(
      [step({ seq: 1, type: "model_call", stepIndex: 0 })],
      [
        gw({ startedAt: "2026-11-01T00:00:00.000Z", httpStatus: 429 }),
        gw({ startedAt: "2026-11-01T00:00:05.000Z", httpStatus: 200, inputTokens: 900 }),
      ],
    );
    const [c] = t.calls;
    expect(c.status).toBe("ok");
    expect(c.retries).toBe(1);
    expect(c.hit429).toBe(true);
    expect(c.input).toBe(900);
    expect(t.metrics.rateLimited).toBe(1);
    expect(t.metrics.callErrors).toBe(0);
  });

  it("marks a step whose final attempt was refused as rate limited", () => {
    const t = buildTrace([step({ seq: 1, type: "model_call", stepIndex: 0 })], [gw({ httpStatus: 429 })]);
    expect(t.calls[0].status).toBe("rate_limited");
    expect(t.metrics.callErrors).toBe(1);
  });

  it("leaves calls unjoined when several share one gateway key", () => {
    const t = buildTrace(
      [
        step({ seq: 1, type: "model_call", stepIndex: 0 }),
        step({ seq: 2, type: "model_call", stepIndex: 0 }),
        step({ seq: 3, type: "model_call", stepIndex: 1 }),
      ],
      [gw({ stepIndex: 0, httpStatus: 429 }), gw({ stepIndex: 0, inputTokens: 5 }), gw({ stepIndex: 1, inputTokens: 7 })],
    );
    expect(t.calls.map((c) => [c.input, c.retries, c.hit429])).toEqual([
      [null, 0, false],
      [null, 0, false],
      [7, 0, false],
    ]);
  });

  it("does not join a gateway row from another session", () => {
    const t = buildTrace(
      [step({ seq: 1, type: "model_call", stepIndex: 0 })],
      [gw({ sessionId: "other", inputTokens: 100 })],
    );
    expect(t.calls[0].input).toBeNull();
    expect(t.calls[0].connectionId).toBeNull();
  });

  it("counts withheld results apart from tool errors", () => {
    const t = buildTrace(
      [
        step({ seq: 1, type: "model_call", stepIndex: 0 }),
        step({ seq: 2, type: "tool_call", isError: true, withheld: { tokens: 40000, limitTokens: 25000 } }),
        step({ seq: 3, type: "tool_call", isError: true }),
        step({ seq: 4, type: "tool_call" }),
      ],
      [],
    );
    expect(t.metrics.withheld).toBe(1);
    expect(t.metrics.toolErrors).toBe(1);
  });

  it("counts compactions requested and completed separately", () => {
    const t = buildTrace(
      [
        step({ seq: 1, type: "model_call", stepIndex: 0 }),
        step({ seq: 2, type: "compaction", compaction: { usageInputTokens: 250000, completed: true } }),
        step({ seq: 3, type: "compaction", compaction: { usageInputTokens: 250000 } }),
        step({ seq: 4, type: "model_call", stepIndex: 1 }),
      ],
      [],
    );
    expect(t.metrics.compactionsRequested).toBe(2);
    expect(t.metrics.compactionsDone).toBe(1);
    expect(t.compactions.map((c) => c.afterIndex)).toEqual([1, 1]);
  });

  it("returns null totals when no call reported a figure, not zero", () => {
    const t = buildTrace([step({ seq: 1, type: "model_call" })], []);
    expect(t.metrics.input).toBeNull();
    expect(t.metrics.cached).toBeNull();
    expect(t.metrics.peakContext).toBeNull();
    expect(t.metrics.activeMs).toBeNull();
  });

  it("sorts steps by seq before walking them", () => {
    const t = buildTrace(
      [
        step({ seq: 3, type: "tool_call", toolName: "late" }),
        step({ seq: 1, type: "model_call" }),
      ],
      [],
    );
    expect(t.calls[0].tools.map((x) => x.toolName)).toEqual(["late"]);
  });
});

describe("compositionParts", () => {
  it("merges instructions into the system prompt and scales to the real input", () => {
    const parts = compositionParts({ instructions: 100, system: 100, tools: 200, messages: 400, toolResults: 200 }, 2000);
    expect(parts).toEqual([
      { key: "system", label: "System prompt", tokens: 400 },
      { key: "tools", label: "Tool definitions", tokens: 400 },
      { key: "messages", label: "Conversation", tokens: 800 },
      { key: "toolResults", label: "Tool results", tokens: 400 },
    ]);
  });

  it("keeps the raw estimate when the real input is unknown", () => {
    expect(compositionParts({ messages: 10 }, null)?.find((p) => p.key === "messages")?.tokens).toBe(10);
  });

  it("is null for a missing or empty estimate", () => {
    expect(compositionParts(null, 100)).toBeNull();
    expect(compositionParts({ messages: 0, tools: "x" }, 100)).toBeNull();
  });
});

describe("repeatedCalls", () => {
  it("groups identical tool and input, two or more, most repeated first", () => {
    const out = repeatedCalls([
      { seq: 1, toolName: "read", inputHash: "a" },
      { seq: 2, toolName: "read", inputHash: "a" },
      { seq: 3, toolName: "bash", inputHash: "b" },
      { seq: 4, toolName: "bash", inputHash: "b" },
      { seq: 5, toolName: "bash", inputHash: "b" },
      { seq: 6, toolName: "grep", inputHash: "a" },
      { seq: 7, toolName: "read", inputHash: null },
      { seq: 8, toolName: "read", inputHash: null },
    ]);
    expect(out).toEqual([
      { toolName: "bash", count: 3, firstSeq: 3 },
      { toolName: "read", count: 2, firstSeq: 1 },
    ]);
  });
});

describe("groupTurns", () => {
  const call = (seq: number, turnId: string | null) =>
    ({ kind: "call", call: { seq, turnId } }) as Parameters<typeof groupTurns>[0][number];
  const compaction = (seq: number) =>
    ({ kind: "compaction", compaction: { seq } }) as Parameters<typeof groupTurns>[0][number];
  const shape = (turns: ReturnType<typeof groupTurns>) =>
    turns.map((t) => ({
      turn: t.turnId,
      cycles: t.cycles.map((c) => c.map((i) => (i.kind === "call" ? i.call.seq : `c${i.compaction.seq}`))),
    }));

  it("starts a new cycle at each compaction, in the turn of the call after it", () => {
    const turns = groupTurns([call(1, "a"), call(2, "a"), compaction(3), call(4, "b"), compaction(5), call(6, "b")]);
    expect(shape(turns)).toEqual([
      { turn: "a", cycles: [[1, 2]] },
      { turn: "b", cycles: [["c3", 4], ["c5", 6]] },
    ]);
  });

  it("puts a trailing compaction in the last turn", () => {
    expect(shape(groupTurns([call(1, "a"), compaction(2)]))).toEqual([{ turn: "a", cycles: [[1], ["c2"]] }]);
  });

  it("gives compactions with no calls a turn of their own", () => {
    expect(shape(groupTurns([compaction(1)]))).toEqual([{ turn: null, cycles: [["c1"]] }]);
  });
});
