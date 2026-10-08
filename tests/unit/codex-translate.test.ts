/**
 * OpenAI chat-completions ⇄ Codex Responses translation (issue #28). Pins the payload shaping
 * (system → leading user input item, tools, tool messages, assistant tool_calls), the incremental
 * SSE parser (records split across arbitrary buffer boundaries), the event→chunk translator
 * (text deltas, the function-call flow, usage + finish_reason), and non-streaming aggregation.
 */
import { describe, expect, it } from "vitest";

import { CODEX_BASE_INSTRUCTIONS } from "~/gateway/codex-base-instructions";
import {
  aggregateChunks,
  buildResponsesPayload,
  CodexUpstreamError,
  createChunkTranslator,
  SseParser,
  wantsStreaming,
  type ChatCompletionChunk,
} from "~/gateway/codex-translate";

describe("wantsStreaming", () => {
  it("streams only when stream:true is explicitly set", () => {
    expect(wantsStreaming({ stream: true })).toBe(true);
  });

  it("treats an absent stream field as non-streaming (OpenAI default)", () => {
    // The `@ai-sdk/openai-compatible` provider's non-streaming doGenerate omits `stream`;
    // returning SSE here is what caused the turnStep AI_JSONParseError.
    expect(wantsStreaming({})).toBe(false);
  });

  it("treats stream:false as non-streaming", () => {
    expect(wantsStreaming({ stream: false })).toBe(false);
  });
});

describe("buildResponsesPayload file parts", () => {
  const userContent = (payload: Record<string, unknown>) =>
    ((payload.input as Array<Record<string, unknown>>).at(-1) as { content: unknown[] }).content;

  it("maps a chat-completions file part with inline data to input_file", () => {
    const payload = buildResponsesPayload(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read this" },
              {
                type: "file",
                file: { filename: "invoice.pdf", file_data: "data:application/pdf;base64,AAAA" },
              },
            ],
          },
        ],
      },
      "gpt-5.5",
    );
    expect(userContent(payload)).toEqual([
      { type: "input_text", text: "read this" },
      { type: "input_file", filename: "invoice.pdf", file_data: "data:application/pdf;base64,AAAA" },
    ]);
  });

  it("falls back to a default filename and forwards file_id references", () => {
    const payload = buildResponsesPayload(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "file", file: { file_data: "data:application/pdf;base64,AAAA" } },
              { type: "file", file: { file_id: "file-123" } },
            ],
          },
        ],
      },
      "gpt-5.5",
    );
    expect(userContent(payload)).toEqual([
      { type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,AAAA" },
      { type: "input_file", file_id: "file-123" },
    ]);
  });

  it("reports parts it cannot translate instead of dropping them silently", () => {
    const dropped: string[] = [];
    const payload = buildResponsesPayload(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "input_audio", input_audio: {} },
              { type: "file", file: {} },
              { type: "text", text: "hi" },
            ],
          },
        ],
      },
      "gpt-5.5",
      { onDropped: (t) => dropped.push(t) },
    );
    expect(dropped).toEqual(["input_audio", "file"]);
    expect(userContent(payload)).toEqual([{ type: "input_text", text: "hi" }]);
  });
});

describe("buildResponsesPayload", () => {
  it("sends Codex base instructions and moves system prompts to a leading user input item", () => {
    const payload = buildResponsesPayload(
      {
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hello" },
        ],
      },
      "gpt-5.5",
    );
    expect(payload.model).toBe("gpt-5.5");
    expect(payload.instructions).toBe(CODEX_BASE_INSTRUCTIONS);
    expect(payload.store).toBe(false);
    const input = payload.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "be terse" }],
    });
    expect(input[1]).toMatchObject({ role: "user" });
  });

  it("maps tools, tool_choice, and parallel_tool_calls", () => {
    const payload = buildResponsesPayload(
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: false,
      },
      "gpt-5.5",
    );
    expect(payload.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
        strict: false,
      },
    ]);
    expect(payload.tool_choice).toBe("auto");
    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("maps chat reasoning_effort to the Responses API reasoning object", () => {
    const payload = buildResponsesPayload(
      {
        messages: [{ role: "user", content: "think carefully" }],
        reasoning_effort: "high",
      },
      "gpt-5.5",
    );

    expect(payload.reasoning).toEqual({ effort: "high" });
  });

  it("maps assistant tool_calls to function_call items and tool results to function_call_output", () => {
    const input = buildResponsesPayload(
      {
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "let me check",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "sunny" },
        ],
      },
      "gpt-5.5",
    ).input as Array<Record<string, unknown>>;

    expect(input).toContainEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "let me check" }],
    });
    expect(input).toContainEqual({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"NYC"}',
    });
    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "sunny",
    });
  });

  it("maps image_url user parts to input_image best-effort", () => {
    const input = buildResponsesPayload(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image_url", image_url: { url: "https://x/y.png" } },
            ],
          },
        ],
      },
      "gpt-5.5",
    ).input as Array<Record<string, unknown>>;
    expect(input[0].content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: "https://x/y.png" },
    ]);
  });
});

