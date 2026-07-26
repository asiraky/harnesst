/**
 * Gmail connection (harnesst marketplace connector, issues #30, #165).
 *
 * eve's `defineOpenAPIConnection` turns each operation in the vendored OpenAPI spec into a tool
 * (`gmail__messages_list`, `gmail__messages_get`, `gmail__messages_send`, …). eve sends the token
 * as `Authorization: Bearer <token>`, caches it per step, and refreshes ahead of `expiresAt` — so
 * `getToken` below just exchanges the long-lived refresh token for a short-lived access token.
 *
 * The env vars are provisioned by harnesst at DEPLOY time from the agent's Google connection grant:
 * `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are the operator's shared OAuth client,
 * `GOOGLE_OAUTH_REFRESH_TOKEN` is the per-agent grant. There is no control-plane dependency at
 * runtime: refresh happens directly against Google.
 *
 * Permission levels (issue #165): this template declares selectable scope groups (Read mail /
 * Manage labels / Send mail), so the grant may cover only a subset of the spec's operations.
 * `GOOGLE_OAUTH_SCOPES` — also injected at deploy — carries the scopes the account actually
 * GRANTED, and the connection description below reflects it so the agent knows its level up
 * front instead of discovering a 403 mid-task. When the var is absent (self-managed env), every
 * capability is assumed.
 *
 * Spec placement: the OpenAPI document is vendored as `data/gmail.openapi.json` (a plain, inert
 * data file — kept OUT of `connections/` so eve only ever treats the `.ts` module here as a
 * connection) and imported as an inline object. It is a hand-authored, trimmed OpenAPI 3.0 spec
 * covering profile, message search/read/attachments, label listing + modify, threads, and send.
 */
import { defineOpenAPIConnection } from "eve/connections";

import spec from "../data/gmail.openapi.json";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Exchange the refresh token for a fresh access token. eve caches + pre-refreshes from expiresAt. */
async function getToken(): Promise<{ token: string; expiresAt: number }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Gmail connection is not configured — GOOGLE_OAUTH_CLIENT_ID / " +
        "GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN are injected by harnesst at deploy " +
        "from the agent's Google connection. Reconnect Google from the Deployment tab.",
    );
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Google refused the token refresh (HTTP ${res.status})${body ? `: ${body}` : "."} ` +
        "If this persists, reconnect Google from the agent's Deployment tab.",
    );
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Google's refresh response had no access_token.");
  const ttlMs = (json.expires_in ?? 3599) * 1000;
  // Expire 60s early so eve refreshes before Google actually rejects the token.
  return { token: json.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
}

/**
 * The permission level this instance actually holds, read from the granted scopes harnesst injects
 * (`GOOGLE_OAUTH_SCOPES`, issue #165). Unset (self-managed env) → assume everything.
 */
function grantedCapabilities(): { read: boolean; labels: boolean; send: boolean } {
  const scopes = (process.env.GOOGLE_OAUTH_SCOPES ?? "").split(/\s+/).filter(Boolean);
  if (scopes.length === 0) return { read: true, labels: true, send: true };
  const has = (s: string) => scopes.includes(s);
  const labels = has("https://www.googleapis.com/auth/gmail.modify");
  return {
    // gmail.modify includes read access, so either scope enables reading.
    read: labels || has("https://www.googleapis.com/auth/gmail.readonly"),
    labels,
    send: has("https://www.googleapis.com/auth/gmail.send"),
  };
}

const caps = grantedCapabilities();
const enabled = [
  caps.read ? "read/search mail and attachments" : null,
  caps.labels ? "modify labels (mark read, archive, file)" : null,
  caps.send ? "send mail" : null,
].filter(Boolean);

export default defineOpenAPIConnection({
  spec: spec as unknown as Record<string, unknown>,
  description:
    "Gmail v1 — the connected Google account's mailbox. Always pass userId 'me'. Use " +
    "gmail__messages_list (Gmail search syntax) then gmail__messages_get to read mail, " +
    "gmail__messages_attachments_get for attachment bytes, gmail__messages_modify for labels, " +
    "and gmail__messages_send (base64url RFC 2822 'raw') to send. " +
    (enabled.length > 0
      ? `This connection is authorized to: ${enabled.join("; ")}. ` +
        "Operations outside that level fail with 403 — don't attempt or promise them."
      : "This connection has no Gmail permissions granted yet — reconnect it from the Deployment tab."),
  auth: { getToken },
});
