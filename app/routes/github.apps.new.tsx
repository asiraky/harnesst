/**
 * "Create GitHub App for this agent" — step 1 of the per-agent Manifest flow (issue #26).
 *
 * Renders a summary of what the App will be granted and a plain HTML form that POSTs the
 * manifest to GitHub (`https://github.com/settings/apps/new?state=…`, or the organization
 * variant when the user names an org). GitHub shows ONE confirmation screen with an editable
 * app-name field, then redirects to /github/apps/callback with a single-use `?code=`.
 *
 * The `state` carried through GitHub is an HMAC-signed (project, agent, environment) binding
 * with an expiry — the callback verifies it before touching anything.
 */
import { sessionLoader } from "~/auth/session.server";
import { Webhook } from "lucide-react";
import { useState } from "react";
import { Link, data, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader, accentText } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { listAgents, listAgentEnvironments } from "~/db/queries.server";
import { ensureTeamEnvironments } from "~/deploy/environments.server";
import {
  GITHUB_CHANNEL_ROUTE,
  MANIFEST_STATE_TTL_MS,
  buildAppManifest,
  defaultAppName,
  manifestStateKey,
  signManifestState,
} from "~/github/app-manifest.server";
import { createOAuthStateNonce } from "~/connections/oauth-state.server";
import { envIngressUrl, isLocalOrigin, publicOrigin } from "~/lib/ingress";
import { contextPath } from "~/lib/paths";
import { noindexMeta } from "~/lib/seo";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/github.apps.new";

interface GitHubAppNewData {
  error: string | null;
  backUrl: string;
  agentName: string;
  projectName: string;
  form: {
    manifestJson: string;
    state: string;
    appName: string;
    webhookUrl: string;
    envName: string;
    localOrigin: boolean;
  } | null;
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<GitHubAppNewData> => {
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

      // The manifest needs the environment's webhook URL, so the agent must have an env row.
      // ensureTeamEnvironments is the idempotent invariant-repair — a member always ends up
      // with at least the team's env set (or "default").
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
          backUrl: `${contextPath(project.id, roster.length > 1 ? agent.name : null)}/deployment`,
          agentName: agent.name,
          projectName: project.name,
          form: null,
        };
      }

      const origin = publicOrigin(args.request);
      const memberSegment = roster.length > 1 ? agent.name : null;
      const deploymentUrl = `${origin}${contextPath(project.id, memberSegment)}/deployment`;
      const webhookUrl = envIngressUrl(origin, env.id, GITHUB_CHANNEL_ROUTE);

      // Bind the round-trip to this user + session and record a single-use nonce, mirroring the
      // Google connect flow: a leaked or replayed callback can't complete in another session.
      const exp = Date.now() + MANIFEST_STATE_TTL_MS;
      const nonce = await createOAuthStateNonce({
        userId: auth.user.id,
        sessionId: auth.session.id,
        expiresAt: new Date(exp),
      });
      const state = signManifestState(
        {
          projectId: project.id,
          agentId: agent.id,
          environmentId: env.id,
          userId: auth.user.id,
          sessionId: auth.session.id,
          nonce,
          exp,
        },
        manifestStateKey(),
      );

      const manifestInput = {
        name: defaultAppName(agent.name, project.slug ?? project.name),
        homepageUrl: deploymentUrl,
        webhookUrl,
        redirectUrl: `${origin}/github/apps/callback`,
        setupUrl: deploymentUrl,
        description: `${agent.name} — a harnesst agent. @mention it in issues and pull-request comments.`,
      };
      const manifest = buildAppManifest(manifestInput);

      return {
        error: null,
        backUrl: `${contextPath(project.id, memberSegment)}/deployment`,
        agentName: agent.name,
        projectName: project.name,
        form: {
          manifestJson: JSON.stringify(manifest),
          state,
          appName: manifest.name,
          webhookUrl,
          envName: env.name,
          localOrigin: isLocalOrigin(origin),
        },
      };
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Create GitHub App · harnesst" }, ...noindexMeta];
}

export default function GitHubAppNew({ loaderData }: Route.ComponentProps) {
  const { error, backUrl, agentName, form } = loaderData;
  const [organization, setOrganization] = useState("");

  // Pure string concat mirroring manifestSubmitUrl (a .server module can't reach the client
  // bundle). The org variant registers the App under a GitHub organization instead of the
  // signed-in user.
  const submitUrl = form
    ? `${
        organization.trim()
          ? `https://github.com/organizations/${encodeURIComponent(organization.trim())}/settings/apps/new`
          : "https://github.com/settings/apps/new"
      }?state=${encodeURIComponent(form.state)}`
    : "";

  return (
    <AppShell>
      <PageHeader
        icon={Webhook}
        accent="brand"
        title="Create GitHub App"
        description={`Mint ${agentName}'s own GitHub App — its @mention identity and its credential for the repositories you install it on.`}
        actions={
          <Button variant="ghost" asChild>
            <Link to={backUrl}>← Back</Link>
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Can&rsquo;t start the GitHub App flow</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {form && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Webhook
                className={`size-4 shrink-0 ${accentText.brand}`}
                aria-hidden
              />
              Create the App on GitHub
            </CardTitle>
            <CardDescription>
              GitHub shows a confirmation page — the app name is editable there
              and must be unique across GitHub. Approve it, and harnesst stores
              the App&rsquo;s credentials as {agentName}&rsquo;s secrets and
              sends you to pick the repositories it watches.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1 text-sm">
              <p>
                <span className="font-medium">Proposed name:</span>{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">
                  {form.appName}
                </code>
              </p>
              <p>
                <span className="font-medium">Webhook ({form.envName}):</span>{" "}
                <code className="break-all rounded bg-muted px-1.5 py-0.5">
                  {form.webhookUrl}
                </code>
              </p>
              <p className="text-muted-foreground">
                Permissions: issues &amp; pull requests (read/write, the
                conversation), contents (read/write, so the agent can branch and
                push), metadata (read). Events: issue comments and pull-request
                review comments.
              </p>
            </div>

            {form.localOrigin && (
              <Alert>
                <AlertTitle>Local development origin</AlertTitle>
                <AlertDescription>
                  The webhook URL points at localhost, which GitHub can&rsquo;t
                  reach. The App will still be created and its credentials
                  stored — expose harnesst through a tunnel and update the
                  App&rsquo;s webhook URL for live mentions.
                </AlertDescription>
              </Alert>
            )}

            <form method="post" action={submitUrl} className="space-y-4">
              <input type="hidden" name="manifest" value={form.manifestJson} />
              <div className="space-y-1.5">
                <Label htmlFor="organization">
                  GitHub organization (optional)
                </Label>
                <Input
                  id="organization"
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  placeholder="my-org"
                  className="w-full font-mono sm:w-72"
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank to create the App under your personal account, or
                  name an organization you own to create it there. Either way
                  you choose which repositories it can reach when you install
                  it.
                </p>
              </div>
              <Button type="submit">Continue to GitHub</Button>
            </form>

            <p className="text-xs text-muted-foreground">
              Prefer to set it up by hand? The manual steps are in the GitHub
              channel&rsquo;s setup notes.
            </p>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}
