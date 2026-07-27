import {
  createContext,
  redirect,
  type MiddlewareFunction,
  type RouterContextProvider,
} from "react-router";

import { auth } from "~/lib/auth.server";
import { marketingHostRedirect } from "~/lib/marketing-host.server";
import {
  clearGoogleCallbackCookie,
  isGoogleCallbackStagingRequest,
  stageGoogleCallback,
} from "~/connections/google-callback.server";
import {
  clearConnectionCallbackCookie,
  isConnectionCallbackPath,
  isConnectionCallbackStagingRequest,
  stageConnectionCallback,
} from "~/connections/connection-callback.server";
import {
  clearGitHubManifestCallbackCookie,
  isGitHubManifestCallbackStagingRequest,
  stageGitHubManifestCallback,
} from "~/github/manifest-callback.server";
import {
  clearGitHubInstallationCallbackCookie,
  isGitHubInstallationCallbackStagingRequest,
  stageGitHubInstallationCallback,
} from "~/github/installation-callback.server";

type BetterAuthSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

export type SessionAuth = BetterAuthSession & {
  organizationId: string | null;
  requestHeaders: Headers;
};

export type SessionState =
  | SessionAuth
  | {
      user: null;
      session: null;
      organizationId: null;
    };

type RequestArgs = {
  request: Request;
  context: Readonly<RouterContextProvider>;
};

const sessionContext = createContext<SessionState | null>(null);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SIGNED_OR_BEARER_ENDPOINTS = new Set([
  "/api/connections/token",
  "/api/discord/interactions",
  "/api/discord/send",
  // Channel park (WS1): an agent container POSTs its parked question with the same delegation
  // bearer the relay uses. No browser Origin exists on a server-to-server call, and the route
  // verifies the token itself — listing it here bypasses the CSRF check, not authentication.
  "/api/foh/park",
  "/api/gateway/v1/chat/completions",
  "/api/github/webhook",
  "/api/ingest/runs",
  "/api/mcp",
  "/api/team/ask",
]);

