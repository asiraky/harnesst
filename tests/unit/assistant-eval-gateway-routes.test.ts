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
  InvalidGrantError: class InvalidGrantError extends Error {},
}));

import { EvalGrantError } from "~/gateway/eval-grant.server";
import { action as chat } from "~/routes/api.gateway.chat";
import { loader as modelConfig } from "~/routes/api.gateway.model-config";

const MODEL = "codex/abcdefghijkl/gpt-5.5";

beforeEach(() => {
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
