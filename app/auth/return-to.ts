// The default post-auth destination is Front of House at `/` (FOH D18); back of house
// keeps its own /dashboard entry for admins/owners.
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
    const url = new URL(value, "http://harnesst.local");
    if (url.origin !== "http://harnesst.local") return fallback;
    // URL normalization removes dot segments, so "/.//evil.com" passes the checks above yet
    // normalizes to the protocol-relative "//evil.com". Re-check the NORMALIZED path before
    // trusting it.
    if (url.pathname.startsWith("//")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
