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
    const url = new URL(value, "http://eden.local");
    if (url.origin !== "http://eden.local") return fallback;
    // URL normalization removes dot segments, so "/.//evil.com" passes the checks above yet
    // normalizes to the protocol-relative "//evil.com". Re-check the NORMALIZED path before
    // trusting it.
    if (url.pathname.startsWith("//")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
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
