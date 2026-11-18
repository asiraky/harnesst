import { describe, expect, it } from "vitest";

import type { TurnResult } from "~/agent/talk.server";
import { FIELD_CAP } from "~/observability/capture.server";
import {
  externalRunId,
  parentLookupFor,
  runTotals,
  subagentCallsOf,
  turnToSteps,
} from "~/observability/record.server";

function result(over: Partial<TurnResult> = {}): TurnResult {
  return {
    ok: true,
    sessionId: "sess_1",
    continuationToken: "tok_1",
    streamIndex: 0,
    reply: "all done",
    replyIsStructured: false,
    inputRequests: [],
    modelId: "m/x",
    turnId: "turn_1",
    steps: [],
    messages: [],
    error: null,
    ...over,
  };
}

describe("externalRunId", () => {
  it("scopes the per-session turn id with the session", () => {
    expect(externalRunId("sess_1", "turn_1")).toBe("sess_1:turn_1");
  });
});

describe("turnToSteps", () => {
  it("maps each step to a model_call, one tool_call per action, then a final message", () => {
    const steps = turnToSteps(
      result({
        steps: [
          {
            type: "step.completed",
            durationMs: 1200,
            tokensIn: 10,
            tokensOut: 4,
            isError: false,
            toolName: "bash",
            summary: "npm test",
            actions: [
              {
                toolName: "bash",
                summary: "npm test",
                exitCode: 0,
                isError: false,
                input: { command: "npm test" },
                output: { stdout: "ok", exitCode: 0 },
              },
              { toolName: "read_file", summary: "/x", isError: true },
            ],
          },
        ],
      }),
    );

    expect(steps.map((s) => [s.seq, s.type])).toEqual([
      [1, "model_call"],
      [2, "tool_call"],
      [3, "tool_call"],
      [4, "message"],
    ]);
    expect(steps[0]).toMatchObject({
      type: "model_call",
      model: "m/x",
      tokensInput: 10,
      tokensOutput: 4,
      durationMs: 1200,
      isError: false,
    });
    // tool_call now carries the FULL input/output, not just a summary.
    expect(steps[1]).toMatchObject({
      type: "tool_call",
      toolName: "bash",
      isError: false,
      data: {
        input: { command: "npm test" },
        output: { stdout: "ok", exitCode: 0 },
        summary: "npm test",
        exitCode: 0,
      },
    });
    expect(steps[2]).toMatchObject({ type: "tool_call", toolName: "read_file", isError: true });
    // The final assistant reply is a message step with an explicit role.
    expect(steps[3]).toMatchObject({
      type: "message",
      data: { role: "assistant", text: "all done" },
    });
  });

  it("emits a leading user message step when the triggering input is supplied", () => {
    const steps = turnToSteps(result(), { userMessage: "do the thing" });
    expect(steps[0]).toMatchObject({
      seq: 1,
      type: "message",
      data: { role: "user", text: "do the thing" },
    });
    // reply becomes the trailing assistant message
    expect(steps.at(-1)).toMatchObject({
      type: "message",
      data: { role: "assistant", text: "all done" },
    });
  });

  it("interleaves assistant messages between tool steps by afterStepIndex", () => {
    const steps = turnToSteps(
      result({
        reply: "before\n\nafter",
        messages: [
          { afterStepIndex: 0, text: "before" },
          { afterStepIndex: 1, text: "after" },
        ],
        steps: [
          {
            type: "step.completed",
            isError: false,
            actions: [{ toolName: "bash", isError: false }],
          },
        ],
      }),
    );
    expect(steps.map((s) => s.type)).toEqual([
      "message", // "before" (afterStepIndex 0)
      "model_call",
      "tool_call",
      "message", // "after" (afterStepIndex 1)
    ]);
    expect(steps[0]).toMatchObject({ data: { role: "assistant", text: "before" } });
    expect(steps[3]).toMatchObject({ data: { role: "assistant", text: "after" } });
  });

  it("carries failure detail on a failed model_call and omits the message step with no reply", () => {
    const steps = turnToSteps(
      result({
        ok: false,
        reply: null,
        error: "boom",
        steps: [
          {
            type: "step.failed",
            isError: true,
            code: "AI_APICallError",
            message: "fetch failed",
            details: "ENOTFOUND",
          },
        ],
      }),
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      type: "model_call",
      isError: true,
      data: { message: "fetch failed", code: "AI_APICallError", details: "ENOTFOUND" },
    });
  });

  it("caps a long reply at FIELD_CAP and marks it truncated", () => {
    const steps = turnToSteps(result({ reply: "x".repeat(FIELD_CAP + 5000) }));
    const message = steps.find((s) => s.type === "message");
    expect((message?.data?.text as string).length).toBe(FIELD_CAP);
    expect(message?.data?.truncated).toBe(true);
  });

  it("caps oversized tool input and flags truncation", () => {
    const steps = turnToSteps(
      result({
        reply: null,
        steps: [
          {
            type: "step.completed",
            isError: false,
            actions: [
              {
                toolName: "bash",
                isError: false,
                input: { command: "y".repeat(FIELD_CAP + 100) },
              },
            ],
          },
        ],
      }),
    );
    const tool = steps.find((s) => s.type === "tool_call");
    expect(((tool?.data?.input as { command: string }).command).length).toBe(FIELD_CAP);
    expect(tool?.data?.truncated).toBe(true);
  });
});

