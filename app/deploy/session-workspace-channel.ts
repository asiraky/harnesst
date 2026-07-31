/**
 * Platform-owned Eve channel injected into every user-agent build.
 *
 * Eve's stock HTTP channel mints the durable Eve session id itself. That id is too low-level for
 * workspace isolation: one harnesst conversation can succeed a channel-homed Eve session with a
 * fresh HTTP-homed one, and both must keep using the same working tree. This private channel accepts
 * harnesst's stable conversation id in a trusted header and seeds it into the channel adapter state
 * as `sandboxSessionId`. Eve already treats that state field as the sandbox identity (the same
 * mechanism self-delegation uses), so an Eve-session rotation reattaches the same sandbox.
 *
 * The source is written only into the Docker build context, never the customer's repository.
 * Instances may have public ingress, so both routes fail closed unless the deployment-scoped bearer
 * injected by the control plane matches.
 */

export const SESSION_WORKSPACE_CHANNEL_PATH =
  "agent/channels/harnesst-session-workspace.ts";
export const SESSION_WORKSPACE_ROUTE = "/harnesst/v1/session";
export const SESSION_WORKSPACE_CHANNEL_NAME = "harnesst-session-workspace";
export const SESSION_WORKSPACE_IMAGE_CAPABILITY = "session-workspaces-v1";
export const SESSION_WORKSPACE_IMAGE_LABEL =
  "dev.harnesst.capability.session-workspaces";
/**
 * `send()` returns the channel-local token, not Eve's internally namespaced token, so this prefix
 * is deliberately independent of the channel slug and is what harnesst persists on its row.
 */
export const SESSION_WORKSPACE_TOKEN_PREFIX = "harnesst-workspace:";
export const SESSION_WORKSPACE_ID_HEADER = "x-harnesst-workspace-id";
/** Existing deployment-scoped bearer shared by every agent→harnesst control-plane surface. */
export const SESSION_WORKSPACE_TOKEN_ENV = "HARNESST_TEAM_TOKEN";

export function isSessionWorkspaceContinuationToken(
  token: string | null | undefined,
): boolean {
  return Boolean(token?.startsWith(SESSION_WORKSPACE_TOKEN_PREFIX));
}

export const SESSION_WORKSPACE_CHANNEL_SOURCE = `import { timingSafeEqual } from "node:crypto";

import { defineChannel, POST } from "eve/channels";

const TOKEN = process.env.${SESSION_WORKSPACE_TOKEN_ENV} ?? "";
const WORKSPACE_HEADER = "${SESSION_WORKSPACE_ID_HEADER}";
const CREATE_ROUTE = "${SESSION_WORKSPACE_ROUTE}";

type WorkspaceState = {
  sandboxSessionId: string;
};

function bearerOk(request: Request): boolean {
  if (!TOKEN) return false;
  const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer\\s+/i, "");
  const actual = Buffer.from(presented);
  const expected = Buffer.from(TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function workspaceId(request: Request): string | null {
  const value = (request.headers.get(WORKSPACE_HEADER) ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) ? value : null;
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inputResponses(value: unknown) {
  return Array.isArray(value) ? value : undefined;
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized.", ok: false }, { status: 401 });
}

function badRequest(error: string): Response {
  return Response.json({ error, ok: false }, { status: 400 });
}

export default defineChannel<WorkspaceState>({
  state: { sandboxSessionId: "" },
  routes: [
    POST(CREATE_ROUTE, async (request, { send }) => {
      if (!bearerOk(request)) return unauthorized();
      const workspace = workspaceId(request);
      if (!workspace) return badRequest("Missing or invalid workspace id.");
      const body = await jsonBody(request);
      if (!body) return badRequest("Expected a JSON object.");
      const message = text(body.message);
      if (!message) return badRequest("Missing message.");

      const session = await send(
        { message },
        {
          auth: null,
          continuationToken: \`${SESSION_WORKSPACE_TOKEN_PREFIX}\${crypto.randomUUID()}\`,
          state: { sandboxSessionId: workspace },
        },
      );

      return Response.json(
        {
          continuationToken: session.continuationToken,
          ok: true,
          sessionId: session.id,
        },
        {
          headers: {
            "cache-control": "no-store",
            "x-eve-session-id": session.id,
          },
          status: 202,
        },
      );
    }),

    POST(\`\${CREATE_ROUTE}/:sessionId\`, async (request, { getSession, params, send }) => {
      if (!bearerOk(request)) return unauthorized();
      if (!workspaceId(request)) return badRequest("Missing or invalid workspace id.");
      const sessionId = params.sessionId;
      if (!sessionId) return badRequest("Missing session id.");
      try {
        getSession(sessionId);
      } catch {
        return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
      }
      const body = await jsonBody(request);
      if (!body) return badRequest("Expected a JSON object.");
      const continuationToken = text(body.continuationToken);
      if (!continuationToken) return badRequest("Missing continuation token.");

      const session = await send(
        {
          message: text(body.message),
          inputResponses: inputResponses(body.inputResponses) as never,
        },
        {
          auth: null,
          continuationToken,
          // Eve ignores seed state on delivery, but the stateful channel's type requires it.
          state: { sandboxSessionId: workspaceId(request)! },
        },
      );

      return Response.json(
        { ok: true, sessionId: session.id },
        {
          headers: {
            "cache-control": "no-store",
            "x-eve-session-id": session.id,
          },
          status: 200,
        },
      );
    }),
  ],
});
`;
