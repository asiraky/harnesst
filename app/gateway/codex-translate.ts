/**
 * OpenAI chat-completions ⇄ Codex Responses API translation (issue #28, Phase 1) — the pure,
 * I/O-free core of harnesst's model gateway.
 *
 * Deployed agents and the assistant speak the OpenAI /chat/completions dialect (via
 * `@ai-sdk/openai-compatible`). The Codex ChatGPT backend speaks the /responses (Responses API)
 * dialect. This module bridges the two in both directions so the gateway route stays a thin
 * network shell:
 *
 *   - `buildResponsesPayload` renders a chat-completions request body as a /responses payload.
 *   - `SseParser` incrementally splits an upstream SSE byte/text stream into `{event,data}`.
 *   - `createChunkTranslator` turns each upstream Responses event into zero or more
 *     `chat.completion.chunk` objects (the streaming wire shape the client expects).
 *   - `aggregateChunks` folds a chunk list into one non-streaming `chat.completion` object.
 *
 * Semantics are ported from ChatMock (github.com/RayBytes/ChatMock) — the same request shaping
 * and event handling the Codex CLI relies on. Everything here is deterministic and pure so it is
 * exhaustively unit-testable with no network.
 */
import { CODEX_BASE_INSTRUCTIONS } from "./codex-base-instructions";
import type { ReasoningEffort } from "~/models/reasoning";

// ── Loose chat-completions input types (we accept anything OpenAI-ish) ─────────

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

export interface ChatCompletionsBody {
  model?: string;
  messages?: ChatMessage[];
  tools?: Array<{
    type?: string;
    function?: { name?: string; description?: string; parameters?: unknown };
  }>;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  /** OpenAI-compatible request spelling; translated to the Responses API reasoning object. */
  reasoning_effort?: ReasoningEffort;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

/**
 * Whether the client asked for a streamed (SSE) response.
 *
 * Follows the OpenAI convention: streaming happens ONLY when `stream: true` is explicitly set.
 * An absent `stream` field means a non-streaming request — the `@ai-sdk/openai-compatible`
 * provider's `doGenerate` omits `stream` (only `doStream` sends `stream: true`), so treating an
 * absent field as streaming would hand a non-streaming client an SSE body it then tries to
 * `JSON.parse`, yielding `Unexpected token 'd', "data: {..."` (a turnStep `AI_JSONParseError`).
 */
export function wantsStreaming(body: ChatCompletionsBody): boolean {
  return body.stream === true;
}

// ── Responses payload shaping ──────────────────────────────────────────────────

/** Convert a chat-message content value into Responses `input_text`/`input_image` parts. */
function toInputParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  if (Array.isArray(content)) {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" || p.type === "input_text") {
        parts.push({ type: "input_text", text: String(p.text ?? "") });
      } else if (p.type === "image_url") {
        // Chat form is { type:"image_url", image_url:{ url } } or a bare string; map best-effort.
        const imageUrl =
          typeof p.image_url === "object" && p.image_url !== null
            ? (p.image_url as { url?: unknown }).url
            : p.image_url;
        if (typeof imageUrl === "string") {
          parts.push({ type: "input_image", image_url: imageUrl });
        }
      }
    }
    return parts;
  }
  return [];
}

/** Flatten a chat-message content value to a plain string (tool outputs, assistant text). */
function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * Build the Codex /responses payload from an OpenAI chat-completions body.
 *
 * Client system/developer messages CANNOT go in `instructions` (the backend validates that field
 * against the Codex CLI system prompt), so they travel as leading `input` items of role "user".
 * The remaining messages map turn-for-turn: user → input_text/image parts, assistant text →
 * output_text plus a `function_call` item per tool call, tool results → `function_call_output`.
 */
