/**
 * Shared primitive for harnesst's opaque, database-backed machine credentials.
 *
 * The `edn_` prefix identifies a random credential; it does not encode identity or scope. Each
 * credential table stores only the SHA-256 digest, so the plaintext can be shown exactly once.
 */
import crypto from "node:crypto";

export const EDEN_TOKEN_PREFIX = "edn_";

/** Mint a 192-bit opaque harnesst credential. */
export function mintEdnToken(): string {
  return `${EDEN_TOKEN_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
}

/** Stable digest used for indexed credential lookup. */
export function hashEdnToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Whether a credential belongs to the opaque harnesst token namespace. */
export function isEdnToken(token: string): boolean {
  return /^edn_[A-Za-z0-9_-]{32}$/.test(token);
}

/**
 * Pull a harnesst credential from the Authorization header.
 *
 * This intentionally retains the ingest endpoint's original parsing contract: the scheme is
 * exactly `Bearer` followed by one space, and the remainder is returned verbatim.
 */
export function parseEdnAuthorizationHeader(
  auth: string | null,
): string | null {
  auth ??= "";
  return auth.startsWith("Bearer ") ? auth.slice(7) || null : null;
}

export function ednBearerToken(request: Request): string | null {
  return parseEdnAuthorizationHeader(request.headers.get("authorization"));
}
