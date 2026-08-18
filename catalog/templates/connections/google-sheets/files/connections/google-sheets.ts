/**
 * Google Sheets connection (harnesst marketplace connector, issue #30).
 *
 * eve's `defineOpenAPIConnection` turns each operation in the vendored OpenAPI spec into a tool
 * (`google_sheets__spreadsheets_values_get`, `…_append`, …). eve sends the token as
 * `Authorization: Bearer <token>`, caches it per step, and refreshes ahead of `expiresAt` — so
 * `getToken` below just exchanges the long-lived refresh token for a short-lived access token.
 *
 * The three env vars are provisioned by harnesst at DEPLOY time from the agent's Google connection
 * grant: `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are the operator's shared OAuth
 * client, `GOOGLE_OAUTH_REFRESH_TOKEN` is the per-agent grant captured at install. There is no
 * control-plane dependency at runtime: refresh happens directly against Google.
 *
 * Spec placement: the OpenAPI document is vendored as `data/google-sheets.openapi.json` (a plain,
 * inert data file — kept OUT of `connections/` so eve only ever treats the `.ts` module here as a
 * connection) and imported as an inline object, which `defineOpenAPIConnection`'s `spec` accepts.
 * It is a hand-authored, trimmed OpenAPI 3.0 spec covering the core spreadsheet + values
 * operations (get/create/batchUpdate and values get/batchGet/update/append/clear/batchUpdate).
 */
import { defineOpenAPIConnection } from "eve/connections";

import spec from "../data/google-sheets.openapi.json" with { type: "json" };

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Exchange the refresh token for a fresh access token. eve caches + pre-refreshes from expiresAt. */
async function getToken(): Promise<{ token: string; expiresAt: number }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Sheets connection is not configured — GOOGLE_OAUTH_CLIENT_ID / " +
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

export default defineOpenAPIConnection({
  spec: spec as unknown as Record<string, unknown>,
  description:
    "Google Sheets v4 — read and write spreadsheet cells and metadata for the connected Google " +
    "account. Use google_sheets__spreadsheets_values_get / _batchGet to read, _update / _append " +
    "to write cell values, and _batchUpdate (spreadsheets:batchUpdate) for structural changes " +
    "(add sheets, formatting). Ranges use A1 notation, e.g. 'Sheet1!A1:C10'. Every call returns " +
    "{ status, statusText, body } and a failed call is NOT a tool error — check status before " +
    "reading body. 429/5xx (Google's 'UNAVAILABLE') means the call went unanswered: retry with " +
    "backoff over minutes, and never report a failed read as an empty result.",
  auth: { getToken },
});