export function buildResponsesPayload(
  body: ChatCompletionsBody,
  slug: string,
): Record<string, unknown> {
  const leading: Array<Record<string, unknown>> = [];
  const rest: Array<Record<string, unknown>> = [];

  for (const msg of body.messages ?? []) {
    if (msg.role === "system" || msg.role === "developer") {
      leading.push({
        type: "message",
        role: "user",
        content: toInputParts(msg.content),
      });
      continue;
    }
    if (msg.role === "user") {
      rest.push({
        type: "message",
        role: "user",
        content: toInputParts(msg.content),
      });
      continue;
    }
    if (msg.role === "assistant") {
      const text = toText(msg.content);
      if (text) {
        rest.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const call of msg.tool_calls ?? []) {
        rest.push({
          type: "function_call",
          call_id: call.id ?? "",
          name: call.function?.name ?? "",
          arguments: call.function?.arguments ?? "",
        });
      }
      continue;
    }
    if (msg.role === "tool") {
      rest.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: toText(msg.content),
      });
      continue;
    }
  }

  const tools = (body.tools ?? [])
    .filter((t) => t.type === "function" && t.function?.name)
    .map((t) => ({
      type: "function",
      name: t.function!.name,
      description: t.function!.description ?? "",
      parameters: t.function!.parameters ?? { type: "object", properties: {} },
      strict: false,
    }));

  const payload: Record<string, unknown> = {
    model: slug,
    instructions: CODEX_BASE_INSTRUCTIONS,
    input: [...leading, ...rest],
    store: false,
    stream: true,
    include: [],
  };
  if (tools.length > 0) payload.tools = tools;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) {
    payload.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.reasoning_effort !== undefined) {
    payload.reasoning = { effort: body.reasoning_effort };
  }
  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)) {
    payload.max_output_tokens = Math.max(1, Math.floor(maxOutputTokens));
  }
  return payload;
}

// ── Incremental SSE parser ─────────────────────────────────────────────────────

export interface SseRecord {
  event: string | null;
  data: string;
}

/**
 * A minimal incremental Server-Sent-Events parser. Feed it arbitrary string fragments (as they
 * arrive off the socket, split anywhere) via `push`; it returns whole `{event,data}` records once
 * their terminating blank line has been seen. Multi-line `data:` fields are joined with newlines,
 * per the SSE spec. `[DONE]` sentinels are passed through as data — callers decide what they mean.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseRecord[] {
    this.buffer += chunk;
    const records: SseRecord[] = [];
    let sep: number;
    // Events are separated by a blank line (\n\n). Handle \r\n too.
    while ((sep = this.indexOfBoundary()) !== -1) {
      const raw = this.buffer.slice(0, sep);
      // Advance past the boundary (either "\n\n" or "\r\n\r\n").
      this.buffer = this.buffer.slice(this.boundaryEnd(sep));
      const record = parseEventBlock(raw);
      if (record) records.push(record);
    }
    return records;
  }

  private indexOfBoundary(): number {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1) return crlf;
    if (crlf === -1) return lf;
    return Math.min(lf, crlf);
  }

  private boundaryEnd(start: number): number {
    return this.buffer.startsWith("\r\n\r\n", start) ? start + 4 : start + 2;
  }
}

function parseEventBlock(block: string): SseRecord | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (event === null && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

// ── Responses event → chat.completion.chunk translator ─────────────────────────

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Raised when the upstream Responses stream reports a failure (`response.failed` / `error`). */
export class CodexUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexUpstreamError";
  }
}

function mapUsage(
  usage: unknown,
):
  | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = Number(u.input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  const total = Number(u.total_tokens ?? input + output);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
  };
}

/**
 * A stateful translator: call `translate(record)` for each upstream SSE record in order; it
 * returns the `chat.completion.chunk`s to forward for that event (often zero, sometimes several).
 * State tracks per-call tool-call indices and whether any function call was seen (to pick the
 * final `finish_reason`). Throws `CodexUpstreamError` on an upstream failure event.
 */
