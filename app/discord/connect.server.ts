/**
 * Discord one-click connect (issue #32) — the pure shapes plus the bot-token network calls.
 *
 * harnesst owns ONE Discord app per installation. A user authorizes it into their server
 * (`bot applications.commands` scopes); harnesst then registers a guild slash command named after
 * the agent (`/agent-name message:…`, eve's prompt-extraction convention) and binds the
 * (guild, command) to the agent. There is NO OAuth token exchange — the connect proof is that
 * the bot-token command registration succeeds (a forged callback fails at Discord with 403),
 * so no client secret is needed.
 *
 * The state token round-tripped through Discord is an HMAC-signed (project, agent, environment)
 * binding with an expiry — a clone of the GitHub manifest-state pattern, keyed by the same
 * tenant-wide secrets key. Everything shape-like is exported pure so tests assert the literals;
 * only the `*GuildCommand` / `fetchGuildName` helpers touch the network (via an injected fetch).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { decodeKey } from "~/seams/oss/secretbox";

/** The eve Discord channel's route inside a deployed instance (see the channel template). */
export const DISCORD_CHANNEL_ROUTE = "/eve/v1/discord";

/** Discord's REST API base. */
export const DISCORD_API = "https://discord.com/api/v10";

/**
 * Bot permissions requested at authorize time: View Channels (1024) + Send Messages (2048) +
 * Manage Webhooks (536870912). Manage Webhooks is included now so a later per-agent
 * webhook-identity polish pass won't require users to re-authorize.
 */
export const DISCORD_BOT_PERMISSIONS = 536873984;

/* ─────────────────────────── state token (pure given key) ─────────────────────────── */

export interface ConnectState {
  projectId: string;
  agentId: string;
  environmentId: string;
  /** Better Auth user + session that started the flow — the callback must match both. */
  userId: string;
  sessionId: string;
  /** Random server-recorded nonce consumed atomically by the callback (single use). */
  nonce: string;
  /** Unix ms after which the token is dead. */
  exp: number;
}

export const CONNECT_STATE_TTL_MS = 60 * 60 * 1000;

const b64url = (buf: Buffer) => buf.toString("base64url");

function stateSignature(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** `base64url(payload).base64url(hmac)` — bound to the agent, expiring, tamper-evident. */
export function signConnectState(state: ConnectState, key: Buffer): string {
  const payload = b64url(Buffer.from(JSON.stringify(state), "utf8"));
  return `${payload}.${b64url(stateSignature(payload, key))}`;
}

/** Verify signature + expiry; null on anything off (never throws on malformed input). */
export function verifyConnectState(
  token: string,
  key: Buffer,
  now: number = Date.now(),
): ConnectState | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = stateSignature(payload, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      typeof parsed?.projectId !== "string" ||
      typeof parsed?.agentId !== "string" ||
      typeof parsed?.environmentId !== "string" ||
      typeof parsed?.userId !== "string" ||
      typeof parsed?.sessionId !== "string" ||
      typeof parsed?.nonce !== "string" ||
      typeof parsed?.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp <= now) return null;
    return parsed as ConnectState;
  } catch {
    return null;
  }
}

/** The HMAC key: the same tenant-wide key that seals secrets (no new key to provision). */
export function connectStateKey(): Buffer {
  return decodeKey(process.env.EDEN_SECRETS_KEY);
}

/* ─────────────────────────────── command name (pure) ─────────────────────────────── */

/**
 * Slugify an agent name into a Discord command name: lowercase, only `[a-z0-9_-]`, 1–32 chars.
 * Non-matching runs collapse to `-`; a name that reduces to empty falls back to `agent`.
 */
export function discordCommandName(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32)
    .replace(/[-_]+$/g, "");
  return slug || "agent";
}

/* ─────────────────────────────── authorize URL (pure) ─────────────────────────────── */

export interface AuthorizeUrlInput {
  applicationId: string;
  redirectUri: string;
  state: string;
  permissions?: number;
}

/**
 * The Discord OAuth authorize URL. `bot applications.commands` scopes install the shared app
 * into the picked server; `response_type=code` + a redirect brings the user back to the
 * callback (harnesst never exchanges the code — the command registration is the connect proof).
 */
