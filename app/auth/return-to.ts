const RETURN_TO_ORIGIN = "http://harnesst.local";

function stripSingleFetchDetails(url: URL): void {
  if (url.pathname === "/_root.data" || url.pathname === "/_.data") {
    url.pathname = "/";
  } else if (url.pathname.endsWith("/_.data")) {
    url.pathname = url.pathname.slice(0, -"_.data".length);
  } else if (url.pathname.endsWith(".data")) {
    url.pathname = url.pathname.slice(0, -".data".length) || "/";
  }

  url.searchParams.delete("_routes");

  // React Router's naked `index` marker selects an index route. A valued
  // `index=something` parameter belongs to the application and must survive.
  const indexValues = url.searchParams.getAll("index");
  url.searchParams.delete("index");
  for (const value of indexValues) {
    if (value) url.searchParams.append("index", value);
  }
}

// Sanitizers for the query parameters the auth screens accept. The default post-auth
// destination is Front of House at `/` (FOH D18); back of house keeps its own /dashboard
// entry for admins/owners.
export function safeReturnTo(
  value: string | null | undefined,
  fallback = "/",
): string {
  // Backslashes are treated as slashes by browsers ("/\evil.com" → "//evil.com").
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return fallback;
  }
  try {
    const url = new URL(value, RETURN_TO_ORIGIN);
    if (url.origin !== RETURN_TO_ORIGIN) return fallback;
    // URL normalization removes dot segments, so "/.//evil.com" passes the checks above yet
    // normalizes to the protocol-relative "//evil.com". Re-check the NORMALIZED path before
    // trusting it.
    if (url.pathname.startsWith("//")) return fallback;
    stripSingleFetchDetails(url);
    if (url.pathname.endsWith(".data")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function returnToFromRequest(request: Request, fallback = "/"): string {
  const url = new URL(request.url);
  return safeReturnTo(`${url.pathname}${url.search}`, fallback);
}

/**
 * The `?email=` prefill the invitation flow hands to /login and /signup. The value is only ever
 * minted from a verified delivery token, but it is still a URL parameter anyone can type, so it
 * is rendered only when it parses as a single plain address — never arbitrary attacker text in
 * an auth screen. Prefilling discloses nothing on its own: /login's email step never asks the
 * server whether the account exists.
 */
export function safeEmailHint(value: string | null | undefined): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@<>"'/\\]+@[^\s@<>"'/\\]+\.[^\s@<>"'/\\]+$/.test(email)
    ? email
    : null;
}