export function createChunkTranslator(model: string) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCallIndex = new Map<string, number>();
  let nextToolIndex = 0;
  let sawFunctionCall = false;
  let emittedRole = false;

  function base(
    delta: Record<string, unknown>,
    finish_reason: string | null = null,
  ): ChatCompletionChunk {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason }],
    };
  }

  /** Prepend an assistant-role chunk the first time anything is emitted (OpenAI wire behavior). */
  function withRole(chunks: ChatCompletionChunk[]): ChatCompletionChunk[] {
    if (emittedRole || chunks.length === 0) return chunks;
    emittedRole = true;
    return [base({ role: "assistant" }), ...chunks];
  }

  return {
    translate(record: SseRecord): ChatCompletionChunk[] {
      if (record.data === "[DONE]") return [];
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(record.data) as Record<string, unknown>;
      } catch {
        return [];
      }
      const type = (record.event ?? event.type ?? "") as string;

      switch (type) {
        case "response.output_text.delta": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta) return [];
          return withRole([base({ content: delta })]);
        }
        case "response.output_item.added": {
          const item = event.item as Record<string, unknown> | undefined;
          if (!item || item.type !== "function_call") return [];
          const itemId = String(item.id ?? `fc_${nextToolIndex}`);
          const index = nextToolIndex++;
          toolCallIndex.set(itemId, index);
          sawFunctionCall = true;
          return withRole([
            base({
              tool_calls: [
                {
                  index,
                  id: String(item.call_id ?? item.id ?? ""),
                  type: "function",
                  function: { name: String(item.name ?? ""), arguments: "" },
                },
              ],
            }),
          ]);
        }
        case "response.function_call_arguments.delta": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta) return [];
          const itemId = String(event.item_id ?? "");
          const index =
            toolCallIndex.get(itemId) ?? Math.max(0, nextToolIndex - 1);
          return withRole([
            base({
              tool_calls: [{ index, function: { arguments: delta } }],
            }),
          ]);
        }
        case "response.completed": {
          const response = event.response as
            Record<string, unknown> | undefined;
          const usage = mapUsage(response?.usage);
          const chunk = base({}, sawFunctionCall ? "tool_calls" : "stop");
          if (usage) chunk.usage = usage;
          return [chunk];
        }
        case "response.failed":
        case "error": {
          const response = event.response as
            Record<string, unknown> | undefined;
          const err =
            (response?.error as { message?: string } | undefined)?.message ??
            (event.error as { message?: string } | undefined)?.message ??
            (typeof event.message === "string" ? event.message : "") ??
            "The Codex backend reported a failure.";
          throw new CodexUpstreamError(String(err));
        }
        default:
          return [];
      }
    },
  };
}

// ── Non-streaming aggregation ──────────────────────────────────────────────────

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Fold streamed chunks into a single non-streaming `chat.completion` (for `stream:false`). */
export function aggregateChunks(
  chunks: ChatCompletionChunk[],
  model: string,
): ChatCompletion {
  let content = "";
  let finish_reason: string | null = null;
  let usage: ChatCompletion["usage"];
  const id = chunks[0]?.id ?? `chatcmpl-${Math.random().toString(36).slice(2)}`;
  const created = chunks[0]?.created ?? Math.floor(Date.now() / 1000);
  const toolCalls = new Map<
    number,
    {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }
  >();

  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finish_reason = choice.finish_reason;
    const delta = choice.delta;
    if (typeof delta.content === "string") content += delta.content;
    const deltaCalls = delta.tool_calls as
      | Array<{
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>
      | undefined;
    for (const call of deltaCalls ?? []) {
      const existing = toolCalls.get(call.index) ?? {
        id: "",
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.function.name = call.function.name;
      if (call.function?.arguments) {
        existing.function.arguments += call.function.arguments;
      }
      toolCalls.set(call.index, existing);
    }
  }

  const orderedCalls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call);

  const completion: ChatCompletion = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || (orderedCalls.length > 0 ? null : ""),
          ...(orderedCalls.length > 0 ? { tool_calls: orderedCalls } : {}),
        },
        finish_reason: finish_reason ?? "stop",
      },
    ],
  };
  if (usage) completion.usage = usage;
  return completion;
}
