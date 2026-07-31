/**
 * Optional sandbox origin for HTML artifact previews (#296). `PREVIEW_ORIGIN` moves the bytes an
 * agent authored off harnesst's own origin, so a preview that escapes its CSP lands somewhere that
 * holds nothing: no session cookie, no same-origin reach into the app, no localStorage of ours.
 *
 * WHY AN ORIGIN AND NOT A HOST like `MARKETING_HOST`: the value is pasted straight into an
 * `iframe[src]` that a cross-origin document loads, so the scheme is part of the decision rather
 * than something to infer. A bare host is still accepted for local dev, where it inherits the app
 * origin's scheme and port exactly as `marketingOrigin()` does — otherwise nobody could try this
 * without TLS.
 *
 * UNSET IS THE DEFAULT AND A NO-OP: previews keep serving from the app origin at the same path,
 * byte for byte as before. Self-hosting stays zero-DNS-config.
 *
 * THE ORIGIN IS NOT WHAT AUTHENTICATES ANYTHING. The preview route reads no cookie either way —
 * the path token is the whole authentication and it crosses origins unchanged (which is precisely
 * why #291 put it in the path). So nothing about authorization moves when this is configured; only
 * where the browser thinks the document came from.
 *
 * All env reads happen at request time, never at module load, for the same reason as
 * `marketing-host.server.ts`: the dev tunnel rewrites `BETTER_AUTH_URL` per process.
 */
import { redirect } from "react-router";

import { appOrigin } from "~/lib/marketing-host.server";

/**
 * The configured preview origin (scheme + host), or null when unset or nonsensical. A
 * misconfiguration reads as unset rather than as a half-applied split: serving previews from the
 * app origin is the safe, working status quo, whereas redirecting to a garbled origin is a dead
 * panel on every artifact.
 */
export function previewOrigin(): string | null {
  const raw = process.env.PREVIEW_ORIGIN?.trim();
  if (!raw) return null;
  const candidate = raw.includes("://") ? raw : bareHostOrigin(raw);
  if (!candidate) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Credentials, a path, a query or a fragment mean the operator wrote a URL where an origin was
  // asked for; `url.origin` would silently drop them and the preview would work while the config
  // lied about what it does.
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;

  const origin = url.origin.toLowerCase();
  // Equal to the app origin, the split does not exist — and the route's host check would redirect
  // a request to the host it already arrived on, forever.
  if (origin === appOrigin()?.toLowerCase()) return null;
  return origin;
}

/** A bare `host` or `host:port` promoted to an origin using the app origin's scheme and port. */
function bareHostOrigin(raw: string): string | null {
  const host = raw.toLowerCase();
  if (host.includes("/") || host.includes("@") || /\s/.test(host)) return null;
  const app = appOrigin();
  if (!app) return `https://${host}`;
  const appUrl = new URL(app);
  const withPort =
    host.includes(":") || !appUrl.port ? host : `${host}:${appUrl.port}`;
  return `${appUrl.protocol}//${withPort}`;
}

/** True when this request arrived on the configured preview origin's host. */
export function isPreviewHost(request: Request): boolean {
  const origin = previewOrigin();
  if (!origin) return false;
  const configured = new URL(origin);
  const url = new URL(request.url);
  // A port-less PREVIEW_ORIGIN matches any port, matching `isMarketingHost`: prod terminates on
  // 443 at nginx and forwards `Host` without a port, dev serves 5173.
  return configured.port
    ? url.host === configured.host
    : url.hostname === configured.hostname;
}

/**
 * Where an HTML preview request that landed on the wrong host has to go, or null to serve it here.
 *
 * Null covers every case that is not a real split: no `PREVIEW_ORIGIN` (the self-host default),
 * a request already on the preview host, and any non-safe method (the preview route is loader-only,
 * so a POST here is not a thing to bounce — and a redirect would drop its body anyway).
 *
 * The full `pathname` + `search` is carried because the path IS the capability: the token lives in
 * it, and a redirect to a bare origin would authenticate nothing.
 */
export function previewHostRedirect(request: Request): Response | null {
  const origin = previewOrigin();
  if (!origin) return null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (isPreviewHost(request)) return null;
  const url = new URL(request.url);
  return redirect(`${origin}${url.pathname}${url.search}`);
}

/**
 * The one path family the sandbox origin exists to serve.
 *
 * Matched case-insensitively because React Router matches routes that way too. A case variant such
 * as `/Artifacts/preview/<token>/…` still reaches the preview route, so if this said "not a preview
 * path" the sandbox origin would bounce it to the app origin, where the route's host check would
 * bounce it straight back — a redirect ping-pong until the browser gives up. Treating the variant as
 * a preview path lets it 404 on its token like any other bad URL.
 */
export function isArtifactPreviewPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return (
    normalized === "/artifacts/preview" ||
    normalized.startsWith("/artifacts/preview/")
  );
}

/**
 * The other half of the split, applied by the root session middleware: on the sandbox origin,
 * anything that is NOT a preview goes back to the app origin.
 *
 * Without this the whole control plane — sign-in, the FOH session pages — would answer on the
 * preview host too, which is the opposite of what a sandbox domain is for: the point is that the
 * host holds nothing worth attacking. Safe methods only, for the same reason as the marketing
 * split: cross-origin mutations are already 403ed by the origin check, and a redirect loses a body.
 */
export function previewHostAppRedirect(request: Request): Response | null {
  if (!previewOrigin()) return null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (!isPreviewHost(request)) return null;
  const url = new URL(request.url);
  if (isArtifactPreviewPath(url.pathname)) return null;
  const app = appOrigin();
  return app ? redirect(`${app}${url.pathname}${url.search}`) : null;
}

/**
 * The origin allowed to EMBED a preview — always the app's, never the preview's.
 *
 * This is the line the origin split would otherwise quietly break. `frame-ancestors` names who may
 * frame the document, and once previews serve from `PREVIEW_ORIGIN`, falling back to "the origin
 * this request arrived on" would name the preview origin itself: the app could no longer frame its
 * own panel, and the preview could frame itself. So the request-origin fallback (which exists for
 * self-host installs with no `BETTER_AUTH_URL`) is used only when the request did NOT arrive on the
 * preview host. With no app origin to name on a split deployment there is no honest answer, and
 * `'none'` — refuse all embedding — is the one that fails closed.
 */
export function previewFrameAncestors(requestUrl: string): string {
  const app = appOrigin();
  if (app) return app;
  const request = new Request(requestUrl);
  if (isPreviewHost(request)) return "'none'";
  return new URL(requestUrl).origin;
}
