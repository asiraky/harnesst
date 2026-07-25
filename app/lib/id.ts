/**
 * ID generation — the one way to mint an identifier in harnesst.
 *
 * 12 chars from [a-z] via nanoid: URL-safe, no casing ambiguity in logs, and — crucially —
 * safe to drop verbatim into contexts that reject uppercase, chiefly Docker repository names
 * (see `lowercaseLegacyId`). Far shorter than a UUID while collision-proof at our scale
 * (26^12 ≈ 9.5e16; ~1% collision odds would need ~44 million ids). Works in server and
 * browser code.
 *
 * Convention: ALL identifiers — table PKs, client-side keys, external references — use
 * `newId()`, never crypto.randomUUID(). Every table PK we mint is
 * `varchar("id", { length: 12 }).primaryKey().$defaultFn(newId)` (Better Auth-owned identity
 * ids stay text). The column width enforces the format at the DB layer.
 */
import { customAlphabet } from "nanoid";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** Mint a new 12-char [a-z] id. */
export const newId = customAlphabet(ALPHABET, 12);

/**
 * Fold a possibly-legacy id to lowercase for a lowercase-only context (Docker repository
 * names, which reject uppercase). New ids from `newId` are already all-lowercase, so this is
 * a no-op for them — it exists ONLY to keep ids minted before the alphabet dropped uppercase
 * (mixed-case [a-zA-Z]) usable in those contexts. Delete once no such ids remain.
 */
export function lowercaseLegacyId(id: string): string {
  return id.toLowerCase();
}
