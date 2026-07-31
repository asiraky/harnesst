import {
  createContext,
  redirect,
  type MiddlewareFunction,
  type RouterContextProvider,
} from "react-router";

import { auth } from "~/lib/auth.server";
import { marketingHostRedirect } from "~/lib/marketing-host.server";
import { previewHostAppRedirect } from "~/lib/preview-origin.server";
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
  // Pushed run reporting (WS2): every harnesst-built agent's baked run hook POSTs its turn events
  // with the same delegation bearer. Server-to-server, so there is no browser Origin to check;
  // the route verifies the token itself — listing it here bypasses the CSRF check, not auth.
  "/api/agent/runs",
  "/api/connections/token",
  "/api/discord/interactions",
  "/api/discord/send",
  // Agent-initiated conversations (#288 3c): the baked `contact-user` tool POSTs its
  // notification with the same delegation bearer the park uses. No browser Origin exists on a
  // server-to-server call, and the route verifies the token itself — listing it here bypasses
  // the CSRF check, not authentication.
  "/api/foh/notify",
  // Channel park (WS1): an agent container POSTs its parked question with the same delegation
  // bearer the relay uses. No browser Origin exists on a server-to-server call, and the route
  // verifies the token itself — listing it here bypasses the CSRF check, not authentication.
  // Artifact publishing (#290): the agent's `publish-artifact` tool POSTs the path of an image on
  // its home volume with the same delegation bearer. Node's fetch sends no Origin, and the route
  // verifies the token itself — listing it here bypasses the CSRF check, not authentication.
  "/api/foh/artifacts",
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

/**
 * Powerful browser features nothing in harnesst uses, denied app-wide (issue #291). Composition is
 * an intersection and disabling is one-way — a document can never re-enable what its parent turned
 * off — so this header is what makes the artifact preview's own `allow="camera 'none'; …"` a floor
 * rather than the only line of defence. Unknown feature names are ignored by browsers, so listing
 * generously costs nothing.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "battery=()",
  "bluetooth=()",
  "camera=()",
  "display-capture=()",
  "document-domain=()",
  "encrypted-media=()",
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

function hardenDynamicResponse(response: Response): Response {
  // Dynamic routes can serialize users or one-time auth credentials. Default them to private,
  // non-cacheable responses while preserving an explicit policy from a safe leaf route (for
  // example the public sitemap). Hashed static assets bypass route middleware entirely.
  if (!response.headers.has("Cache-Control")) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  // A leaf route that set its OWN Content-Security-Policy keeps it, on the same principle as
  // Cache-Control above. This exists for one caller — the sandboxed artifact preview (#291), whose
  // whole safety story is a header set (`sandbox allow-scripts; default-src 'none'; …
  // frame-ancestors <app-origin>`) that an unconditional `set` here would erase.
  //
  // X-Frame-Options goes with it, and must: XFO has no `frame-ancestors <origin>` equivalent (the
  // legacy `ALLOW-FROM` is dead in every current browser), so leaving `DENY` on would refuse the
  // preview iframe outright. The route's own `frame-ancestors` is the stricter replacement — it
  // names one origin where XFO could only say "nobody" or "same site".
  if (response.headers.has("Content-Security-Policy")) {
    response.headers.delete("X-Frame-Options");
    return response;
  }
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

  // Sandbox origin (#296): with PREVIEW_ORIGIN configured, that host serves artifact previews and
  // nothing else — every other GET goes back to the app origin, so the host where agent-authored
  // script is expected to run never also hosts a sign-in form. The opposite direction (an artifact
  // preview asked for on the APP origin) is decided by the preview route itself, before it reads
  // its token. No-op when the env is unset.
  const previewRedirect = previewHostAppRedirect(request);
  if (previewRedirect) return hardenDynamicResponse(previewRedirect);

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
