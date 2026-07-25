/**
 * Invitation delivery tokens. The invitation email link carries `?token=` — an HMAC-signed
 * (invitationId, email) pair minted when the invitation email is sent. Invitation ids alone are
 * enumerable by organization members (CVE-2026-53514), so possessing the id proves nothing;
 * possessing this token proves the bearer received the email harnesst sent to the invited address.
 *
 * That proof-of-delivery is what lets the accept screen treat a signed-in invitee whose account
 * email matches the invited address as email-verified, without a second manual verification
 * round-trip. The organization plugin's `requireEmailVerificationOnInvitation` gate stays ON:
 * anyone who arrives with only the enumerable id (no token) still has to verify by email.
 *
 * Keyed by the same `EDEN_SECRETS_KEY` as the other signed-state flows (never a new env var);
 * pure over an injected key so mint/verify unit-test without env. No `exp` in the payload: the
 * invitation row carries its own expiry and Better Auth enforces it on get/accept, so a token
 * outlives its invitation harmlessly — it only ever attests delivery to the invited mailbox.
 */
import { decodeKey } from "~/seams/oss/secretbox";
import { signState, verifyState } from "~/lib/signed-state.server";

const PURPOSE = "org-invitation-delivery";

type InvitationTokenPayload = {
  purpose: typeof PURPOSE;
  invitationId: string;
  email: string;
};

/** The signing key — reuses the secrets key source (never a new env var). */
export function invitationTokenKey(): Buffer {
  return decodeKey(process.env.EDEN_SECRETS_KEY);
}

/** Mint the delivery token embedded in an invitation email link. */
export function mintInvitationToken(
  invitationId: string,
  email: string,
  key: Buffer = invitationTokenKey(),
): string {
  return signState<InvitationTokenPayload>(
    { purpose: PURPOSE, invitationId, email },
    key,
  );
}

/**
 * Verify a delivery token for a specific invitation. Returns the invited email the token was
 * minted for, or null when the token is malformed, tampered, signed for another purpose, or
 * bound to a different invitation. The caller must still compare the returned email to the
 * signed-in user's email before trusting delivery as mailbox proof for that account.
 */
export function verifyInvitationToken(
  token: string,
  invitationId: string,
  key: Buffer = invitationTokenKey(),
): { email: string } | null {
  const parsed = verifyState<InvitationTokenPayload>(token, key);
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.purpose !== PURPOSE) return null;
  if (typeof parsed.invitationId !== "string") return null;
  if (parsed.invitationId !== invitationId) return null;
  if (typeof parsed.email !== "string" || parsed.email.length === 0) {
    return null;
  }
  return { email: parsed.email };
}
