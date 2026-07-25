/**
 * Pure AES-256-GCM seal/open for the local secrets provider. No DB, no env — the 32-byte key
 * is passed in — so the crypto is unit-tested directly (round-trip, tamper-detection) while the
 * provider owns key resolution and persistence.
 */
import crypto from "node:crypto";

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Decode a 32-byte key from 64 hex chars or base64; throws if it isn't exactly 32 bytes. */
export function decodeKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      "HARNESST_SECRETS_KEY is not set. Provide a 32-byte key as 64 hex chars or base64 " +
        "(e.g. `openssl rand -hex 32`) to use the local secrets store.",
    );
  }
  const buf =
    raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("HARNESST_SECRETS_KEY must decode to exactly 32 bytes.");
  }
  return buf;
}

export function seal(key: Buffer, plaintext: string): SealedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Full SHA-256 hex of a plaintext value — a one-way fingerprint stored alongside the sealed
 * value's metadata (§4.1). Reveals nothing (the value is never recoverable from it) but lets a
 * human compare against a value they hold. Not keyed: comparison must work across key rotations.
 */
export function fingerprint(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function open(key: Buffer, sealed: SealedSecret): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
