import { describe, expect, it } from "vitest";

import {
  parseCallIdentity,
  verifiedProjectId,
} from "~/gateway/call-identity";
import {
  buildGatewayCallRow,
  createCallObserver,
  parseUpstreamError,
  planTypeFromAccessToken,
  type CallContext,
} from "~/gateway/call-record";
import {
  createChunkTranslator,
  CodexUpstreamError,
  mapUsage,
  type SseRecord,
} from "~/gateway/codex-translate";
import { estimateContextComposition } from "~/gateway/context-composition";
import {
  parseCodexRateLimits,
  rateLimitsChanged,
} from "~/gateway/rate-limits";
import { estimateTokens } from "~/lib/token-estimate";

describe("parseCallIdentity", () => {
  it("decodes the labels an agent sends", () => {
    const identity = parseCallIdentity(
      new Headers({
        "x-harnesst-agent": "ledger%20bot",
        "x-harnesst-subagent": "qa%2Ffact-checker",
        "x-harnesst-session": "sess_1",
        "x-harnesst-turn": "turn_2",
        "x-harnesst-step": "7",
        "x-harnesst-project": "abcdefghijkl",
      }),
    );
    expect(identity).toEqual({
      agentName: "ledger bot",
      subagentPath: "qa/fact-checker",
      sessionId: "sess_1",
      turnId: "turn_2",
      stepIndex: 7,
      projectId: "abcdefghijkl",
    });
  });

  it("drops values that cannot be what they claim to be", () => {
    const identity = parseCallIdentity(
      new Headers({
        "x-harnesst-agent": "%0A%0D",
        "x-harnesst-step": "-1",
        "x-harnesst-project": "../other-org",
        "x-harnesst-turn": "%E0%A4%A",
      }),
    );
    expect(identity.agentName).toBeNull();
    expect(identity.stepIndex).toBeNull();
    expect(identity.projectId).toBeNull();
    // A malformed escape keeps the raw value rather than failing the call.
    expect(identity.turnId).toBe("%E0%A4%A");
  });

  it("strips control characters and caps label length", () => {
    const identity = parseCallIdentity(
      new Headers({
        "x-harnesst-agent": `bad%1Bname${"x".repeat(500)}`,
      }),
    );
    expect(identity.agentName).toMatch(/^badname/);
    expect(identity.agentName).toHaveLength(200);
  });

  it("returns all nulls when no labels are sent", () => {
    expect(Object.values(parseCallIdentity(new Headers()))).toEqual(
      Array(6).fill(null),
    );
  });
});

describe("verifiedProjectId", () => {
  it("keeps a project only when it belongs to the token's org", async () => {
    const lookup = async (orgId: string, projectId: string) =>
      orgId === "org_a" && projectId === "proj_a";
    expect(await verifiedProjectId("org_a", "proj_a", lookup)).toBe("proj_a");
    expect(await verifiedProjectId("org_b", "proj_a", lookup)).toBeNull();
    expect(await verifiedProjectId("org_a", null, lookup)).toBeNull();
  });

  it("drops the project when the lookup fails", async () => {
    expect(
      await verifiedProjectId("org_a", "proj_a", async () => {
        throw new Error("db down");
      }),
    ).toBeNull();
  });
});

describe("estimateContextComposition", () => {
  it("splits the context and attributes tool results to the tool that produced them", () => {
    const big = "r".repeat(4000);
    const composition = estimateContextComposition({
      model: "codex/abcdefghijkl/gpt-5.5",
      messages: [
        { role: "system", content: "s".repeat(400) },
        { role: "user", content: "u".repeat(40) },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "bash", arguments: "{}" },
            },
            {
              id: "call_2",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: big },
        { role: "tool", tool_call_id: "call_2", content: "abcd" },
        { role: "tool", tool_call_id: "call_x", content: "abcdefgh" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "bash", parameters: { type: "object" } },
        },
      ],
    });
    expect(composition.system).toBe(100);
    expect(composition.toolResultsByTool).toEqual({
      bash: 1000,
      read: 1,
      unknown: 2,
    });
    expect(composition.toolResults).toBe(1003);
    expect(composition.tools).toBeGreaterThan(0);
    expect(composition.total).toBe(
      composition.instructions +
        composition.system +
        composition.tools +
        composition.messages +
        composition.toolResults,
    );
  });

  it("keeps per-tool totals for tools named after object members", () => {
    const composition = estimateContextComposition({
      model: "codex/abcdefghijkl/gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "constructor", arguments: "" },
            },
            {
              id: "b",
              type: "function",
              function: { name: "__proto__", arguments: "" },
            },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "abcd" },
        { role: "tool", tool_call_id: "b", content: "abcdefgh" },
      ],
    });
    expect(JSON.parse(JSON.stringify(composition.toolResultsByTool))).toEqual(
      JSON.parse('{"constructor":1,"__proto__":2}'),
    );
  });

  it("counts text parts by their text and other parts by their encoded size", () => {
    const composition = estimateContextComposition({
      model: "codex/abcdefghijkl/gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "abcdefgh" },
            { type: "image_url", image_url: { url: "data:x" } },
          ],
        },
      ],
    });
    const imagePart = JSON.stringify({
      type: "image_url",
      image_url: { url: "data:x" },
    });
    expect(composition.messages).toBe(estimateTokens(`abcdefgh${imagePart}`));
  });
});