export function discordAuthorizeUrl(input: AuthorizeUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.applicationId,
    scope: "bot applications.commands",
    permissions: String(input.permissions ?? DISCORD_BOT_PERMISSIONS),
    response_type: "code",
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/* ─────────────────────────────── command registration (network) ─────────────────────── */

export interface GuildCommandInput {
  applicationId: string;
  botToken: string;
  guildId: string;
  commandName: string;
  description: string;
}

/**
 * Register (upsert) the agent's guild slash command: a CHAT_INPUT command with one required
 * string option named `message` — eve's prompt-extraction convention (`/name message:…`).
 * Discord upserts by name, so a reconnect is idempotent. Returns the command id. Throws a
 * readable Error (including Discord's body) on non-2xx; a 403 means the OAuth didn't actually
 * install the bot — which is also the implicit authorization proof (no token exchange).
 */
export async function registerGuildCommand(
  input: GuildCommandInput,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(
    `${DISCORD_API}/applications/${input.applicationId}/guilds/${input.guildId}/commands`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${input.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: input.commandName,
        description: input.description,
        type: 1,
        options: [
          {
            type: 3,
            name: "message",
            description: "What to ask the agent",
            required: true,
          },
        ],
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discord rejected the slash-command registration (HTTP ${res.status})` +
        (res.status === 403
          ? " — the app wasn't installed into the server. Re-run Connect Discord and approve the authorization."
          : "") +
        (body ? `: ${body}` : "."),
    );
  }
  const command = (await res.json()) as { id?: string };
  if (!command.id) {
    throw new Error("Discord's command response is missing an id.");
  }
  return command.id;
}

/** The guild's display name (best-effort, display-only) — null on any failure. */
export async function fetchGuildName(
  config: { botToken: string },
  guildId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${DISCORD_API}/guilds/${guildId}`, {
      headers: { authorization: `Bot ${config.botToken}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string };
    return body.name ?? null;
  } catch {
    return null;
  }
}

/** The control plane's interactions relay route — what Discord's endpoint URL must point at. */
export const INTERACTIONS_ROUTE = "/api/discord/interactions";

/**
 * Ensure the shared app's Interactions Endpoint URL points at this installation's relay —
 * the one Discord-side setting the operator would otherwise have to click through the
 * Developer Portal for. Reads the app first and PATCHes only on drift, because a PATCH makes
 * Discord re-validate the endpoint with a signed PING each time. Throws a readable Error on
 * non-2xx (a failed PATCH usually means Discord's validation PING couldn't reach the origin).
 */
export async function ensureInteractionsEndpoint(
  config: { applicationId: string; botToken: string },
  endpointUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"unchanged" | "updated"> {
  const headers = { authorization: `Bot ${config.botToken}` };
  const current = await fetchImpl(`${DISCORD_API}/applications/@me`, {
    headers,
  });
  if (!current.ok) {
    throw new Error(
      `Discord rejected the application lookup (HTTP ${current.status}).`,
    );
  }
  const app = (await current.json()) as { interactions_endpoint_url?: string };
  if (app.interactions_endpoint_url === endpointUrl) return "unchanged";

  const res = await fetchImpl(`${DISCORD_API}/applications/@me`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ interactions_endpoint_url: endpointUrl }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discord rejected the interactions endpoint URL (HTTP ${res.status}) — ` +
        `it validates the URL with a signed PING, so ${endpointUrl} must be publicly ` +
        `reachable${body ? `: ${body}` : "."}`,
    );
  }
  return "updated";
}

export interface DeleteGuildCommandInput {
  applicationId: string;
  botToken: string;
  guildId: string;
  commandId: string;
}

/** Remove a registered guild command (disconnect). Tolerates 404 (already gone). */
export async function deleteGuildCommand(
  input: DeleteGuildCommandInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${DISCORD_API}/applications/${input.applicationId}/guilds/${input.guildId}/commands/${input.commandId}`,
    { method: "DELETE", headers: { authorization: `Bot ${input.botToken}` } },
  );
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discord rejected the command deletion (HTTP ${res.status})${body ? `: ${body}` : "."}`,
    );
  }
}
