/**
 * harnesst model gateway — `POST /api/gateway/v1/chat/completions` (issue #28, Phase 1).
 *
 * A deployed agent (or the built-in assistant) set to a `codex/<connectionId>/<slug>` model points
 * its `@ai-sdk/openai-compatible` provider at THIS route, authenticated by an `HARNESST_MODEL_GATEWAY_TOKEN`
 * (an `edng_` org token). The gateway:
 *   1. verifies the token → org id (nothing else is trusted from the client),
 *   2. parses the model id and org-checks the named Codex connection,
 *   3. gets a fresh access token (auto-refreshing, single-flighted),
 *   4. translates the OpenAI chat-completions body to a Codex /responses payload, forwards it, and
 *      streams the translated `chat.completion.chunk`s back (or aggregates for `stream:false`).
 *
 * OpenRouter model ids are NOT served here — they keep flowing straight to openrouter.ai from the
 * agent. Errors mirror the OpenAI shape (`{ error: { message } }`) so the client surfaces them.
 * The route is deliberately thin; all translation logic lives in `~/gateway/codex-translate`.
 */
import type { ActionFunctionArgs } from "react-router";

import { codexApiBase, InvalidGrantError } from "~/connections/codex.server";
import { parseCodexModelId } from "~/models/codex-catalog";
import {
  getConnectionForGateway,
  getFreshAccessToken,
} from "~/models/provider-connections.server";
import {
  aggregateChunks,
  buildResponsesPayload,
  CodexUpstreamError,
  createChunkTranslator,
  SseParser,
  wantsStreaming,
  type ChatCompletionsBody,
} from "~/gateway/codex-translate";
import { bearerToken, verifyGatewayToken } from "~/gateway/token.server";
import {
  beginEvalModelCall,
  EVAL_MAX_OUTPUT_TOKENS_PER_CALL,
  EvalGrantError,
  finishEvalModelCall,
} from "~/gateway/eval-grant.server";
import { verifyEvalGatewayToken } from "~/gateway/eval-token.server";

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST")
    return errorResponse("Method not allowed.", 405);

  const token = bearerToken(request);
  let orgId = token ? verifyGatewayToken(token) : null;
  const evalGrantId = !orgId && token ? verifyEvalGatewayToken(token) : null;
  if (!orgId && !evalGrantId)
    return errorResponse("Missing or invalid gateway token.", 401);

  let body: ChatCompletionsBody;
  try {
    body = (await request.json()) as ChatCompletionsBody;
  } catch {
    return errorResponse("Request body must be JSON.", 400);
  }

  const parsed =
    typeof body.model === "string" ? parseCodexModelId(body.model) : null;
  if (!parsed) {
    return errorResponse(
      "Only codex/<connectionId>/<slug> model ids are served by this gateway in Phase 1.",
      400,
    );
  }

  let activeEvalGrantId: string | null = null;
  if (evalGrantId) {
    const requestedOutput = Number(
      body.max_completion_tokens ??
        body.max_tokens ??
        EVAL_MAX_OUTPUT_TOKENS_PER_CALL,
    );
    const maxOutputTokens = Math.min(
      Number.isFinite(requestedOutput) && requestedOutput > 0
        ? Math.floor(requestedOutput)
        : EVAL_MAX_OUTPUT_TOKENS_PER_CALL,
      EVAL_MAX_OUTPUT_TOKENS_PER_CALL,
    );
    body.max_completion_tokens = maxOutputTokens;
    body.max_tokens = maxOutputTokens;
    const inputTokens = Math.max(
      1,
      Math.ceil(
        JSON.stringify({ messages: body.messages, tools: body.tools }).length /
          4,
      ),
    );
    try {
      const grant = await beginEvalModelCall({
        grantId: evalGrantId,
        model: body.model as string,
        reservedTokens: inputTokens + maxOutputTokens,
      });
      orgId = grant.orgId;
      activeEvalGrantId = grant.id;
    } catch (error) {
      if (error instanceof EvalGrantError) {
        return errorResponse(error.message, error.status);
      }
      throw error;
    }
  }

  let released = false;
  const releaseEvalCall = async () => {
    if (released || !activeEvalGrantId) return;
    released = true;
    await finishEvalModelCall(activeEvalGrantId).catch(() => {});
  };

  const conn = await getConnectionForGateway(parsed.connectionId);
  if (!conn) {
    await releaseEvalCall();
    return errorResponse("Model connection not found.", 404);
  }
  if (conn.orgId !== orgId || conn.provider !== "codex") {
    await releaseEvalCall();
    return errorResponse("This model connection is not available to you.", 403);
  }

  let access;
  try {
    access = await getFreshAccessToken(parsed.connectionId);
  } catch (error) {
    if (error instanceof InvalidGrantError) {
      await releaseEvalCall();
      return errorResponse(
        "This Codex connection is no longer valid — reconnect it in Org settings.",
        403,
      );
    }
    await releaseEvalCall();
    return errorResponse(
      error instanceof Error
        ? error.message
        : "Failed to authorize the Codex connection.",
      502,
    );
  }

  const payload = buildResponsesPayload(body, parsed.slug);
  const headers: Record<string, string> = {
    authorization: `Bearer ${access.accessToken}`,
    "content-type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    session_id: crypto.randomUUID(),
  };
  if (access.accountId) headers["ChatGPT-Account-ID"] = access.accountId;

  let upstream: Response;
  try {
    upstream = await fetch(`${codexApiBase()}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    await releaseEvalCall();
    return errorResponse(
      `Failed to reach the Codex backend: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    await releaseEvalCall();
    return errorResponse(
      `Codex backend error (HTTP ${upstream.status})${text ? `: ${text}` : "."}`,
      upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
    );
  }

  const wantsStream = wantsStreaming(body);
  const model = body.model as string;

  if (!wantsStream) {
    // Non-streaming client: drain the upstream SSE, translate, and aggregate to one completion.
    const parser = new SseParser();
    const translator = createChunkTranslator(model);
    const collected: ReturnType<typeof translator.translate> = [];
    try {
      const text = await upstream.text();
      for (const record of parser.push(text)) {
        for (const chunk of translator.translate(record)) collected.push(chunk);
      }
    } catch (error) {
      if (error instanceof CodexUpstreamError)
        return errorResponse(error.message, 502);
      throw error;
    } finally {
      await releaseEvalCall();
    }
    const completion = aggregateChunks(collected, model);
    return new Response(JSON.stringify(completion), {
      headers: { "content-type": "application/json" },
    });
  }

  // Streaming: parse upstream SSE, translate each event, re-emit as chat.completion.chunk SSE.
  const parser = new SseParser();
  const translator = createChunkTranslator(model);
  const upstreamBody = upstream.body;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      const send = (chunk: unknown) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const records = parser.push(decoder.decode(value, { stream: true }));
          for (const record of records) {
            for (const chunk of translator.translate(record)) send(chunk);
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        const message =
          error instanceof CodexUpstreamError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        // Surface the failure inline so the client stream ends with a readable error.
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } finally {
        await releaseEvalCall();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
