import { describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";

import { betterAuthSessionMiddleware } from "~/auth/session.server";
import { createMcpRequestHandler } from "~/mcp/http.server";
import type { McpToolService } from "~/mcp/tools.server";

function serviceMock(): McpToolService {
  const result = async () => ({ ok: true });
  return {
    listProjects: vi.fn(result),
    listAgents: vi.fn(result),
    listReleases: vi.fn(result),
    listEnvironments: vi.fn(result),
    getDeployStatus: vi.fn(result),
    deployTeamVersion: vi.fn(result),
    deployHead: vi.fn(result),
    retryDeployment: vi.fn(result),
    clearFailed: vi.fn(result),
    stageChanges: vi.fn(result),
    publishChanges: vi.fn(result),
    discardChanges: vi.fn(result),
  };
}

const principal = {
  keyId: "key_1",
  orgId: "org_1",
  userId: "user_1",
  scopes: ["read" as const, "deploy" as const, "author" as const],
};

function rpcRequest(body: object, authorization = "Bearer edn_test") {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  if (authorization) headers.set("authorization", authorization);
  return new Request("https://harnesst.example/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("MCP HTTP route", () => {
  it("is allowlisted as a bearer-authenticated machine mutation endpoint", async () => {
    const request = rpcRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const context = new RouterContextProvider();
    const url = new URL(request.url);
    let routeRan = false;

    const response = await betterAuthSessionMiddleware(
      {
        request,
        context,
        url,
        pattern: url.pathname,
        params: {},
      },
      async () => {
        routeRan = true;
        return new Response("ok");
      },
    );

    expect(routeRan).toBe(true);
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      throw new Error("Session middleware did not return a response.");
    }
    expect(response.status).toBe(200);
  });

  it("rejects requests without a valid read-scoped bearer credential", async () => {
    const authenticate = vi.fn(async () => null);
    const createService = vi.fn(() => serviceMock());
    const handler = createMcpRequestHandler({ authenticate, createService });

    const response = await handler(
      rpcRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, ""),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { message: "Unauthorized" },
    });
    expect(authenticate).toHaveBeenCalledWith(null);
    expect(createService).not.toHaveBeenCalled();
  });

  it("serves Streamable HTTP without issuing process-local session IDs", async () => {
    const service = serviceMock();
    const createService = vi.fn(() => service);
    const handler = createMcpRequestHandler({
      authenticate: vi.fn(async () => principal),
      createService,
    });

    const response = await handler(
      rpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "harnesst", version: "0.1.0" } },
    });
    expect(createService).toHaveBeenCalledWith(principal);
  });

  it("re-authenticates each stateless request and exposes the tool list", async () => {
    const authenticate = vi.fn(async () => principal);
    const handler = createMcpRequestHandler({
      authenticate,
      createService: () => serviceMock(),
    });

    const response = await handler(
      rpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    );
    const payload = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.result.tools.map(({ name }) => name)).toContain(
      "get_deploy_status",
    );
    expect(authenticate).toHaveBeenCalledTimes(1);
  });
});
