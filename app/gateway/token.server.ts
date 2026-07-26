/**
 * Model-gateway tokens (issue #28, Phase 1). A deployed agent set to a Codex model reaches harnesst's
 * translating gateway (`/api/gateway/v1/chat/completions`) carrying an `HARNESST_MODEL_GATEWAY_TOKEN`
 * that identifies its ORG; the gateway derives everything else (which connection, which upstream
 * account) from the request body + DB, so nothing but the org id is trusted from the client.
 * HMAC-SHA256 over the org id keyed by the same `HARNESST_SECRETS_KEY` — mirrors
 * `app/assistant/token.server.ts` exactly, but with a DISTINCT prefix `edng_` so a gateway token
 * can never be replayed as an assistant token (`edna_`) or team-delegation token (`ednt_`).
 *
 * Format: `edng_<orgId>.<base64url signature>`. Pure over an injected key so sign/verify (and
 * tamper rejection) unit-test without env.
 */
import crypto from "node:crypto";

import { decodeKey } from "~/seams/oss/secretbox";

export { bearerToken } from "~/assistant/token.server";

const PREFIX = "edng_";

/** The signing key — reuses the secrets key source (never a new env var). */
export function gatewayKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

function sign(orgId: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(orgId).digest("base64url");
}

/** Mint the token an agent carries as HARNESST_MODEL_GATEWAY_TOKEN. */
export function mintGatewayToken(
  orgId: string,
  key: Buffer = gatewayKey(),
): string {
  return `${PREFIX}${orgId}.${sign(orgId, key)}`;
}

/**
 * Verify a token and return the org id it authenticates, or null if it is malformed, unsigned,
 * tampered, or carries the wrong prefix. Constant-time signature comparison.
 */
export function verifyGatewayToken(
  token: string,
  key: Buffer = gatewayKey(),
): string | null {
  if (!token.startsWith(PREFIX)) return null;
  const body = token.slice(PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;
  const orgId = body.slice(0, dot);
  const provided = body.slice(dot + 1);
  const expected = sign(orgId, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return orgId;
}
