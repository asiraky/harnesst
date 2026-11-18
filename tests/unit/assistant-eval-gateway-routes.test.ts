import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyGatewayToken: vi.fn(),
  verifyEvalGatewayToken: vi.fn(),
  getActiveEvalGrant: vi.fn(),
  beginEvalModelCall: vi.fn(),
  finishEvalModelCall: vi.fn(),
  resolveAgentModel: vi.fn(),
  findWorkspaceModel: vi.fn(),
  getConnectionForGateway: vi.fn(),
  getFreshAccessToken: vi.fn(),
  markConnectionStatus: vi.fn(),
  writeGatewayCall: vi.fn(),
  recordRateLimits: vi.fn(),
}));

vi.mock("~/gateway/call-log.server", () => ({
  writeGatewayCall: mocks.writeGatewayCall,
  recordRateLimits: mocks.recordRateLimits,
}));

vi.mock("~/gateway/token.server", () => ({
  bearerToken: (request: Request) =>
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null,
  verifyGatewayToken: mocks.verifyGatewayToken,
}));

vi.mock("~/gateway/eval-token.server", () => ({
  verifyEvalGatewayToken: mocks.verifyEvalGatewayToken,
}));

vi.mock("~/gateway/eval-grant.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/gateway/eval-grant.server")>()),
  getActiveEvalGrant: mocks.getActiveEvalGrant,
  beginEvalModelCall: mocks.beginEvalModelCall,
  finishEvalModelCall: mocks.finishEvalModelCall,
}));

vi.mock("~/models/agent-model-config.server", () => ({
  resolveAgentModel: mocks.resolveAgentModel,
}));

vi.mock("~/models/union.server", () => ({
  findWorkspaceModel: mocks.findWorkspaceModel,
}));

vi.mock("~/models/provider-connections.server", () => ({
  resolveModelConnectionId: async (_org: string, id: string) => id,
  getConnectionForGateway: mocks.getConnectionForGateway,
  getFreshAccessToken: mocks.getFreshAccessToken,
  markConnectionStatus: mocks.markConnectionStatus,
}));

vi.mock("~/connections/codex.server", () => ({
  codexApiBase: () => "https://codex.invalid",
  decodeJwtClaims: () => null,
  InvalidGrantError: class InvalidGrantError extends Error {},
}));

import { EvalGrantError } from "~/gateway/eval-grant.server";
import { action as chat } from "~/routes/api.gateway.chat";
import { loader as modelConfig } from "~/routes/api.gateway.model-config";

const MODEL = "codex/abcdefghijkl/gpt-5.5";

/** Call-log rows are built on a later tick, off the response path. */
const flushCallLog = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  // Let call-log writes deferred by the previous test land before its mocks are cleared.
  await flushCallLog();
  vi.clearAllMocks();
  mocks.verifyGatewayToken.mockReturnValue(null);
  mocks.verifyEvalGatewayToken.mockReturnValue("grantabcdefg");
  mocks.getActiveEvalGrant.mockResolvedValue({
    id: "grantabcdefg",
    orgId: "org_1",
    memberName: "researcher",
    model: MODEL,
    effort: "high",
    modelSource: "override",
  });
  mocks.findWorkspaceModel.mockResolvedValue({ contextWindow: 200_000 });
  mocks.finishEvalModelCall.mockResolvedValue(undefined);
});

describe("eval-scoped model config", () => {
  it("returns the grant's pinned member/model instead of re-resolving mutable workspace state", async () => {
    const response = await modelConfig({
      request: new Request(
        "http://localhost/api/gateway/v1/model-config?agent=researcher",
        { headers: { authorization: "Bearer edne_scoped" } },
      ),
      params: {},
      context: {} as never,
    } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model: MODEL,
      effort: "high",
      source: "override",
      contextWindowTokens: 200_000,
    });
    expect(mocks.resolveAgentModel).not.toHaveBeenCalled();
  });

  it("rejects using the grant for another member", async () => {
    const response = await modelConfig({
      request: new Request(
        "http://localhost/api/gateway/v1/model-config?agent=intruder",
        { headers: { authorization: "Bearer edne_scoped" } },
      ),
      params: {},
      context: {} as never,
    } as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        message: expect.stringMatching(/scoped to the "researcher" member/i),
      },
    });
  });
});