describe("SseParser", () => {
  it("emits records only when a full event has arrived, across arbitrary splits", () => {
    const parser = new SseParser();
    expect(parser.push("event: response.output_text.delta\n")).toEqual([]);
    expect(parser.push('data: {"delta":"He')).toEqual([]);
    const out = parser.push('llo"}\n\n');
    expect(out).toEqual([
      { event: "response.output_text.delta", data: '{"delta":"Hello"}' },
    ]);
  });

  it("parses multiple events in one push and ignores comments", () => {
    const parser = new SseParser();
    const out = parser.push(": keep-alive\n\ndata: a\n\ndata: b\n\n");
    expect(out).toEqual([
      { event: null, data: "a" },
      { event: null, data: "b" },
    ]);
  });

  it("joins multi-line data fields", () => {
    const parser = new SseParser();
    expect(parser.push("data: line1\ndata: line2\n\n")).toEqual([
      { event: null, data: "line1\nline2" },
    ]);
  });
});

function events(records: Array<{ event: string; data: unknown }>) {
  return records.map((r) => ({ event: r.event, data: JSON.stringify(r.data) }));
}

describe("createChunkTranslator", () => {
  it("translates text deltas, prefixing a role chunk once", () => {
    const t = createChunkTranslator("codex/c/gpt-5.5");
    const [role, first] = t.translate({
      event: "response.output_text.delta",
      data: JSON.stringify({ delta: "Hi" }),
    });
    expect(role.choices[0].delta).toEqual({ role: "assistant" });
    expect(first.choices[0].delta).toEqual({ content: "Hi" });
    // No second role chunk on the next delta.
    const next = t.translate({
      event: "response.output_text.delta",
      data: JSON.stringify({ delta: " there" }),
    });
    expect(next).toHaveLength(1);
    expect(next[0].choices[0].delta).toEqual({ content: " there" });
  });

  it("emits a tool_calls flow and finishes with tool_calls + mapped usage", () => {
    const t = createChunkTranslator("codex/c/gpt-5.5");
    const chunks: ChatCompletionChunk[] = [];
    for (const record of events([
      {
        event: "response.output_item.added",
        data: {
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "get_weather",
          },
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: { item_id: "fc_1", delta: '{"city":' },
      },
      {
        event: "response.function_call_arguments.delta",
        data: { item_id: "fc_1", delta: '"NYC"}' },
      },
      {
        event: "response.completed",
        data: {
          response: {
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      },
    ])) {
      for (const c of t.translate(record)) chunks.push(c);
    }

    // First tool chunk carries the role prefix + the tool_call header.
    const toolHeader = chunks.find((c) => {
      const calls = c.choices[0].delta.tool_calls as
        Array<{ id?: string }> | undefined;
      return calls?.[0]?.id === "call_1";
    });
    expect(toolHeader?.choices[0].delta).toMatchObject({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        },
      ],
    });
    const final = chunks[chunks.length - 1];
    expect(final.choices[0].finish_reason).toBe("tool_calls");
    expect(final.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("finishes with stop when no function call was seen", () => {
    const t = createChunkTranslator("codex/c/gpt-5.5");
    t.translate({
      event: "response.output_text.delta",
      data: JSON.stringify({ delta: "ok" }),
    });
    const [final] = t.translate({
      event: "response.completed",
      data: JSON.stringify({ response: {} }),
    });
    expect(final.choices[0].finish_reason).toBe("stop");
  });

  it("throws CodexUpstreamError on a failure event", () => {
    const t = createChunkTranslator("codex/c/gpt-5.5");
    expect(() =>
      t.translate({
        event: "response.failed",
        data: JSON.stringify({ response: { error: { message: "boom" } } }),
      }),
    ).toThrow(CodexUpstreamError);
  });

  it("ignores [DONE] and unknown events", () => {
    const t = createChunkTranslator("codex/c/gpt-5.5");
    expect(t.translate({ event: null, data: "[DONE]" })).toEqual([]);
    expect(
      t.translate({ event: "response.created", data: JSON.stringify({}) }),
    ).toEqual([]);
  });
});

describe("aggregateChunks", () => {
  it("folds text + tool_calls into one non-streaming completion", () => {
    const t = createChunkTranslator("codex/c/gpt-5.5");
    const chunks: ChatCompletionChunk[] = [];
    for (const record of events([
      { event: "response.output_text.delta", data: { delta: "Hel" } },
      { event: "response.output_text.delta", data: { delta: "lo" } },
      {
        event: "response.completed",
        data: {
          response: {
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          },
        },
      },
    ])) {
      for (const c of t.translate(record)) chunks.push(c);
    }
    const completion = aggregateChunks(chunks, "codex/c/gpt-5.5");
    expect(completion.object).toBe("chat.completion");
    expect(completion.choices[0].message.content).toBe("Hello");
    expect(completion.choices[0].finish_reason).toBe("stop");
    expect(completion.usage?.total_tokens).toBe(3);
  });

  it("aggregates a tool call with concatenated arguments and null content", () => {
    const t = createChunkTranslator("codex/c/gpt-5.5");
    const chunks: ChatCompletionChunk[] = [];
    for (const record of events([
      {
        event: "response.output_item.added",
        data: {
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "f",
          },
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: { item_id: "fc_1", delta: '{"a":' },
      },
      {
        event: "response.function_call_arguments.delta",
        data: { item_id: "fc_1", delta: "1}" },
      },
      { event: "response.completed", data: { response: {} } },
    ])) {
      for (const c of t.translate(record)) chunks.push(c);
    }
    const completion = aggregateChunks(chunks, "codex/c/gpt-5.5");
    expect(completion.choices[0].message.content).toBeNull();
    expect(completion.choices[0].message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "f", arguments: '{"a":1}' },
      },
    ]);
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
  });
});
