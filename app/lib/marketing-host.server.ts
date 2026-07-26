/**
 * Marketing/app host split (FOH PRD §2.6, D11). `MARKETING_HOST` (a bare host such as
 * `www.harnesst.example.com`, optionally `host:port` for local dev) puts the editorial marketing
 * site on its own host: the marketing paths serve ONLY there, every other GET on that host
 * redirects to the app origin (`BETTER_AUTH_URL`), and the app host bounces the
 * marketing-only paths to the marketing origin. Unset — the self-host default — everything
 * is a no-op: `/` is Front of House and the marketing pages stay reachable by path.
 *
 * All env reads happen at request time (never at module load) so the dev tunnel's
 * per-process `BETTER_AUTH_URL` override and inline `MARKETING_HOST=… npm run dev` runs
 * behave. Host comparison uses `new URL(request.url).host`, which is trustworthy in prod
 * (nginx forwards `Host $host`; Express runs `trust proxy: loopback`) and in dev (the
 * request hits the dev server directly).
 */
import { redirect } from "react-router";

/** The configured marketing host, normalized — or null when unset/nonsensical. */
export function marketingHost(): string | null {
  const raw = process.env.MARKETING_HOST?.trim().toLowerCase();
  if (!raw) return null;
  // Bare host only. A scheme, path, credentials, or whitespace is a misconfiguration —
  // treat it as unset rather than mis-comparing on every request.
  if (raw.includes("/") || raw.includes("@") || /\s/.test(raw)) return null;
  // A marketing host equal to the app host would make every redirect below loop.
  const app = appOrigin();
  if (app) {
    const appUrl = new URL(app);
    if (raw === appUrl.host || raw === appUrl.hostname) return null;
  }
  return raw;
}

/** The app origin (scheme + host) from BETTER_AUTH_URL — null when unset/unparsable. */
export function appOrigin(): string | null {
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The marketing site's origin. Scheme (and, when MARKETING_HOST carries no port of its own,
 * the port) follow the app origin, so local dev with `BETTER_AUTH_URL=http://localhost:5284`
 * and `MARKETING_HOST=marketing.localhost` yields `http://marketing.localhost:5284`. Prod
 * (https, no port) yields `https://<host>`.
 */
export function marketingOrigin(): string | null {
  const host = marketingHost();
  if (!host) return null;
  const app = appOrigin();
  if (!app) return `https://${host}`;
  const appUrl = new URL(app);
  const withPort =
    host.includes(":") || !appUrl.port ? host : `${host}:${appUrl.port}`;
  return `${appUrl.protocol}//${withPort}`;
}

/** True when this request arrived on the configured marketing host. */
export function isMarketingHost(request: Request): boolean {
  const host = marketingHost();
  if (!host) return false;
  const url = new URL(request.url);
  // A port-less MARKETING_HOST matches any port: prod nginx serves 443, dev serves 5284.
  return host.includes(":") ? url.host === host : url.hostname === host;
}

/** Paths that belong to the marketing site when a marketing host is configured. */
export function isMarketingPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/sitemap.xml" ||
    pathname === "/robots.txt" ||
    pathname === "/case-studies" ||
    pathname.startsWith("/case-studies/")
  );
}

/**
 * Marketing-ONLY paths: on the app host these bounce to the marketing origin. `/` is dual
 * (FOH on the app host, the landing on the marketing host) and robots.txt serves per-host.
 */
function isMarketingOnlyPath(pathname: string): boolean {
  return (
    pathname === "/sitemap.xml" ||
    pathname === "/case-studies" ||
    pathname.startsWith("/case-studies/")
  );
}

/**
 * The D11 host-split redirect, evaluated for every request by the root session middleware
 * (and defensively by the marketing routes' own loaders). Null when no marketing host is
 * configured, when the request is already on the right host, or when the counterpart origin
 * cannot be built. Only safe methods redirect: the marketing host is GET-only by design —
 * the mutation-origin check already 403s cross-origin POSTs, and machine endpoints
 * authenticate the raw request and never live on the marketing host.
 */
export function marketingHostRedirect(request: Request): Response | null {
  if (!marketingHost()) return null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const url = new URL(request.url);
  if (isMarketingHost(request)) {
    if (isMarketingPath(url.pathname)) return null;
    const app = appOrigin();
    return app ? redirect(`${app}${url.pathname}${url.search}`) : null;
  }
  if (isMarketingOnlyPath(url.pathname)) {
    const origin = marketingOrigin();
    return origin ? redirect(`${origin}${url.pathname}${url.search}`) : null;
  }
  return null;
}
