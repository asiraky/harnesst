/**
 * Gateway tool-result size limit: oversized tool results reach Codex as an error with none of the
 * output, and run transcripts mark the matching steps as errors.
 */
import { describe, expect, it } from "vitest";

import { buildResponsesPayload } from "~/gateway/codex-translate";
import {
  checkToolResult,
  estimateTokens,
  toolResultLimitTokens,
  type WithheldToolResult,
} from "~/gateway/tool-result-limit";
import { markWithheldSteps, toolCallIds } from "~/observability/withheld-steps";

const call = { callId: "call_1", toolName: "spreadsheets_values_get" };

describe("estimateTokens", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    // Each "é" is 2 bytes.
    expect(estimateTokens("éé")).toBe(1);
  });
});

describe("toolResultLimitTokens", () => {
  it("is 10% of the context window", () => {
    expect(toolResultLimitTokens(272_000)).toBe(27_200);
  });

  it("falls back when the window is unknown or nonsense", () => {
    const fallback = toolResultLimitTokens(undefined);
    expect(fallback).toBeGreaterThan(0);
    expect(toolResultLimitTokens(null)).toBe(fallback);
    expect(toolResultLimitTokens(0)).toBe(fallback);
    expect(toolResultLimitTokens(-5)).toBe(fallback);
    expect(toolResultLimitTokens(Number.NaN)).toBe(fallback);
  });
});

describe("checkToolResult", () => {
  it("passes a result at the limit", () => {
    expect(checkToolResult("x".repeat(400), 100, call)).toBeNull();
  });

  it("withholds a result over the limit, with none of its content in the message", () => {
    const output = `{"status":200,"body":"SECRET-ROW${"x".repeat(1000)}"}`;
    const result = checkToolResult(output, 100, call);
    expect(result).not.toBeNull();
    expect(result!.withheld).toEqual({
      ...call,
      tokens: estimateTokens(output),
      limitTokens: 100,
      status: 200,
    });
    expect(result!.message).not.toContain("SECRET-ROW");
    expect(result!.message).toContain("spreadsheets_values_get");
    expect(result!.message).toContain("succeeded (HTTP 200)");
  });

  it("reports a failing status as a failure, not a success", () => {
    const result = checkToolResult(`{"status": 500, "body":"${"x".repeat(1000)}"}`, 100, call);
    expect(result!.withheld.status).toBe(500);
    expect(result!.message).toContain("returned HTTP 500");
    expect(result!.message).not.toContain("succeeded");
  });

  it("claims no status when the output doesn't lead with one", () => {
    const result = checkToolResult(`plain text ${"x".repeat(1000)} {"status":200}`, 100, call);
    expect(result!.withheld.status).toBeNull();
    expect(result!.message).not.toContain("HTTP");
  });
});

describe("buildResponsesPayload with a tool-result limit", () => {
  const body = (output: string) => ({
    messages: [
      { role: "user", content: "report" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_big", type: "function", function: { name: "read_sheet", arguments: "{}" } },
          { id: "call_small", type: "function", function: { name: "append_row", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_big", content: output },
      { role: "tool", tool_call_id: "call_small", content: "ok" },
    ],
  });

  const outputs = (payload: Record<string, unknown>) =>
    (payload.input as Array<Record<string, unknown>>)
      .filter((i) => i.type === "function_call_output")
      .map((i) => [i.call_id, i.output]);

  it("replaces only the oversized result and names its tool", () => {
    const withheld: WithheldToolResult[] = [];
    const big = "y".repeat(4000);
    const payload = buildResponsesPayload(body(big), "gpt-5.5", {
      toolResultLimitTokens: 100,
      onWithheld: (w) => withheld.push(w),
    });
    const [[bigId, bigOut], [smallId, smallOut]] = outputs(payload);
    expect(bigId).toBe("call_big");
    expect(bigOut).not.toContain("yyyy");
    expect(bigOut).toContain("read_sheet");
    expect([smallId, smallOut]).toEqual(["call_small", "ok"]);
    expect(withheld).toEqual([
      { callId: "call_big", toolName: "read_sheet", tokens: 1000, limitTokens: 100, status: null },
    ]);
  });

  it("produces identical bytes on every call, so the prompt-cache prefix holds", () => {
    const big = "y".repeat(4000);
    const a = buildResponsesPayload(body(big), "gpt-5.5", { toolResultLimitTokens: 100 });
    const b = buildResponsesPayload(body(big), "gpt-5.5", { toolResultLimitTokens: 100 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("forwards results untouched when no limit is set", () => {
    const big = "y".repeat(4000);
    const payload = buildResponsesPayload(body(big), "gpt-5.5");
    expect(outputs(payload)[0]).toEqual(["call_big", big]);
  });
});

describe("markWithheldSteps", () => {
  const steps = [
    { type: "model_call", isError: false, data: null },
    { type: "tool_call", callId: "call_big", isError: false, data: { output: "..." } },
    { type: "tool_call", callId: "call_small", isError: false, data: {} },
    { type: "tool_call", isError: false, data: {} },
  ];

  it("collects the tool steps' call ids", () => {
    expect(toolCallIds(steps)).toEqual(["call_big", "call_small"]);
  });

  it("marks only withheld tool steps as errors, keeping their data", () => {
    const marked = markWithheldSteps(
      steps,
      new Map([["call_big", { tokens: 220_000, limitTokens: 27_200 }]]),
    );
    expect(marked[1]).toEqual({
      type: "tool_call",
      callId: "call_big",
      isError: true,
      data: { output: "...", withheld: { tokens: 220_000, limitTokens: 27_200 } },
    });
    expect([marked[0], marked[2], marked[3]]).toEqual([steps[0], steps[2], steps[3]]);
  });

  it("marks a step with no data", () => {
    const [marked] = markWithheldSteps(
      [{ type: "tool_call", callId: "c", isError: false } as {
        type: string;
        callId: string;
        isError: boolean;
        data?: Record<string, unknown>;
      }],
      new Map([["c", { tokens: 5, limitTokens: 1 }]]),
    );
    expect(marked.data).toEqual({ withheld: { tokens: 5, limitTokens: 1 } });
  });
});
