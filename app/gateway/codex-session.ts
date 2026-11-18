/**
 * The session id the gateway sends upstream to Codex, which is also the request's
 * `prompt_cache_key`.
 *
 * The Codex CLI sends its session id as a `session-id` header and as `prompt_cache_key` in the
 * body ("ChatGPT derives cache affinity from the Responses session-id header",
 * codex-rs/core/src/client.rs). A new id on every call means every call misses the cache, so the
 * id is derived from the agent's eve session (the `x-harnesst-session` header, issue #416). Every
 * step of a session then shares one id, and so can share a cached prefix.
 *
 * The id is a hash of org and session, formatted as a UUID like the CLI's own ids. The hash scopes
 * it to the org, which is known from the gateway token, and keeps a header value that came from
 * the caller out of the upstream request. A call without the header gets a fresh random id, as
 * every call did before.
 */
import { createHash, randomUUID } from "node:crypto";

export function codexSessionId(
  orgId: string,
  eveSessionId: string | null,
  random: () => string = randomUUID,
): string {
  if (!eveSessionId) return random();
  const hex = createHash("sha256").update(`${orgId}\n${eveSessionId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
