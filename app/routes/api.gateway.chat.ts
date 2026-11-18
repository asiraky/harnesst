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
import { modelSelectionFailure } from "~/models/provider-reference";
import { findCodexSpec, parseCodexModelId } from "~/models/codex-catalog";
import {
  getConnectionForGateway,
  resolveModelConnectionId,
  getFreshAccessToken,
  markConnectionStatus,
  type FreshAccess,
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
  toolResultLimitTokens,
  type WithheldToolResult,
} from "~/gateway/tool-result-limit";
import { recordWithheldToolResults } from "~/gateway/withheld-results.server";
import {
  beginEvalModelCall,
  EVAL_MAX_OUTPUT_TOKENS_PER_CALL,
  EvalGrantError,
  finishEvalModelCall,
} from "~/gateway/eval-grant.server";
import { verifyEvalGatewayToken } from "~/gateway/eval-token.server";
import {
  EMPTY_CALL_IDENTITY,
  parseCallIdentity,
  type CallIdentity,
} from "~/gateway/call-identity";
import {
  buildGatewayCallRow,
  createCallObserver,
  NO_OUTCOME,
  parseUpstreamError,
  planTypeFromAccessToken,
  upstreamRequestId,
  type CallAttempt,
  type CallContext,
  type CallOutcome,
} from "~/gateway/call-record";
import { recordRateLimits, writeGatewayCall } from "~/gateway/call-log.server";
import {
  estimateContextComposition,
  type ContextComposition,
} from "~/gateway/context-composition";
import { parseCodexRateLimits } from "~/gateway/rate-limits";

