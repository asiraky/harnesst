/** Server-only signing for the control-plane model directive sent to deployed agents. */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  buildModelDirective,
  modelDirectiveSignaturePayload,
  type ModelDirective,
} from "~/models/model-directive";
import { decodeKey } from "~/seams/oss/secretbox";

/** Per-deployment secret: one leaked signature cannot be replayed against another instance. */
export function modelDirectiveSecret(deploymentId: string): string {
  return createHmac("sha256", decodeKey(process.env.HARNESST_SECRETS_KEY))
    .update(`harnesst:model-directive\0${deploymentId}`)
    .digest("hex");
}

export function signModelDirective(
  directive: ModelDirective,
  deploymentId: string,
  body: string,
): string {
  const secret = modelDirectiveSecret(deploymentId);
  const signature = createHmac("sha256", secret)
    .update(modelDirectiveSignaturePayload(directive, body))
    .digest("hex");
  return buildModelDirective(directive, signature);
}

/** Exported for a deterministic server-side regression test of the generated-code contract. */
export function verifyModelDirectiveSignature(
  directive: ModelDirective,
  deploymentId: string,
  body: string,
  signature: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", modelDirectiveSecret(deploymentId))
    .update(modelDirectiveSignaturePayload(directive, body))
    .digest();
  const received = Buffer.from(signature, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