function isBetterAuthEndpoint(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function isMachineEndpoint(pathname: string): boolean {
  return (
    pathname.startsWith("/api/assistant/") ||
    // Brokered-capability calls (issue #166): the agent's tools POST per-operation subpaths
    // (/api/capabilities/<provider>/<operation>) authenticated by their HARNESST_TEAM_TOKEN bearer.
    pathname.startsWith("/api/capabilities/") ||
    SIGNED_OR_BEARER_ENDPOINTS.has(pathname)
  );
}

function hasValidMutationOrigin(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

  const pathname = new URL(request.url).pathname;
  // Better Auth performs its own trusted-origin check. These machine endpoints authenticate the
  // raw request with a signature or bearer token and intentionally accept non-browser callers.
  if (isBetterAuthEndpoint(pathname) || isMachineEndpoint(pathname))
    return true;

  const configuredUrl = process.env.BETTER_AUTH_URL?.trim();
  const expectedOrigin = configuredUrl
    ? new URL(configuredUrl).origin
    : new URL(request.url).origin;
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) return false;
  try {
    return new URL(suppliedOrigin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

// Post-login home is Front of House at `/` (FOH D18).
function safeReturnTo(request: Request, fallback = "/"): string {
  const url = new URL(request.url);
  const candidate = `${url.pathname}${url.search}`;
  return candidate.startsWith("/") && !candidate.startsWith("//")
    ? candidate
    : fallback;
}

export function loginPath(
  request: Request,
  returnTo = safeReturnTo(request),
): string {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function signupPath(
  request: Request,
  returnTo = safeReturnTo(request),
): string {
  return `/signup?returnTo=${encodeURIComponent(returnTo)}`;
}

function toSessionState(
  result: BetterAuthSession | null,
  requestHeaders: Headers,
): SessionState {
  if (!result) {
    return { user: null, session: null, organizationId: null };
  }
  return {
    ...result,
    organizationId: result.session.activeOrganizationId ?? null,
    requestHeaders,
  };
}

async function readSession(request: Request) {
  const result = await auth.api.getSession({
    headers: request.headers,
    returnHeaders: true,
  });
  return {
    session: toSessionState(result.response, request.headers),
    responseHeaders: result.headers,
  };
}

function setCookieValues(headers: Headers): string[] {
  return typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : headers.get("set-cookie")
      ? [headers.get("set-cookie")!]
      : [];
}

function cookieName(value: string): string {
  return value.slice(0, value.indexOf("=")).trim().toLowerCase();
}

function appendRefreshHeaders(response: Response, refreshHeaders?: Headers) {
  if (!refreshHeaders) return;

  // A route response (notably sign-out) wins when it already updates the same cookie.
  // Appending a stale rolling cookie after a deletion would otherwise undo sign-out.
  const responseCookieNames = new Set(
    setCookieValues(response.headers).map(cookieName),
  );
  for (const value of setCookieValues(refreshHeaders)) {
    if (!responseCookieNames.has(cookieName(value))) {
      response.headers.append("set-cookie", value);
    }
  }
}

function hardenDynamicResponse(response: Response): Response {
  // Dynamic routes can serialize users or one-time auth credentials. Default them to private,
  // non-cacheable responses while preserving an explicit policy from a safe leaf route (for
  // example the public sitemap). Hashed static assets bypass route middleware entirely.
  if (!response.headers.has("Cache-Control")) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

/**
 * Load Better Auth once per server request, cache the session for every matched loader/action,
 * and propagate rolling/deletion cookies onto React Router's final response (including errors).
 */
export const betterAuthSessionMiddleware: MiddlewareFunction<Response> = async (
  { request, context },
  next,
) => {
  if (!hasValidMutationOrigin(request)) {
    return hardenDynamicResponse(new Response("Forbidden", { status: 403 }));
  }

  // Host split (FOH D11): with MARKETING_HOST configured, the marketing host serves only
  // the marketing paths and every other GET bounces to the app origin — and the app host
  // bounces the marketing-only paths back. No-op when the env is unset (self-host default).
  const hostRedirect = marketingHostRedirect(request);
  if (hostRedirect) return hardenDynamicResponse(hostRedirect);

  // Better Auth's own handler owns all cookies for its endpoints. In particular, sign-out and
  // reset responses must not be followed by an older rolling session cookie from this wrapper.
  const pathname = new URL(request.url).pathname;
  // Do not call `next()` when staging: matched loaders include root startup work, so even an
  // anonymous context could still touch Postgres or open services before the callback URL was
  // scrubbed.
  if (isGoogleCallbackStagingRequest(request)) {
    return hardenDynamicResponse(stageGoogleCallback(request));
  }
  if (isConnectionCallbackStagingRequest(request)) {
    return hardenDynamicResponse(stageConnectionCallback(request));
  }
  if (isGitHubManifestCallbackStagingRequest(request)) {
    return hardenDynamicResponse(stageGitHubManifestCallback(request));
  }
  if (isGitHubInstallationCallbackStagingRequest(request)) {
    return hardenDynamicResponse(stageGitHubInstallationCallback(request));
  }
  const ownsSession =
    !isBetterAuthEndpoint(pathname) && !isMachineEndpoint(pathname);

  let refreshHeaders: Headers | undefined;
  if (ownsSession) {
    const loaded = await readSession(request);
    context.set(sessionContext, loaded.session);
    refreshHeaders = loaded.responseHeaders;
  }

  const response = await next();
  hardenDynamicResponse(response);
  if (pathname === "/google/callback") {
    response.headers.append("set-cookie", clearGoogleCallbackCookie(request));
  }
  if (isConnectionCallbackPath(pathname)) {
    response.headers.append(
      "set-cookie",
      clearConnectionCallbackCookie(request),
    );
  }
  if (pathname === "/github/apps/callback") {
    response.headers.append(
      "set-cookie",
      clearGitHubManifestCallbackCookie(request),
    );
  }
  if (pathname === "/github/installations/callback") {
    response.headers.append(
      "set-cookie",
      clearGitHubInstallationCallbackCookie(request),
    );
  }
  appendRefreshHeaders(response, refreshHeaders);
  return response;
};

export async function getSessionAuth(
  input: RequestArgs,
): Promise<SessionState> {
  const cached = input.context.get(sessionContext);
  if (cached !== null) return cached;

  // Keeps direct route-handler tests and non-framework callers correct. Normal application
  // requests are populated by betterAuthSessionMiddleware so their response headers are retained.
  return (await readSession(input.request)).session;
}

export async function requireSession(input: RequestArgs): Promise<SessionAuth> {
  const session = await getSessionAuth(input);
  if (!session.user) throw redirect(loginPath(input.request));
  return session;
}

type SessionLoaderOptions = {
  ensureSignedIn?: boolean;
  returnTo?: string;
  /**
   * Where a signed-out visitor is sent. Defaults to the sign-in screen; invitation-style
   * routes, whose typical visitor has no account yet, point at sign-up instead (both screens
   * cross-link with `returnTo` preserved, so nobody is stranded).
   */
  signedOutRedirect?: "login" | "signup";
};

export function sessionLoader(
  args: RequestArgs,
): Promise<{ user: SessionState["user"] }>;
export function sessionLoader<T extends object>(
  args: RequestArgs,
  callback: (context: { auth: SessionAuth }) => T | Promise<T>,
  options?: SessionLoaderOptions,
): Promise<T & { user: SessionAuth["user"] }>;
export async function sessionLoader<T extends object>(
  args: RequestArgs,
  callback?: (context: { auth: SessionAuth }) => T | Promise<T>,
  options?: SessionLoaderOptions,
): Promise<
  (T & { user: SessionAuth["user"] }) | { user: SessionState["user"] }
> {
  const session = await getSessionAuth(args);
  if (!session.user) {
    if (options?.ensureSignedIn || callback) {
      const toPath =
        options?.signedOutRedirect === "signup" ? signupPath : loginPath;
      throw redirect(toPath(args.request, options?.returnTo));
    }
    return { user: null };
  }
  if (!callback) return { user: session.user };
  const result = await callback({ auth: session });
  return { ...result, user: session.user };
}