describe("eval-scoped chat gateway", () => {
  it("rejects a connection from another org and releases the concurrency lease", async () => {
    mocks.beginEvalModelCall.mockResolvedValue({
      id: "grantabcdefg",
      orgId: "org_1",
    } as never);
    mocks.getConnectionForGateway.mockResolvedValue({
      id: "abcdefghijkl",
      orgId: "org_evil",
      provider: "codex",
    } as never);
    const response = await chat({
      request: new Request("http://localhost/api/gateway/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer edne_scoped",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      params: {},
      context: {} as never,
    } as never);
    expect(response.status).toBe(403);
    expect(mocks.beginEvalModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: "grantabcdefg", model: MODEL }),
    );
    expect(mocks.finishEvalModelCall).toHaveBeenCalledWith("grantabcdefg");
  });

  it("returns a readable budget refusal before any upstream model credential is used", async () => {
    mocks.beginEvalModelCall.mockRejectedValue(
      new EvalGrantError("This eval exhausted its token spend limit.", 429),
    );
    const response = await chat({
      request: new Request("http://localhost/api/gateway/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer edne_scoped",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      params: {},
      context: {} as never,
    } as never);
    expect(response.status).toBe(429);
    expect(await response.text()).toMatch(/token spend limit/i);
    expect(mocks.getConnectionForGateway).not.toHaveBeenCalled();
    expect(mocks.getFreshAccessToken).not.toHaveBeenCalled();
  });
});

