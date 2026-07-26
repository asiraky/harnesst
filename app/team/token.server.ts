/**
 * Delegation tokens (Team delegation — D3). A team member's instance carries an
 * `HARNESST_TEAM_TOKEN` that identifies the DEPLOYMENT it runs as; the relay derives everything
 * else (environment → agent → project) from the DB, so nothing but the deployment id is ever
 * trusted from the client. The token is an HMAC-SHA256 over the deployment id, keyed by the
 * same `HARNESST_SECRETS_KEY` the local secrets store already loads — no new secret to manage.
 *
 * Format: `ednt_<deploymentId>.<base64url signature>`. The id is not itself a secret (it's a
 * nanoid the relay looks up anyway); the signature is what makes the token unforgeable. Pure
 * over an injected key so sign/verify (and tamper rejection) unit-test without env.
 */
import crypto from "node:crypto";

import { decodeKey } from "~/seams/oss/secretbox";

const PREFIX = "ednt_";

/** The signing key — reuses the secrets key source (never a new env var). */
export function delegationKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

function sign(deploymentId: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(deploymentId).digest("base64url");
}

/** Mint the token an instance carries as HARNESST_TEAM_TOKEN. */
export function mintDelegationToken(
  deploymentId: string,
  key: Buffer = delegationKey(),
): string {
  return `${PREFIX}${deploymentId}.${sign(deploymentId, key)}`;
}

/**
 * Verify a token and return the deployment id it authenticates, or null if it is malformed,
 * unsigned, or tampered. Constant-time signature comparison.
 */
export function verifyDelegationToken(
  token: string,
  key: Buffer = delegationKey(),
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