describe("turnToSteps usage, model and linkage (issue #417)", () => {
  it("carries cache, cost, the join key and the resolved model on each model call", () => {
    const steps = turnToSteps(
      result({
        modelId: "unconfigured",
        modelSource: "fallback",
        steps: [
          {
            type: "step.completed",
            tokensIn: 5000,
            tokensOut: 100,
            cacheReadTokens: 4000,
            cacheWriteTokens: 900,
            costUsd: 0.02,
            sequence: 1,
            stepIndex: 0,
            isError: false,
          },
          { type: "step.completed", tokensIn: 10, tokensOut: 1, stepIndex: 1, isError: false },
        ],
      }),
      { model: { modelId: "anthropic/abc/claude-x", contextWindowTokens: 200000 } },
    );
    const calls = steps.filter((s) => s.type === "model_call");
    expect(calls[0]).toMatchObject({
      model: "anthropic/abc/claude-x",
      contextWindow: 200000,
      tokensInput: 5000,
      tokensOutput: 100,
      tokensCacheRead: 4000,
      tokensCacheWrite: 900,
      costUsd: 0.02,
      eveSessionId: "sess_1",
      turnId: "turn_1",
      stepIndex: 0,
    });
    // A provider that reports no cache or cost leaves them unset rather than zero.
    expect(calls[1].tokensCacheRead).toBeUndefined();
    expect(calls[1].costUsd).toBeUndefined();
    expect(calls[1].stepIndex).toBe(1);
  });

  it("never records the dynamic fallback id as the model", () => {
    const steps = turnToSteps(
      result({
        modelId: "unconfigured",
        modelSource: "fallback",
        steps: [{ type: "step.completed", isError: false }],
      }),
    );
    expect(steps[0].model).toBeUndefined();
  });

  it("places a compaction step before the model call it made room for", () => {
    const steps = turnToSteps(
      result({
        reply: null,
        steps: [
          { type: "step.completed", isError: false },
          { type: "step.completed", isError: false },
        ],
        messages: [{ afterStepIndex: 1, text: "halfway" }],
        compactions: [
          {
            afterStepIndex: 1,
            at: "2026-11-18T00:00:00.000Z",
            sequence: 2,
            usageInputTokens: 190000,
            modelId: "m/compact",
            completed: true,
          },
        ],
      }),
    );
    expect(steps.map((s) => s.type)).toEqual([
      "model_call",
      "message",
      "compaction",
      "model_call",
    ]);
    expect(steps[2]).toMatchObject({
      model: "m/compact",
      startedAt: "2026-11-18T00:00:00.000Z",
      turnId: "turn_1",
      data: { usageInputTokens: 190000, sequence: 2, completed: true },
    });
  });

  it("measures a tool result before capping it for storage", () => {
    const big = "é".repeat(FIELD_CAP * 2);
    const steps = turnToSteps(
      result({
        steps: [
          {
            type: "step.completed",
            isError: false,
            actions: [
              { toolName: "bash", isError: false, callId: "c1", output: big },
              { toolName: "read", isError: false, output: { text: "ok" } },
              { toolName: "noop", isError: false },
            ],
          },
        ],
      }),
    );
    const [capped, small, none] = steps.filter((s) => s.type === "tool_call");
    // Two UTF-8 bytes per character, four bytes per estimated token.
    expect(capped).toMatchObject({
      callId: "c1",
      resultBytes: FIELD_CAP * 4,
      resultTokens: FIELD_CAP,
      resultCapped: true,
    });
    expect((capped.data?.output as string).length).toBe(FIELD_CAP);
    expect(small).toMatchObject({
      resultBytes: 13,
      resultTokens: 4,
      resultCapped: false,
    });
    expect(none.resultBytes).toBeUndefined();
    expect(none.resultCapped).toBeUndefined();
  });

  it("links a subagent child session's steps to the subagent and its parent call", () => {
    const steps = turnToSteps(
      result({
        reply: null,
        subagent: {
          name: "researcher",
          parentCallId: "call_9",
          parentSessionId: "sess_parent",
          parentTurnId: "turn_0",
        },
        steps: [
          {
            type: "step.completed",
            isError: false,
            actions: [{ toolName: "web", isError: false }],
          },
        ],
      }),
    );
    expect(steps.map((s) => [s.type, s.subagentName, s.parentCallId])).toEqual([
      ["model_call", "researcher", "call_9"],
      ["tool_call", "researcher", "call_9"],
    ]);
  });

  it("records on a parent's tool call the child session its subagent ran in", () => {
    const parent = result({
      reply: null,
      steps: [
        {
          type: "step.completed",
          isError: false,
          actions: [
            {
              toolName: "researcher",
              callId: "c1",
              isError: false,
              subagentCall: { callId: "c1", name: "researcher", childSessionId: "wrun_child" },
            },
            { toolName: "bash", callId: "c2", isError: false },
          ],
        },
        {
          type: "step.completed",
          isError: false,
          actions: [
            {
              toolName: "remote",
              callId: "c3",
              isError: false,
              subagentCall: { callId: "c3", name: null, childSessionId: "wrun_remote" },
            },
            {
              toolName: "ask_writer",
              callId: "c4",
              isError: false,
              subagentCall: { callId: "c4", name: "writer", childSessionId: null },
            },
          ],
        },
      ],
    });
    const calls = turnToSteps(parent).filter((s) => s.type === "tool_call");
    expect(calls.map((s) => [s.callId, s.childSessionId, s.data?.subagentName])).toEqual([
      ["c1", "wrun_child", "researcher"],
      ["c2", undefined, undefined],
      ["c3", "wrun_remote", undefined],
      ["c4", undefined, "writer"],
    ]);
    // The parent's own steps are not a subagent's.
    expect(calls[0].subagentName).toBeUndefined();
    expect(subagentCallsOf(parent).map((c) => c.callId)).toEqual(["c1", "c3", "c4"]);
  });

  it("leaves a top-level session's steps unlinked", () => {
    const steps = turnToSteps(
      result({ steps: [{ type: "step.completed", isError: false }] }),
    );
    expect(steps[0].subagentName).toBeUndefined();
    expect(steps[0].parentCallId).toBeUndefined();
  });
});