function errorResponse(
  message: string,
  status: number,
  context?: { code: string; model: string; recoveryUrl: string },
): Response {
  return new Response(JSON.stringify({ error: { message, ...context } }), {
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
  // Labels for the call log only (issue #416); nothing here is trusted for authorization.
  let identity: CallIdentity = evalGrantId
    ? EMPTY_CALL_IDENTITY
    : parseCallIdentity(request.headers);

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
      // The grant row, not the caller, says which project and member an eval call is for.
      identity = {
        ...EMPTY_CALL_IDENTITY,
        projectId: grant.projectId ?? null,
        agentName: grant.memberName ?? null,
      };
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

  const recoveryUrl = new URL(
    `/settings/connections#connection-${parsed.connectionId}`,
    process.env.BETTER_AUTH_URL || request.url,
  ).href;
  const failure = modelSelectionFailure(
    body.model as string,
    "connection_unavailable",
  );
  const recovery = { code: failure.code, model: failure.model, recoveryUrl };
  const reauthenticate = `OpenAI Codex needs authentication. A workspace owner or admin can reauthenticate at ${recoveryUrl}. If this ID was deleted, use Recover deleted ID after verifying the original account.`;
  const resolvedId = await resolveModelConnectionId(
    orgId!,
    parsed.connectionId,
  );
  const conn = await getConnectionForGateway(resolvedId);
  if (!conn) {
    await releaseEvalCall();
    return errorResponse(reauthenticate, 404, recovery);
  }
  if (conn.orgId !== orgId || conn.provider !== "codex") {
    await releaseEvalCall();
    return errorResponse("This model connection is not available to you.", 403);
  }

  let access: FreshAccess;
  try {
    access = await getFreshAccessToken(resolvedId);
  } catch (error) {
    if (error instanceof InvalidGrantError) {
      await releaseEvalCall();
      return errorResponse(reauthenticate, 403, recovery);
    }
    await releaseEvalCall();
    return errorResponse(
      error instanceof Error
        ? error.message
        : "Failed to authorize the Codex connection.",
      502,
    );
  }

  const dropped = new Set<string>();
  const withheld: WithheldToolResult[] = [];
  const payload = buildResponsesPayload(body, parsed.slug, {
    onDropped: (type) => dropped.add(type),
    toolResultLimitTokens: toolResultLimitTokens(
      findCodexSpec(parsed.slug)?.contextWindow,
    ),
    onWithheld: (w) => withheld.push(w),
  });
  await recordWithheldToolResults(orgId!, body.model as string, withheld);
  if (dropped.size > 0) {
    console.warn(
      `[gateway] dropped content parts with no Responses equivalent: ${[...dropped].join(", ")}`,
    );
  }
  // The call log (issue #416): one row per upstream call, written after the call ends and never
  // awaited. The row is built on a later tick so the composition estimate (which serializes the
  // whole request body) stays off the response path; it is computed once per request.
  let composition: ContextComposition | null = null;
  const logCall = (attempt: CallAttempt, outcome: CallOutcome) => {
    const endedAt = Date.now();
    // Snapshot what can change before the deferred write runs (a retry replaces `access`).
    const grant = access;
    setImmediate(() => {
      try {
        composition ??= estimateContextComposition(body);
        const context: CallContext = {
          orgId: orgId!,
          tokenKind: evalGrantId ? "eval" : "gateway",
          identity,
          connectionId: resolvedId,
          accountId: grant.accountId ?? null,
          planType: planTypeFromAccessToken(grant.accessToken),
          model: body.model as string,
          reasoningEffort: body.reasoning_effort ?? null,
          streamed: wantsStreaming(body),
          contextWindow: findCodexSpec(parsed.slug)?.contextWindow ?? null,
          composition,
        };
        void writeGatewayCall(
          buildGatewayCallRow(context, attempt, outcome, endedAt),
        );
      } catch (error) {
        console.error("[gateway] failed to build the call log row", error);
      }
    });
  };
  const failed = (message: string, code: string | null): CallOutcome => ({
    ...NO_OUTCOME,
    errorCode: code,
    errorMessage: message,
  });

  const send = async (grant: FreshAccess) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${grant.accessToken}`,
      "content-type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      session_id: crypto.randomUUID(),
    };
    if (grant.accountId) headers["ChatGPT-Account-ID"] = grant.accountId;
    const attempt: CallAttempt = {
      startedAt: Date.now(),
      httpStatus: null,
      upstreamRequestId: null,
    };
    let response: Response;
    try {
      response = await fetch(`${codexApiBase()}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      logCall(
        attempt,
        failed(
          error instanceof Error ? error.message : String(error),
          "network_error",
        ),
      );
      throw error;
    }
    attempt.httpStatus = response.status;
    attempt.upstreamRequestId = upstreamRequestId(response.headers);
    const limits = parseCodexRateLimits(response.headers);
    if (limits) {
      void recordRateLimits({
        orgId: orgId!,
        connectionId: resolvedId,
        limits,
      });
    }
    return { response, attempt };
  };

  let upstream: Response;
  let attempt: CallAttempt;
  try {
    ({ response: upstream, attempt } = await send(access));
    // The provider can revoke a token before its stored expiry (a plan change does). Refresh once
    // and retry before telling anyone to reconnect: the refresh token usually still works.
    if (upstream.status === 401) {
      let renewed: FreshAccess | null = null;
      try {
        renewed = await getFreshAccessToken(
          resolvedId,
          {},
          { rejectedVersion: access.credentialVersion },
        );
      } catch (error) {
        if (!(error instanceof InvalidGrantError)) {
          logCall(
            attempt,
            failed(
              `Access token rejected and the refresh failed: ${error instanceof Error ? error.message : String(error)}`,
              "token_refresh_failed",
            ),
          );
          throw error;
        }
      }
      if (renewed && renewed.accessToken !== access.accessToken) {
        await upstream.body?.cancel().catch(() => {});
        logCall(
          attempt,
          failed(
            "Access token rejected; refreshed it and retried.",
            "token_rejected",
          ),
        );
        access = renewed;
        ({ response: upstream, attempt } = await send(access));
      }
    }
  } catch (error) {
    await releaseEvalCall();
    return errorResponse(
      `Failed to reach the Codex backend: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    const upstreamError = parseUpstreamError(text);
    logCall(
      attempt,
      failed(
        upstreamError.message ?? `HTTP ${upstream.status}`,
        upstreamError.code ?? (upstream.ok ? "empty_body" : `http_${upstream.status}`),
      ),
    );
    await releaseEvalCall();
    if (upstream.status === 401) {
      // Expire only the credential generation that actually received the rejection.
      // A concurrently renewed grant must remain usable.
      await markConnectionStatus(
        resolvedId,
        "expired",
        access.credentialVersion,
      );
      return errorResponse(
        `${reauthenticate}${text ? ` Codex backend error (HTTP 401): ${text}` : ""}`,
        401,
        recovery,
      );
    }
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
    const observer = createCallObserver(attempt.startedAt);
    const collected: ReturnType<typeof translator.translate> = [];
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    try {
      // Read incrementally, not with text(), so the first token is timed when it arrives.
      for (;;) {
        const { done, value } = await reader.read();
        const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
        for (const record of parser.push(text)) {
          observer.observe(record);
          const chunks = translator.translate(record);
          observer.emitted(chunks);
          for (const chunk of chunks) collected.push(chunk);
        }
        if (done) break;
      }
    } catch (error) {
      observer.fail(error);
      if (error instanceof CodexUpstreamError)
        return errorResponse(error.message, 502);
      throw error;
    } finally {
      logCall(attempt, observer.outcome());
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
  const observer = createCallObserver(attempt.startedAt);
  const streamAttempt = attempt;
  const upstreamBody = upstream.body;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstreamBody.getReader();
  let clientCancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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
            observer.observe(record);
            const chunks = translator.translate(record);
            observer.emitted(chunks);
            for (const chunk of chunks) send(chunk);
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        if (clientCancelled) {
          observer.fail("The client closed the stream.", "client_cancelled");
          return;
        }
        observer.fail(error);
        const message =
          error instanceof CodexUpstreamError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        // Surface the failure inline so the client stream ends with a readable error.
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // The client is gone; nothing left to tell it.
        }
      } finally {
        logCall(streamAttempt, observer.outcome());
        await releaseEvalCall();
      }
    },
    cancel() {
      clientCancelled = true;
      return reader.cancel().catch(() => {});
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
