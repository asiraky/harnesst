/**
 * Discord connect callback — step 2 of the one-click Discord flow (issue #32).
 *
 * Discord redirects here after the user authorizes harnesst's shared app into a server, with the
 * signed `?state=`, the `?guild_id=`, and a `?code=` (which harnesst never exchanges — the connect
 * proof is that the bot-token command registration below succeeds). The loader verifies the
 * state + tenancy, refuses a slash-command name already claimed by another agent in that guild,
 * registers the agent's guild command, records the connection, and sends the user back to the
 * Deployment tab. Mirrors the GitHub App manifest callback's readable-error (`fail`) pattern.
 */
import { sessionLoader } from "~/auth/session.server";
import { MessageSquare } from "lucide-react";
import { Link, redirect, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { listAgents } from "~/db/queries.server";
import { getDiscordAppConfig } from "~/discord/config.server";
import {
  connectStateKey,
  discordCommandName,
  fetchGuildName,
  registerGuildCommand,
  verifyConnectState,
} from "~/discord/connect.server";
import { consumeOAuthStateNonce } from "~/connections/oauth-state.server";
import {
  findConnectionByGuildCommand,
  upsertConnection,
} from "~/discord/connections.server";
import { contextPath } from "~/lib/paths";
import { noindexMeta } from "~/lib/seo";
import { requireProject } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/discord.callback";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const url = new URL(args.request.url);
      const stateToken = url.searchParams.get("state");
      const guildId = url.searchParams.get("guild_id");
      const oauthError = url.searchParams.get("error");

      const fail = (error: string, backUrl = "/dashboard") => ({
        error,
        backUrl,
      });

      if (oauthError) {
        return fail(
          "Discord authorization was cancelled or denied — the agent was not connected. " +
            "Start again from the agent's Deployment tab.",
        );
      }
      if (!stateToken || !guildId) {
        return fail(
          "Discord didn't send back the server — the agent was not connected. Start again " +
            "from the agent's Deployment tab.",
        );
      }
      const state = verifyConnectState(stateToken, connectStateKey());
      if (!state) {
        return fail(
          "This link is invalid or has expired (it lives one hour). Start again from the " +
            "agent's Deployment tab.",
        );
      }
      if (
        state.userId !== auth.user.id ||
        state.sessionId !== auth.session.id
      ) {
        return fail(
          "This Discord connection was started in a different harnesst session. Start again from " +
            "the agent's Deployment tab.",
        );
      }

      // Consume before registering the command. DELETE ... RETURNING makes concurrent
      // callbacks race safely: exactly one request can proceed, even across replicas.
      const consumed = await consumeOAuthStateNonce({
        nonce: state.nonce,
        userId: auth.user.id,
        sessionId: auth.session.id,
      });
      if (!consumed) {
        return fail(
          "This Discord connection link is invalid, expired, or has already been used. Start " +
            "again from the agent's Deployment tab.",
        );
      }

      // Tenancy: the signed state names the project, but the SESSION must own it too.
      const project = await requireProject(auth, state.projectId);
      const roster = (await listAgents(project.id)).filter(
        (a) => a.kind === "member",
      );
      const agent = roster.find((a) => a.id === state.agentId);
      const backUrl = `${contextPath(
        project.id,
        roster.length > 1 && agent ? agent.name : null,
      )}/deployment`;
      if (!agent) {
        return fail("This agent no longer exists in the project.", backUrl);
      }

      const config = getDiscordAppConfig();
      if (!config) {
        return fail(
          "This harnesst installation no longer has a Discord app configured — ask an operator " +
            "to set the EDEN_DISCORD_* env vars.",
          backUrl,
        );
      }

      // Same-name collision: a slash command name is unique within a server. If another agent
      // already owns this name in this guild, refuse (issue #32's stated collision case).
      const commandName = discordCommandName(agent.name);
      const existing = await findConnectionByGuildCommand(guildId, commandName);
      if (existing && existing.agentId !== agent.id) {
        return fail(
          `/${commandName} in this Discord server is already connected to another agent. ` +
            "Rename one of the agents, or disconnect the other agent from this server first.",
          backUrl,
        );
      }

      // Register the guild command with the shared bot token. A failure here (e.g. 403) means
      // the authorization didn't actually install the bot — surface it readably.
      let commandId: string;
      try {
        commandId = await registerGuildCommand({
          applicationId: config.applicationId,
          botToken: config.botToken,
          guildId,
          commandName,
          description: `Ask ${agent.name}`,
        });
      } catch (error) {
        return fail((error as Error).message, backUrl);
      }

      const guildName = await fetchGuildName(config, guildId);

      await upsertConnection({
        projectId: project.id,
        agentId: agent.id,
        environmentId: state.environmentId,
        guildId,
        guildName,
        commandName,
        commandId,
      });

      await getRuntime().data.audit.record({
        orgId: project.orgId,
        actorUserId: auth.user.id,
        action: "discord.connect",
        target: agent.name,
        meta: { guildId, guildName, commandName },
      });

      throw redirect(backUrl);
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Connect Discord · harnesst" }, ...noindexMeta];
}

export default function DiscordCallback({ loaderData }: Route.ComponentProps) {
  const { error, backUrl } = loaderData;
  return (
    <AppShell>
      <PageHeader
        icon={MessageSquare}
        accent="brand"
        title="Connect Discord"
        description="Something went wrong while connecting Discord."
        actions={
          <Button variant="ghost" asChild>
            <Link to={backUrl}>← Back</Link>
          </Button>
        }
      />
      <Alert variant="destructive">
        <AlertTitle>Discord connect failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    </AppShell>
  );
}