describe("call log", () => {
  const sse = (events: Array<Record<string, unknown>>) =>
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("");
  const completedStream = (headers: Record<string, string> = {}) =>
    new Response(
      sse([
        { type: "response.output_text.delta", delta: "Hi" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            usage: {
              input_tokens: 50,
              input_tokens_details: { cached_tokens: 40 },
              output_tokens: 5,
            },
          },
        },
      ]),
      {
        status: 200,
        headers: { "content-type": "text/event-stream", ...headers },
      },
    );
  const chatRequest = (
    authorization: string,
    headers: Record<string, string> = {},
  ) =>
    new Request("http://localhost/api/gateway/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

  beforeEach(() => {
    mocks.getConnectionForGateway.mockResolvedValue({
      id: "abcdefghijkl",
      orgId: "org_1",
      provider: "codex",
    });
    mocks.getFreshAccessToken.mockResolvedValue({
      accessToken: "grant",
      accountId: "account_1",
      credentialVersion: 1,
    });
  });

  it("writes one row for a streamed call once the stream ends, labelled by the agent's headers", async () => {
    mocks.verifyGatewayToken.mockReturnValue("org_1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        completedStream({
          "x-request-id": "req_9",
          "x-codex-primary-used-percent": "12.5",
          "x-codex-primary-window-minutes": "300",
        }),
      ),
    );
    const response = await chat({
      request: chatRequest("Bearer gateway", {
        "x-harnesst-agent": "ledger",
        "x-harnesst-step": "4",
        "x-harnesst-project": "abcdefghijkl",
      }),
      params: {},
      context: {},
    } as never);
    expect(mocks.writeGatewayCall).not.toHaveBeenCalled();
    expect(await response.text()).toContain("[DONE]");
    await flushCallLog();
    expect(mocks.writeGatewayCall).toHaveBeenCalledTimes(1);
    expect(mocks.writeGatewayCall.mock.calls[0][0]).toMatchObject({
      orgId: "org_1",
      tokenKind: "gateway",
      agentName: "ledger",
      stepIndex: 4,
      projectId: "abcdefghijkl",
      connectionId: "abcdefghijkl",
      httpStatus: 200,
      upstreamRequestId: "req_9",
      inputTokens: 50,
      cachedInputTokens: 40,
      outputTokens: 5,
      finishReason: "stop",
      streamed: true,
    });
    expect(mocks.recordRateLimits).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "abcdefghijkl",
      limits: {
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: null },
        secondary: null,
      },
    });
  });

  it("labels an eval call from its grant, not from the caller's headers", async () => {
    mocks.beginEvalModelCall.mockResolvedValue({
      id: "grantabcdefg",
      orgId: "org_1",
      projectId: "projgrant123",
      memberName: "researcher",
    } as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completedStream()));
    const response = await chat({
      request: chatRequest("Bearer edne_scoped", {
        "x-harnesst-agent": "someone-else",
        "x-harnesst-project": "projother123",
      }),
      params: {},
      context: {},
    } as never);
    await response.text();
    await flushCallLog();
    expect(mocks.writeGatewayCall.mock.calls[0][0]).toMatchObject({
      tokenKind: "eval",
      agentName: "researcher",
      projectId: "projgrant123",
    });
  });

  it("records the upstream's error code for a refused call", async () => {
    mocks.verifyGatewayToken.mockReturnValue("org_1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { type: "usage_limit_reached", message: "Limit hit" },
          }),
          { status: 429 },
        ),
      ),
    );
    const response = await chat({
      request: chatRequest("Bearer gateway"),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(429);
    await flushCallLog();
    expect(mocks.writeGatewayCall.mock.calls[0][0]).toMatchObject({
      httpStatus: 429,
      errorCode: "usage_limit_reached",
      errorMessage: "Limit hit",
      inputTokens: null,
    });
  });

  it("records a network failure that never reached the upstream", async () => {
    mocks.verifyGatewayToken.mockReturnValue("org_1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    );
    const response = await chat({
      request: chatRequest("Bearer gateway"),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(502);
    await flushCallLog();
    expect(mocks.writeGatewayCall.mock.calls[0][0]).toMatchObject({
      httpStatus: null,
      errorCode: "network_error",
      errorMessage: "ECONNRESET",
    });
  });

  it("still answers when the call log cannot be written", async () => {
    mocks.verifyGatewayToken.mockReturnValue("org_1");
    mocks.writeGatewayCall.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completedStream()));
    const response = await chat({
      request: chatRequest("Bearer gateway"),
      params: {},
      context: {},
    } as never);
    expect(await response.text()).toContain("Hi");
    await flushCallLog();
  });

  it("logs the rejected attempt when refreshing its token fails", async () => {
    mocks.verifyGatewayToken.mockReturnValue("org_1");
    mocks.getFreshAccessToken
      .mockResolvedValueOnce({
        accessToken: "revoked",
        accountId: null,
        credentialVersion: 3,
      })
      .mockRejectedValueOnce(new Error("refresh endpoint down"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 401 })),
    );
    const response = await chat({
      request: chatRequest("Bearer gateway"),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(502);
    await flushCallLog();
    expect(mocks.writeGatewayCall).toHaveBeenCalledTimes(1);
    expect(mocks.writeGatewayCall.mock.calls[0][0]).toMatchObject({
      httpStatus: 401,
      errorCode: "token_refresh_failed",
    });
  });

  it("times the first token of a non-streamed call when it arrives, not when the body ends", async () => {
    mocks.verifyGatewayToken.mockReturnValue("org_1");
    const encoder = new TextEncoder();
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}\n\n`,
          ),
        );
        finish = () => {
          controller.enqueue(
            encoder.encode(
              `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`,
            ),
          );
          controller.close();
        };
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const pending = chat({
      request: new Request("http://localhost/api/gateway/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      params: {},
      context: {},
    } as never);
    await flushCallLog();
    now = 6_000;
    finish();
    const response = await pending;
    expect(response.status).toBe(200);
    await flushCallLog();
    clock.mockRestore();
    const row = mocks.writeGatewayCall.mock.calls[0][0];
    expect(row.ttftMs).toBe(0);
    expect(row.durationMs).toBe(5_000);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("upstream authentication mapping", () => {
  it.each([401, 403])(
    "preserves upstream HTTP %s detail and expires only unauthorized credentials",
    async (status) => {
      mocks.verifyGatewayToken.mockReturnValue("org_1");
      mocks.getConnectionForGateway.mockResolvedValue({
        id: "abcdefghijkl",
        orgId: "org_1",
        provider: "codex",
      });
      mocks.getFreshAccessToken.mockResolvedValue({
        accessToken: "grant",
        accountId: "account_1",
        credentialVersion: 7,
      });
      mocks.markConnectionStatus.mockResolvedValue(true);
      const upstream = JSON.stringify({
        error: {
          code: status === 403 ? "unsupported_model" : "invalid_api_key",
          message: "Provider supplied diagnostic",
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(upstream, { status })),
      );
      const response = await chat({
        request: new Request(
          "http://localhost/api/gateway/v1/chat/completions",
          {
            method: "POST",
            headers: {
              authorization: "Bearer gateway",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              messages: [{ role: "user", content: "hello" }],
            }),
          },
        ),
        params: {},
        context: {},
      } as never);
      const body = await response.json();
      expect(response.status).toBe(status);
      expect(body.error.message).toContain(upstream);
      if (status === 401) {
        expect(body.error).toMatchObject({
          code: "connection_unavailable",
          model: MODEL,
          recoveryUrl: expect.stringContaining("#connection-abcdefghijkl"),
        });
        expect(mocks.markConnectionStatus).toHaveBeenCalledWith(
          "abcdefghijkl",
          "expired",
          7,
        );
      } else {
        expect(body.error.code).toBeUndefined();
        expect(body.error.recoveryUrl).toBeUndefined();
        expect(mocks.markConnectionStatus).not.toHaveBeenCalled();
      }
    },
  );
});

describe("revoked access token", () => {
  const request = () =>
    new Request("http://localhost/api/gateway/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer gateway",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });
  const completed = () =>
    new Response(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  beforeEach(() => {
    mocks.verifyGatewayToken.mockReturnValue("org_1");
    mocks.getConnectionForGateway.mockResolvedValue({
      id: "abcdefghijkl",
      orgId: "org_1",
      provider: "codex",
    });
    mocks.markConnectionStatus.mockResolvedValue(true);
  });

  it("refreshes once and retries before expiring the connection", async () => {
    mocks.getFreshAccessToken
      .mockResolvedValueOnce({
        accessToken: "revoked",
        accountId: "account_1",
        credentialVersion: 7,
      })
      .mockResolvedValueOnce({
        accessToken: "renewed",
        accountId: "account_1",
        credentialVersion: 8,
      });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("token_expired", { status: 401 }))
      .mockResolvedValueOnce(completed());
    vi.stubGlobal("fetch", fetch);
    const response = await chat({
      request: request(),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(200);
    expect(mocks.getFreshAccessToken).toHaveBeenLastCalledWith(
      "abcdefghijkl",
      {},
      { rejectedVersion: 7 },
    );
    expect(fetch.mock.calls[1][1].headers.authorization).toBe("Bearer renewed");
    expect(mocks.markConnectionStatus).not.toHaveBeenCalled();
    // Both upstream attempts land in the call log: the rejected one and the retry.
    await flushCallLog();
    expect(
      mocks.writeGatewayCall.mock.calls.map(([row]) => ({
        httpStatus: row.httpStatus,
        errorCode: row.errorCode,
        inputTokens: row.inputTokens,
      })),
    ).toEqual([
      { httpStatus: 401, errorCode: "token_rejected", inputTokens: null },
      { httpStatus: 200, errorCode: null, inputTokens: 1 },
    ]);
  });

  it("expires the renewed generation when the provider rejects it too", async () => {
    mocks.getFreshAccessToken
      .mockResolvedValueOnce({
        accessToken: "revoked",
        accountId: null,
        credentialVersion: 7,
      })
      .mockResolvedValueOnce({
        accessToken: "renewed",
        accountId: null,
        credentialVersion: 8,
      });
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const response = await chat({
      request: request(),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.markConnectionStatus).toHaveBeenCalledWith(
      "abcdefghijkl",
      "expired",
      8,
    );
  });

  it("expires the connection when the refresh token is dead too", async () => {
    const { InvalidGrantError } = await import("~/connections/codex.server");
    mocks.getFreshAccessToken
      .mockResolvedValueOnce({
        accessToken: "revoked",
        accountId: null,
        credentialVersion: 7,
      })
      .mockRejectedValueOnce(new InvalidGrantError("dead"));
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const response = await chat({
      request: request(),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.markConnectionStatus).toHaveBeenCalledWith(
      "abcdefghijkl",
      "expired",
      7,
    );
  });
});