describe("mapUsage", () => {
  it("carries cached input and reasoning tokens in the OpenAI detail fields", () => {
    expect(
      mapUsage({
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: 120,
      }),
    ).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 12 },
    });
  });

  it("omits the detail fields the upstream did not report", () => {
    expect(mapUsage({ input_tokens: 3, output_tokens: 2 })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });
});

describe("parseCodexRateLimits", () => {
  it("reads both windows", () => {
    expect(
      parseCodexRateLimits(
        new Headers({
          "x-codex-primary-used-percent": "42.5",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": "1790000000",
          "x-codex-secondary-used-percent": "10",
          "x-codex-secondary-window-minutes": "10080",
        }),
      ),
    ).toEqual({
      primary: { usedPercent: 42.5, windowMinutes: 300, resetsAt: 1790000000 },
      secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: null },
    });
  });

  it("treats an absent or all-zero window as no window", () => {
    expect(
      parseCodexRateLimits(
        new Headers({
          "x-codex-primary-used-percent": "0",
          "x-codex-primary-window-minutes": "0",
          "x-codex-secondary-window-minutes": "60",
        }),
      ),
    ).toBeNull();
    expect(
      parseCodexRateLimits(
        new Headers({ "x-codex-secondary-used-percent": "5" }),
      ),
    ).toEqual({
      primary: null,
      secondary: { usedPercent: 5, windowMinutes: null, resetsAt: null },
    });
  });

  it("ignores values that are not numbers", () => {
    expect(
      parseCodexRateLimits(
        new Headers({
          "x-codex-primary-used-percent": "lots",
          "x-codex-secondary-used-percent": "3",
          "x-codex-secondary-window-minutes": "1.5",
        }),
      ),
    ).toEqual({
      primary: null,
      secondary: { usedPercent: 3, windowMinutes: null, resetsAt: null },
    });
  });
});

describe("rateLimitsChanged", () => {
  const base = {
    primary: { usedPercent: 40, windowMinutes: 300, resetsAt: 1_000_000 },
    secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: 2_000_000 },
  };

  it("samples the first observation and any change in usage or window", () => {
    expect(rateLimitsChanged(null, base)).toBe(true);
    expect(
      rateLimitsChanged(base, {
        ...base,
        primary: { ...base.primary, usedPercent: 41 },
      }),
    ).toBe(true);
    expect(rateLimitsChanged(base, { ...base, secondary: null })).toBe(true);
  });

  it("does not sample an unchanged value or a reset time that only jittered", () => {
    expect(rateLimitsChanged(base, structuredClone(base))).toBe(false);
    expect(
      rateLimitsChanged(base, {
        ...base,
        primary: { ...base.primary, resetsAt: 1_000_059 },
      }),
    ).toBe(false);
    expect(
      rateLimitsChanged(base, {
        ...base,
        primary: { ...base.primary, resetsAt: 1_000_060 },
      }),
    ).toBe(true);
  });
});

describe("parseUpstreamError", () => {
  it("reads the code and message from the error shapes Codex returns", () => {
    expect(
      parseUpstreamError(
        JSON.stringify({
          error: { type: "usage_limit_reached", message: "Limit hit" },
        }),
      ),
    ).toEqual({ code: "usage_limit_reached", message: "Limit hit" });
    expect(
      parseUpstreamError(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: "Too long",
          },
        }),
      ).code,
    ).toBe("context_length_exceeded");
    expect(parseUpstreamError(JSON.stringify({ detail: "Bad" }))).toEqual({
      code: null,
      message: "Bad",
    });
    expect(parseUpstreamError("gateway timeout")).toEqual({
      code: null,
      message: "gateway timeout",
    });
    expect(parseUpstreamError("  ")).toEqual({ code: null, message: null });
  });

  it("clips a long body", () => {
    expect(parseUpstreamError("x".repeat(5000)).message).toHaveLength(2001);
  });
});