describe("runTotals", () => {
  it("sums usage, counts compactions and takes the largest context", () => {
    expect(
      runTotals(
        result({
          steps: [
            { type: "s", tokensIn: 1000, tokensOut: 10, cacheReadTokens: 800, costUsd: 0.01, isError: false },
            { type: "s", tokensIn: 3000, tokensOut: 20, cacheReadTokens: 2500, costUsd: 0.02, isError: false },
          ],
          compactions: [
            {
              afterStepIndex: 1,
              at: "2026-11-18T00:00:00.000Z",
              sequence: 1,
              usageInputTokens: 2500,
              modelId: null,
              completed: true,
            },
          ],
        }),
      ),
    ).toEqual({
      tokensInput: 4000,
      tokensOutput: 30,
      tokensCachedInput: 3300,
      costUsd: 0.03,
      compactionCount: 1,
      peakContextTokens: 3000,
    });
  });

  it("takes the peak from model calls, not eve's fractional compaction estimate", () => {
    // The lost prod run: eve's compaction.requested reported usageInputTokens 288661.5 (its own
    // estimate, above the 272k window), which became peak_context_tokens and failed the insert.
    const totals = runTotals(
      result({
        steps: [
          { type: "s", tokensIn: 268_900, isError: false },
          { type: "s", tokensIn: 141_200, isError: false },
        ],
        compactions: [
          {
            afterStepIndex: 1,
            at: "2026-11-18T00:00:00.000Z",
            sequence: 1,
            usageInputTokens: 288661.5,
            modelId: null,
            completed: true,
          },
          {
            afterStepIndex: 2,
            at: "2026-11-18T00:01:00.000Z",
            sequence: 2,
            usageInputTokens: 150000,
            modelId: null,
            completed: false,
          },
        ],
      }),
    );
    expect(totals.peakContextTokens).toBe(268_900);
    // The second pass never completed: it stays on its step but is not counted.
    expect(totals.compactionCount).toBe(1);
  });

  it("has no peak when only a compaction reported a size", () => {
    const totals = runTotals(
      result({
        steps: [{ type: "s", isError: false }],
        compactions: [
          { afterStepIndex: 1, at: "2026-11-18T00:00:00.000Z", sequence: 1, usageInputTokens: 1000.25, modelId: null, completed: true },
        ],
      }),
    );
    expect(totals.peakContextTokens).toBeUndefined();
  });

  it("leaves cost and cache unknown when no step reported them", () => {
    expect(
      runTotals(
        result({
          steps: [{ type: "s", tokensIn: 10, tokensOut: 2, isError: false }],
          compactions: [],
        }),
      ),
    ).toEqual({ tokensInput: 10, tokensOutput: 2, compactionCount: 0, peakContextTokens: 10 });
  });

  it("reports nothing for a run with no usage at all", () => {
    expect(runTotals(result({ steps: [{ type: "s", isError: false }] }))).toEqual({});
  });
});

describe("parentLookupFor", () => {
  const parent = {
    name: null,
    parentCallId: "c1",
    parentSessionId: "wrun_parent",
    parentTurnId: "turn_2",
  };

  it("reads the name off the parent call when the child knows its parent but not the name", () => {
    expect(parentLookupFor(result({ subagent: parent }), "subagent")).toEqual({
      kind: "name",
      parentSessionId: "wrun_parent",
      parentCallId: "c1",
    });
  });

  it("looks for the parent call by session for a subagent turn that knows no parent", () => {
    expect(parentLookupFor(result(), "subagent")).toEqual({ kind: "child" });
  });

  it("looks for the parent call by session when the child knows its parent call but not its session", () => {
    expect(parentLookupFor(result({ subagent: { ...parent, parentSessionId: null } }), "subagent")).toEqual({
      kind: "child",
    });
  });

  it("looks nothing up for a linked child or a top-level turn", () => {
    expect(parentLookupFor(result({ subagent: { ...parent, name: "writer" } }), "subagent")).toBeNull();
    expect(parentLookupFor(result(), "cron")).toBeNull();
  });
});
