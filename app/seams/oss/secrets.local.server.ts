/**
 * OSS SecretsProvider: AES-256-GCM sealed values behind a KV store (secret-store.ts). Managed
 * swaps this for KMS/Vault behind the same seam. Plaintext never touches the repo or logs
 * (PRD §7.2).
 *
 * The provider is a factory over (KV store, key) so its scoping/override logic is unit-tested
 * with an in-memory KV and a fixed key. `localSecretsProvider` binds the Drizzle KV + the
 * env-supplied key for production.
 */
import type { SecretsProvider, SecretWriteMeta } from "../types";
import { decodeKey, fingerprint, open, seal } from "./secretbox";
import { drizzleSecretKV, type SecretKVStore } from "./secret-store";

export function makeLocalSecretsProvider(
  kv: SecretKVStore,
  getKey: () => Buffer,
): SecretsProvider {
  return {
    name: "local-encrypted",

    async set(ref, value, meta?: SecretWriteMeta) {
      // Fingerprint is computed in the SAME code path as seal (§4.1) — full SHA-256 hex of the
      // plaintext, so the metadata index can show "fp a3f9c2" without ever revealing the value.
      await kv.upsert(ref, seal(getKey(), value), {
        fingerprint: fingerprint(value),
        sandboxExposed: meta?.sandboxExposed,
        updatedBy: meta?.updatedBy ?? null,
      });
    },

    async get(ref) {
      const sealed = await kv.getSealed(ref);
      return sealed ? open(getKey(), sealed) : null;
    },

    async delete(ref) {
      await kv.delete(ref);
    },

    async listNames(scope) {
      return kv.listKeys(scope);
    },

    async resolve(scope) {
      // Rows come back agent-wide first, then env-scoped, so env values override by key.
      const rows = await kv.listForResolve(scope);
      const out: Record<string, string> = {};
      for (const row of rows) out[row.key] = open(getKey(), row);
      return out;
    },
  };
}

export const localSecretsProvider = makeLocalSecretsProvider(drizzleSecretKV, () =>
  decodeKey(process.env.HARNESST_SECRETS_KEY),
);
