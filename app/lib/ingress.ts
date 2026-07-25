/**
 * Public-URL helpers shared by every surface that shows or registers an environment's
 * ingress (Deployment tab, GitHub App manifest flow). Extracted from the deployments route
 * so the webhook URL harnesst renders and the one it writes into a GitHub App manifest can never
 * drift apart.
 */

/**
 * The app's public origin as the CLIENT reached it — behind the nginx proxy `request.url`'s
 * origin is the container's internal host, so the `x-forwarded-*` headers win when present.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = forwardedProto || url.protocol.replace(/:$/, "");
  const host = forwardedHost || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

/** An environment's ingress URL: `<origin>/e/<environmentId><path>` (splitter-routed). */
export function envIngressUrl(origin: string, environmentId: string, path = ""): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${origin.replace(/\/+$/, "")}/e/${environmentId}${suffix}`;
}

/** True when the origin can't be reached by an external webhook (local development). */
export function isLocalOrigin(origin: string): boolean {
  return (
    origin.includes("localhost") ||
    origin.includes("127.0.0.1") ||
    origin.includes("0.0.0.0")
  );
}
