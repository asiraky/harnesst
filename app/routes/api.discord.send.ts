/**
 * Discord send proxy (issue #32). The `discord-send-message` tool can't hold the shared bot
 * token, so it POSTs `{ channelId, message }` here with `Authorization: Bearer <EDEN_TEAM_TOKEN>`
 * (the same delegation token the team relay uses). The token authenticates the CALLER
 * DEPLOYMENT; the control plane resolves its agent, confirms the target channel's server is one
 * the agent is connected to, and sends with the bot token. This confines the shared token to
 * servers the calling agent actually reaches. Bad token → 401; business outcomes → 200
 * `{ ok:false }` so the tool surfaces the text. Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { getDiscordAppConfig } from "~/discord/config.server";
import { DISCORD_API } from "~/discord/connect.server";
import { listConnectionsForAgent } from "~/discord/connections.server";
import { isGuildAllowed, validateSendPayload } from "~/discord/send.server";
import { getRuntime } from "~/seams/index.server";
import { verifyDelegationToken } from "~/team/token.server";

export async function action({ request }: ActionFunctionArgs) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  const config = getDiscordAppConfig();
  if (!config) {
    return data(
      {
        ok: false,
        error: "Discord sending is not configured for this deployment.",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return data({
      ok: false,
      error: "Send a JSON body with `channelId` and `message`.",
    });
  }
  const valid = validateSendPayload(body);
  if (!valid.ok) return data({ ok: false, error: valid.error });
  const { channelId, message } = valid.value;

  // Resolve the caller from the token's deployment: deployment → env → agent.
  const store = getRuntime().data;
  const deployment = await store.deployments.findById(deploymentId);
  const env = deployment
    ? await store.environments.findById(deployment.environmentId)
    : null;
  const agent = env ? await store.agents.findById(env.agentId) : null;
  if (!agent) {
    return data({
      ok: false,
      error: "Your deployment is no longer known to harnesst.",
    });
  }

  // Guild-scoping: the channel's server must be one this agent is connected to.
  let channelGuildId: string | null = null;
  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}`, {
      headers: { authorization: `Bot ${config.botToken}` },
    });
    if (res.ok) {
      const channel = (await res.json()) as { guild_id?: string };
      channelGuildId = channel.guild_id ?? null;
    }
  } catch {
    channelGuildId = null;
  }
  const connections = await listConnectionsForAgent(agent.id);
  if (
    !isGuildAllowed(
      channelGuildId,
      connections.map((c) => c.guildId),
    )
  ) {
    return data(
      {
        ok: false,
        error:
          "This channel is in a server this agent isn't connected to. Connect the agent to " +
          "that server from its Deployment tab first.",
      },
      { status: 403 },
    );
  }

  // Send with the shared bot token, mentions disabled.
  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${config.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: message,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return data(
        {
          ok: false,
          error: `Discord rejected the message (HTTP ${res.status}).${detail ? ` ${detail}` : ""}`,
        },
        { status: 502 },
      );
    }
    const posted = (await res.json()) as { id?: string };
    return data({ ok: true, channelId, messageId: posted.id ?? null });
  } catch (error) {
    return data(
      {
        ok: false,
        error: `Couldn't reach Discord: ${(error as Error).message}`,
      },
      { status: 502 },
    );
  }
}
