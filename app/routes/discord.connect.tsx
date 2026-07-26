/**
 * "Connect Discord" — step 1 of the one-click Discord flow (issue #32).
 *
 * Signs a (project, agent, environment) state and redirects the user to Discord's OAuth
 * authorize screen for harnesst's shared app (`bot applications.commands`). After they pick a
 * server and approve, Discord returns to /discord/callback, which registers the agent's slash
 * command. Mirrors the GitHub App manifest flow's start route.
 */
import { sessionLoader } from "~/auth/session.server";
import { MessageSquare } from "lucide-react";
import { Link, data, redirect, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { getDiscordAppConfig } from "~/discord/config.server";
import {
  CONNECT_STATE_TTL_MS,
  connectStateKey,
  discordAuthorizeUrl,
  ensureInteractionsEndpoint,
  INTERACTIONS_ROUTE,
  signConnectState,
} from "~/discord/connect.server";
import { createOAuthStateNonce } from "~/connections/oauth-state.server";
import { listAgents, listAgentEnvironments } from "~/db/queries.server";
import { ensureTeamEnvironments } from "~/deploy/environments.server";
import { isLocalOrigin, publicOrigin } from "~/lib/ingress";
import { contextPath } from "~/lib/paths";
import { noindexMeta } from "~/lib/seo";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/discord.connect";

interface DiscordConnectData {
  error: string;
  backUrl: string;
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<DiscordConnectData> => {
      const url = new URL(args.request.url);
      const projectId = url.searchParams.get("project") ?? "";
      const agentName = url.searchParams.get("agent") ?? "";
      const envId = url.searchParams.get("env");

      const project = await requireProject(auth, projectId);

      const roster = (await listAgents(project.id)).filter(
        (a) => a.kind === "member",
      );
      const agent = roster.find((a) => a.name === agentName);
      if (!agent) throw data("Unknown agent", { status: 404 });

      const memberSegment = roster.length > 1 ? agent.name : null;
      const backUrl = `${contextPath(project.id, memberSegment)}/deployment`;

      const config = getDiscordAppConfig();
      if (!config) {
        return {
          error:
            "This harnesst installation has no Discord app configured. An operator must set " +
            "HARNESST_DISCORD_APPLICATION_ID, HARNESST_DISCORD_BOT_TOKEN, and HARNESST_DISCORD_PUBLIC_KEY " +
            "on the control plane (see the self-host docs) before Discord can be connected.",
          backUrl,
        };
      }

      // The connection needs an environment to route to, so ensure the agent has one.
      let envs = await listAgentEnvironments(agent.id);
      if (envs.length === 0) {
        await ensureTeamEnvironments(project.id);
        envs = await listAgentEnvironments(agent.id);
      }
      const env = envs.find((e) => e.id === envId) ?? envs[0] ?? null;
      if (!env) {
        return {
          error:
            "This agent has no environment yet — create one on the Deployment tab first.",
          backUrl,
        };
      }

      // Self-register the app's Interactions Endpoint URL — the one Developer Portal setting
      // nothing else automates; without it Discord never delivers a single interaction and
      // slash commands time out. Best-effort: an operator-managed portal setup (or a Discord
      // hiccup) must not block connecting a server. Skipped in local dev, where Discord's
      // validation PING can't reach the origin.
      const origin = publicOrigin(args.request);
      if (!isLocalOrigin(origin)) {
        try {
          await ensureInteractionsEndpoint(
            config,
            `${origin}${INTERACTIONS_ROUTE}`,
          );
        } catch (err) {
          console.warn("[discord] interactions endpoint registration:", err);
        }
      }

      // Bind the round-trip to this user + session and record a single-use nonce, mirroring the
      // Google connect flow: a leaked or replayed callback can't complete in another session.
      const exp = Date.now() + CONNECT_STATE_TTL_MS;
      const nonce = await createOAuthStateNonce({
        userId: auth.user.id,
        sessionId: auth.session.id,
        expiresAt: new Date(exp),
      });
      const state = signConnectState(
        {
          projectId: project.id,
          agentId: agent.id,
          environmentId: env.id,
          userId: auth.user.id,
          sessionId: auth.session.id,
          nonce,
          exp,
        },
        connectStateKey(),
      );
      const redirectUri = `${origin}/discord/callback`;
      throw redirect(
        discordAuthorizeUrl({
          applicationId: config.applicationId,
          redirectUri,
          state,
        }),
      );
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Connect Discord · harnesst" }, ...noindexMeta];
}

export default function DiscordConnect({ loaderData }: Route.ComponentProps) {
  const { error, backUrl } = loaderData;
  return (
    <AppShell>
      <PageHeader
        icon={MessageSquare}
        accent="brand"
        title="Connect Discord"
        description="Add this agent to a Discord server."
        actions={
          <Button variant="ghost" asChild>
            <Link to={backUrl}>← Back</Link>
          </Button>
        }
      />
      <Alert variant="destructive">
        <AlertTitle>Can&rsquo;t start the Discord connect flow</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    </AppShell>
  );
}