describe("planTypeFromAccessToken", () => {
  const jwt = (claims: unknown) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

  it("reads the ChatGPT plan from the token's auth claims", () => {
    expect(
      planTypeFromAccessToken(
        jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
      ),
    ).toBe("pro");
  });

  it("returns null when the token carries no plan", () => {
    expect(planTypeFromAccessToken(jwt({ sub: "x" }))).toBeNull();
    expect(planTypeFromAccessToken("not-a-jwt")).toBeNull();
  });
});

describe("call log row from a translated stream", () => {
  const context: CallContext = {
    orgId: "org_1",
    tokenKind: "gateway",
    identity: {
      agentName: "ledger",
      subagentPath: null,
      sessionId: "sess_1",
      turnId: "turn_1",
      stepIndex: 2,
      projectId: "proj_1",
    },
    connectionId: "abcdefghijkl",
    accountId: "acct",
    planType: "pro",
    model: "codex/abcdefghijkl/gpt-5.5",
    reasoningEffort: "high",
    streamed: true,
    contextWindow: 272000,
    composition: estimateContextComposition({
      model: "codex/abcdefghijkl/gpt-5.5",
      messages: [],
    }),
  };

  function run(records: Array<{ event: string; data: unknown }>) {
    let now = 1000;
    const observer = createCallObserver(1000, () => now);
    const translator = createChunkTranslator(context.model);
    try {
      for (const r of records) {
        now += 100;
        const record: SseRecord = { event: r.event, data: JSON.stringify(r.data) };
        observer.observe(record);
        observer.emitted(translator.translate(record));
      }
    } catch (error) {
      observer.fail(error);
    }
    return buildGatewayCallRow(
      context,
      { startedAt: 1000, httpStatus: 200, upstreamRequestId: null },
      observer.outcome(),
      now + 50,
    );
  }

  it("records first token, finish, usage and the response id of a completed call", () => {
    const row = run([
      { event: "response.created", data: { response: { id: "resp_1" } } },
      { event: "response.output_text.delta", data: { delta: "Hi" } },
      { event: "response.output_text.delta", data: { delta: "!" } },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_1",
            usage: {
              input_tokens: 500,
              input_tokens_details: { cached_tokens: 400 },
              output_tokens: 30,
              output_tokens_details: { reasoning_tokens: 20 },
            },
          },
        },
      },
    ]);
    expect(row).toMatchObject({
      orgId: "org_1",
      projectId: "proj_1",
      agentName: "ledger",
      stepIndex: 2,
      ttftMs: 200,
      durationMs: 450,
      finishReason: "stop",
      upstreamRequestId: "resp_1",
      inputTokens: 500,
      cachedInputTokens: 400,
      outputTokens: 30,
      reasoningTokens: 20,
      errorCode: null,
    });
    expect(row.startedAt).toEqual(new Date(1000));
  });

  it("counts a tool call as the first token", () => {
    const row = run([
      {
        event: "response.output_item.added",
        data: {
          item: { type: "function_call", id: "fc", call_id: "c", name: "bash" },
        },
      },
      { event: "response.completed", data: { response: {} } },
    ]);
    expect(row.ttftMs).toBe(100);
    expect(row.finishReason).toBe("tool_calls");
  });

  it("records the code and message of an upstream failure", () => {
    const row = run([
      {
        event: "response.failed",
        data: {
          response: {
            error: { code: "context_length_exceeded", message: "Too long" },
            usage: { input_tokens: 9, output_tokens: 0 },
          },
        },
      },
    ]);
    expect(row).toMatchObject({
      errorCode: "context_length_exceeded",
      errorMessage: "Too long",
      inputTokens: 9,
      ttftMs: null,
    });
  });

  it("marks a stream that broke for other reasons", () => {
    const observer = createCallObserver(0);
    observer.fail(new Error("socket hang up"));
    expect(observer.outcome()).toMatchObject({
      errorCode: "stream_error",
      errorMessage: "socket hang up",
    });
    const upstream = createCallObserver(0);
    upstream.fail(new CodexUpstreamError("boom"));
    expect(upstream.outcome().errorCode).toBeNull();
  });
});
