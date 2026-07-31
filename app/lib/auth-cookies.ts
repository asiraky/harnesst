/**
 * The session cookie's name and Secure flag (#296).
 *
 * WHY `__Host-`: the browser enforces, from the name alone, that the cookie was set with `Secure`,
 * with `Path=/`, and with NO `Domain` attribute — which is exactly the property a sandbox subdomain
 * costs us otherwise. `preview.example.com` sits under the same registrable domain as
 * `example.com`, and a document there can write cookies scoped to the parent domain (this is
 * Google's stated reason for moving user content onto `*.usercontent.goog` and onto the Public
 * Suffix List). A `__Host-` cookie is host-locked: a subdomain cannot set one that the app host
 * will read, so cookie-jar tossing and session fixation from the preview origin both stop working.
 * It ships unconditionally, not gated on `PREVIEW_ORIGIN`, because it costs nothing to a
 * single-host install and the alternative is a security property that only exists when an operator
 * happens to have configured a second host.
 *
 * WHY IT IS COMPUTED RATHER THAN CONSTANT: `__Host-` REQUIRES `Secure`, and a `Secure` cookie is
 * rejected over plain http on anything that is not a trustworthy origin. Local development on
 * `http://<lan-ip>:5173` (or any browser that declines Secure-over-http on localhost) would
 * silently never persist a session — a login form that "does nothing". So the prefix follows the
 * scheme the app is actually served on, which is the same rule Better Auth applies to its own
 * `__Secure-` prefix; https deployments — every production one — get `__Host-`.
 *
 * Better Auth has no `__Host-` option: it prepends `__Secure-` itself whenever it decides cookies
 * are secure, so asking for a `__Host-` name while that is on yields `__Secure-__Host-…`, a name no
 * browser treats as either prefix. `auth.server.ts` therefore turns its automatic prefixing OFF
 * (`useSecureCookies: false`) and restores the flag through `defaultCookieAttributes`, which is
 * what this helper's fields feed. `Path=/` and "no Domain" are already Better Auth's defaults
 * and `crossSubDomainCookies` is deliberately not enabled, so both remaining `__Host-` conditions
 * hold.
 *
 * MIGRATION: the cookie is renamed, so every existing session cookie is ignored on deploy and
 * everyone signs in once more. No data is lost — the session rows are untouched, they just stop
 * being addressed. Call it out in the release notes.
 */
export interface AuthCookieConfig {
  /** Whether every auth cookie is set `Secure` — and therefore whether `__Host-` is usable. */
  secure: boolean;
  /**
   * The prefix EVERY Better Auth cookie is named with. It carries the `__Host-` prefix rather than
   * the session cookie alone because turning Better Auth's automatic `__Secure-` prefixing off
   * would otherwise strip the one protection its short-lived OAuth state cookies have; prefixing
   * all of them upgrades those from `__Secure-` to `__Host-` instead. Every Better Auth cookie is
   * already `Path=/` with no `Domain`, so all of them satisfy the prefix.
   */
  cookiePrefix: string;
}

const BASE_PREFIX = "harnesst";

export function authCookieConfig(
  env: { BETTER_AUTH_URL?: string; NODE_ENV?: string } = process.env,
): AuthCookieConfig {
  const baseUrl = env.BETTER_AUTH_URL?.trim().toLowerCase() ?? "";
  // No BETTER_AUTH_URL at all is a self-host install that has not configured its origin; assume
  // https exactly when it says it is production, which is Better Auth's own fallback.
  const secure = baseUrl
    ? baseUrl.startsWith("https://")
    : env.NODE_ENV === "production";
  const cookiePrefix = secure ? `__Host-${BASE_PREFIX}` : BASE_PREFIX;
  return { secure, cookiePrefix };
}
