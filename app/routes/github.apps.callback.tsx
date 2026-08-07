/**
 * Manifest-flow callback — step 2 of the per-agent GitHub App flow (issue #26).
 *
 * GitHub redirects here with a single-use `?code=` (valid one hour) and our signed `?state=`.
 * The raw URL is immediately staged into an encrypted HttpOnly cookie and left (the code
 * converts into the App's PEM private key — it must not survive in history/logs/referrers or a
 * rendered error document). On the clean follow-up request the loader verifies the state
 * (signature + expiry + user/session binding + single-use nonce + the session's org owns the
 * project), converts the code (`POST /app-manifests/{code}/conversions` — the ONLY time GitHub
 * hands over the `pem`/`webhook_secret`), writes the four channel secrets onto THAT agent, and
 * sends the user to `github.com/apps/<slug>/installations/new` to pick the repositories.
 * The slug always comes from the conversion response — GitHub derives it from the final
 * (possibly user-edited) name, never from what harnesst proposed.
 *
 * A slug/App-ID already held by ANOTHER agent in the project refuses the write (two agents
 * answering one @mention is ambiguous) — possible only via stale/manual credentials, since
 * GitHub enforces global App uniqueness for fresh conversions.
 */
import { sessionLoader } from "~/auth/session.server";
import { Webhook } from "lucide-react";
import { Link, redirect, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { listAgents } from "~/db/queries.server";
import { invalidateAgentEnvironments } from "~/deploy/env-reconcile.server";
import { consumeOAuthStateNonce } from "~/connections/oauth-state.server";
import {
  appInstallUrl,
  convertManifestCode,
  findAppCredentialConflict,
  listAppCredentialRows,
  manifestStateKey,
  verifyManifestState,
} from "~/github/app-manifest.server";
import { recordCreatedAgentGitHubApp } from "~/github/agent-apps.server";
import {
  isGitHubManifestCallbackStagingRequest,
  readStagedGitHubManifestCallback,
  stageGitHubManifestCallback,
} from "~/github/manifest-callback.server";
import { contextPath } from "~/lib/paths";
import { noindexMeta } from "~/lib/seo";
import { requireProject } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/github.apps.callback";

export const loader = (args: LoaderFunctionArgs) => {
  // GitHub's response contains the single-use manifest code. Leave that URL before
  // session/database work so the credential never survives in history, logs, rendered errors,
  // or a framework error document. The encrypted HttpOnly cookie is cleared by root middleware.
  if (isGitHubManifestCallbackStagingRequest(args.request)) {
    return stageGitHubManifestCallback(args.request);
  }

  return sessionLoader(
    args,
    async ({ auth }) => {
      // A staging failure is authoritative. Never allow an older valid cookie to be processed
      // after a malformed/oversized callback has replaced it.
      const stagingFailed = new URL(args.request.url).searchParams.has(
        "failure",
      );
      const callback = stagingFailed
        ? null
        : readStagedGitHubManifestCallback(args.request);
      const code = callback?.code ?? null;
      const stateToken = callback?.state ?? null;

      const fail = (error: string, backUrl = "/dashboard") => ({
        error,
        backUrl,
      });

      if (!code || !stateToken) {
        return fail(
          "GitHub didn't send back a creation code — the App was not created. Start the flow again from the agent's Deployment tab.",
        );
      }
      const state = verifyManifestState(stateToken, manifestStateKey());
      if (!state) {
        return fail(
          "This link is invalid or has expired (it lives one hour). Start the flow again from the agent's Deployment tab.",
        );
      }
      if (
        state.userId !== auth.user.id ||
        state.sessionId !== auth.session.id
      ) {
        return fail(
          "This GitHub App flow was started in a different harnesst session. Start the flow again from the agent's Deployment tab.",
        );
      }

      // Consume before converting the code. DELETE ... RETURNING makes concurrent callbacks
      // race safely: exactly one request can proceed, even across multiple app replicas.
      const consumed = await consumeOAuthStateNonce({
        nonce: state.nonce,
        userId: auth.user.id,
        sessionId: auth.session.id,
      });
      if (!consumed) {
        return fail(
          "This GitHub App link is invalid, expired, or has already been used. Start the flow again from the agent's Deployment tab.",
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

      // Single conversion — on failure the code is spent and the user restarts on GitHub's
      // side, so surface errors readably instead of throwing a 500.
      let converted;
      try {
        converted = await convertManifestCode(code);
      } catch (error) {
        return fail((error as Error).message, backUrl);
      }

      const conflict = findAppCredentialConflict(
        await listAppCredentialRows(project.id),
        agent.id,
        { slug: converted.slug, appId: converted.appId },
      );
      if (conflict) {
        return fail(
          `Another agent in this project ("${conflict.agentName}") already uses this GitHub App ` +
            `(${conflict.key} matches). Two agents can't answer to the same @mention — the new App ` +
            `was created on GitHub (${converted.htmlUrl}) but its credentials were NOT stored. ` +
            "Delete it there, or fix the other agent's credentials first.",
          backUrl,
        );
      }

      // Persist BEFORE redirecting onward — this response was the only copy of the pem and
      // webhook secret. Agent-wide scope (environmentId null); the App id/key/slug are
      // sandbox-exposed so the agent can mint installation tokens to DO work (issue #26 —
      // this supersedes the personal GITHUB_TOKEN); the webhook secret stays runtime-only.
      const secrets = getRuntime().secrets;
      const [previousAppId, previousSlug] = await Promise.all([
        secrets.get({
          projectId: project.id,
          agentId: agent.id,
          environmentId: null,
          key: "GITHUB_APP_ID",
        }),
        secrets.get({
          projectId: project.id,
          agentId: agent.id,
          environmentId: null,
          key: "GITHUB_APP_SLUG",
        }),
      ]);
      const writes: Array<[key: string, value: string, sandbox: boolean]> = [
        ["GITHUB_APP_PRIVATE_KEY", converted.pem, true],
        ["GITHUB_WEBHOOK_SECRET", converted.webhookSecret, false],
        ["GITHUB_APP_SLUG", converted.slug, true],
        // Commit marker for recovering a pending history row after a crash: when the App id has
        // changed, every other credential write above completed successfully.
        ["GITHUB_APP_ID", converted.appId, true],
      ];
      await recordCreatedAgentGitHubApp(
        {
          projectId: project.id,
          agentId: agent.id,
          appId: converted.appId,
          slug: converted.slug,
          ownerLogin: converted.ownerLogin,
          ownerType: converted.ownerType,
          previous:
            previousAppId && previousSlug
              ? { appId: previousAppId, slug: previousSlug }
              : null,
        },
        async () => {
          for (const [key, value, sandboxExposed] of writes) {
            await secrets.set(
              {
                projectId: project.id,
                agentId: agent.id,
                environmentId: null,
                key,
              },
              value,
              { sandboxExposed, updatedBy: auth.user.id },
            );
          }
        },
      );
      await invalidateAgentEnvironments({
        agentIds: [agent.id],
        createdBy: auth.user.id,
      });

      await getRuntime().data.audit.record({
        orgId: project.orgId,
        actorUserId: auth.user.id,
        action: "github-app.create",
        target: agent.name,
        meta: {
          slug: converted.slug,
          appId: converted.appId,
          owner: converted.ownerLogin,
        },
      });

      // Registration ≠ installation: the App exists but watches nothing yet. Send the user
      // to pick the repositories; GitHub's post-install setup_url brings them back to the
      // Deployment tab.
      throw redirect(appInstallUrl(converted.slug));
    },
    // The manifest state is bound to the initiating Better Auth session. If that session
    // expired, the round-trip cannot safely resume; keep the staged callback out of the login
    // returnTo URL.
    { ensureSignedIn: true, returnTo: "/dashboard" },
  );
};

export function meta() {
  return [{ title: "GitHub App · harnesst" }, ...noindexMeta];
}

export default function GitHubAppCallback({
  loaderData,
}: Route.ComponentProps) {
  const { error, backUrl } = loaderData;
  return (
    <AppShell>
      <PageHeader
        icon={Webhook}
        accent="brand"
        title="Create GitHub App"
        description="Something went wrong while finishing the GitHub App creation."
        actions={
          <Button variant="ghost" asChild>
            <Link to={backUrl}>← Back</Link>
          </Button>
        }
      />
      <Alert variant="destructive">
        <AlertTitle>GitHub App creation failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    </AppShell>
  );
}
