/**
 * Provider-generic connect callback staging (issue #163) — an instance of the generic
 * staged-callback mechanism (see oauth-callback-staging.server.ts) for the
 * /connections/<provider>/callback routes. The provider's redirect carries a one-time
 * authorization `code`; staging keeps it out of history, logs, referrers, and rendered error
 * documents.
 *
 * One cookie NAME is shared across providers: the cookie `Path` scopes it to a single provider's
 * callback URL, and provider path segments never prefix each other, so payloads can't cross
 * providers. The staging instance is created per request path. Google stays on its dedicated
 * cookie + /google/callback path (google-callback.server.ts).
 */
import {
  createOAuthCallbackStaging,
  type OAuthCallbackPayload,
} from "./oauth-callback-staging.server";

export type { OAuthCallbackPayload };

/** Provider ids are lowercase kebab, mirroring the registry's key shape. */
export const CONNECTION_CALLBACK_PATH_RE =
  /^\/connections\/[a-z0-9]+(?:-[a-z0-9]+)*\/callback$/;

function stagingFor(pathname: string) {
  return createOAuthCallbackStaging({
    cookieName: "harnesst-connection-oauth-callback",
    path: pathname,
  });
}

/** True for any generic connection-callback path (middleware cookie clearing). */
export function isConnectionCallbackPath(pathname: string): boolean {
  return CONNECTION_CALLBACK_PATH_RE.test(pathname);
}

/** True when the request is a connection callback carrying provider query params to scrub. */
export function isConnectionCallbackStagingRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (!isConnectionCallbackPath(pathname)) return false;
  return stagingFor(pathname).isStagingRequest(request);
}

/** Encrypt the provider response into the cookie and redirect to the clean callback URL. */
export function stageConnectionCallback(request: Request): Response {
  return stagingFor(new URL(request.url).pathname).stage(request);
}

/** Decrypt and validate the staged payload on the clean follow-up request. */
export function readStagedConnectionCallback(
  request: Request,
): OAuthCallbackPayload | null {
  return stagingFor(new URL(request.url).pathname).readStaged(request);
}

/** A Set-Cookie value that deletes the staging cookie for this request's path. */
export function clearConnectionCallbackCookie(request: Request): string {
  return stagingFor(new URL(request.url).pathname).clearCookie(request);
}
