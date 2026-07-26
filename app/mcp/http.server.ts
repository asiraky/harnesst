import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { verifyApiKey } from "~/mcp/api-keys.server";
import { createHarnesstMcpServer } from "~/mcp/server.server";
import { createMcpToolService, type McpToolService } from "~/mcp/tools.server";

type VerifiedApiKey = NonNullable<Awaited<ReturnType<typeof verifyApiKey>>>;

type McpRouteDependencies = {
  authenticate: (
    authorization: string | null,
  ) => Promise<VerifiedApiKey | null>;
  createService: (
    principal: VerifiedApiKey,
  ) => McpToolService | Promise<McpToolService>;
};

function jsonRpcError(message: string, status: number): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    },
    { status },
  );
}

/**
 * A stateless Streamable HTTP endpoint. Every request re-verifies the bearer key, then binds an
 * org/user-scoped tool service to a fresh protocol server. This avoids an in-memory session map
 * that would break when hosted harnesst is restarted or scaled across processes.
 */
export function createMcpRequestHandler(dependencies: McpRouteDependencies) {
  return async (request: Request): Promise<Response> => {
    let principal: VerifiedApiKey | null;
    try {
      principal = await dependencies.authenticate(
        request.headers.get("authorization"),
      );
    } catch {
      return jsonRpcError("Unauthorized", 401);
    }
    if (!principal) return jsonRpcError("Unauthorized", 401);

    const service = await dependencies.createService(principal);
    const server = createHarnesstMcpServer(service);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}

export const handleMcpRequest = createMcpRequestHandler({
  authenticate: (authorization) => verifyApiKey(authorization, "read"),
  createService: createMcpToolService,
});
