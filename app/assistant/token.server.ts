/**
 * Assistant callback tokens. The built-in assistant instance carries an
 * `HARNESST_ASSISTANT_TOKEN` identifying the DEPLOYMENT it runs as; the callback routes derive
 * everything else (deployment → environment → agent → project) from the DB, so nothing but the
 * deployment id is ever trusted from the client. HMAC-SHA256 over the deployment id keyed by the
 * same `HARNESST_SECRETS_KEY` — mirrors `app/team/token.server.ts` exactly, but with a DISTINCT
 * prefix `edna_` so an assistant token can never be replayed as a team-delegation token (`ednt_`)
 * or vice versa.
 *
 * Format: `edna_<deploymentId>.<base64url signature>`. Pure over an injected key so sign/verify
 * (and tamper rejection) unit-test without env.
 */
import crypto from "node:crypto";

import { decodeKey } from "~/seams/oss/secretbox";

const PREFIX = "edna_";

/** The signing key — reuses the secrets key source (never a new env var). */
export function assistantKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

function sign(deploymentId: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(deploymentId).digest("base64url");
}

/** Mint the token an assistant instance carries as HARNESST_ASSISTANT_TOKEN. */
export function mintAssistantToken(
  deploymentId: string,
  key: Buffer = assistantKey(),
): string {
  return `${PREFIX}${deploymentId}.${sign(deploymentId, key)}`;
}

/**
 * Verify a token and return the deployment id it authenticates, or null if it is malformed,
 * unsigned, tampered, or carries the wrong prefix. Constant-time signature comparison.
 */
export function verifyAssistantToken(
  token: string,
  key: Buffer = assistantKey(),
): string | null {
  if (!token.startsWith(PREFIX)) return null;
  const body = token.slice(PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;
  const deploymentId = body.slice(0, dot);
  const provided = body.slice(dot + 1);
  const expected = sign(deploymentId, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return deploymentId;
}

/** Pull a Bearer token out of an Authorization header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
