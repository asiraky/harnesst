/**
 * What filled the context of one gateway call, estimated from the request body (issue #416).
 *
 * Sizes use the 4-bytes-per-token rule (`~/lib/token-estimate`), the same scale as the gateway's
 * tool-result limit, so the parts add up to roughly what the provider counts as input. Images and
 * files are counted by their encoded bytes: a crude figure, but it still shows an attachment that
 * dominates a call.
 */
import type { ChatCompletionsBody } from "./codex-translate";
import { CODEX_BASE_INSTRUCTIONS } from "./codex-base-instructions";
import { estimateTokens } from "~/lib/token-estimate";

export interface ContextComposition {
  /** The Codex base instructions the gateway adds to every call. */
  instructions: number;
  /** The caller's system and developer messages (the agent's own instructions). */
  system: number;
  /** Tool definitions: names, descriptions and parameter schemas. */
  tools: number;
  /** User and assistant messages, including the arguments of the assistant's tool calls. */
  messages: number;
  /** Every tool result in the conversation. */
  toolResults: number;
  /** Tool results by the name of the tool that produced them. */
  toolResultsByTool: Record<string, number>;
  total: number;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        // Non-text parts (images, files) are counted by their serialized size.
        return JSON.stringify(p);
      })
      .join("");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

export function estimateContextComposition(
  body: ChatCompletionsBody,
): ContextComposition {
  let system = 0;
  let messages = 0;
  let toolResults = 0;
  // A Map, not an object: a tool may be named `constructor` or `__proto__`.
  const byTool = new Map<string, number>();
  const toolNameByCallId = new Map<string, string>();

  for (const msg of body.messages ?? []) {
    if (!msg || typeof msg !== "object") continue;
    const tokens = estimateTokens(contentText(msg.content));
    if (msg.role === "system" || msg.role === "developer") {
      system += tokens;
    } else if (msg.role === "tool") {
      toolResults += tokens;
      const name =
        (msg.tool_call_id && toolNameByCallId.get(msg.tool_call_id)) ||
        "unknown";
      byTool.set(name, (byTool.get(name) ?? 0) + tokens);
    } else {
      let callTokens = 0;
      for (const call of msg.tool_calls ?? []) {
        const name = call.function?.name ?? "";
        if (call.id && name) toolNameByCallId.set(call.id, name);
        callTokens += estimateTokens(name + (call.function?.arguments ?? ""));
      }
      messages += tokens + callTokens;
    }
  }

  const tools = (body.tools ?? []).reduce(
    (sum, tool) => sum + estimateTokens(JSON.stringify(tool.function ?? tool)),
    0,
  );
  const instructions = estimateTokens(CODEX_BASE_INSTRUCTIONS);
  return {
    instructions,
    system,
    tools,
    messages,
    toolResults,
    toolResultsByTool: Object.fromEntries(byTool),
    total: instructions + system + tools + messages + toolResults,
  };
}
