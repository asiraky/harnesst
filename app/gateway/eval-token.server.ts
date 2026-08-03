/**
 * Credential-safe eval gateway tokens. Unlike the long-lived org gateway token (`edng_`), an
 * eval token (`edne_`) names one short-lived database grant. The database row supplies the
 * project/member/model scope and mutable budgets; the signed token contains no reusable provider
 * credential and becomes useless as soon as the runner deletes its grant.
 */
import crypto from "node:crypto";

import { decodeKey } from "~/seams/oss/secretbox";

const PREFIX = "edne_";

export function evalGatewayKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

function sign(grantId: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(grantId).digest("base64url");
}

export function mintEvalGatewayToken(
  grantId: string,
  key: Buffer = evalGatewayKey(),
): string {
  return `${PREFIX}${grantId}.${sign(grantId, key)}`;
}

export function verifyEvalGatewayToken(
  token: string,
  key: Buffer = evalGatewayKey(),
): string | null {
  if (!token.startsWith(PREFIX)) return null;
  const body = token.slice(PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;
  const grantId = body.slice(0, dot);
  const provided = Buffer.from(body.slice(dot + 1));
  const expected = Buffer.from(sign(grantId, key));
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  return grantId;
}
