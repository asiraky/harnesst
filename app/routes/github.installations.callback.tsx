import { KeyRound } from "lucide-react";
import { Link, redirect, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { resolveActiveWorkspace } from "~/auth/workspace.server";
import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  getGitHubConfig,
  exchangeGitHubUserCode,
  listGitHubUserInstallations,
} from "~/github/client.server";
import {
  isGitHubInstallationCallbackStagingRequest,
  readStagedGitHubInstallationCallback,
  stageGitHubInstallationCallback,
} from "~/github/installation-callback.server";
import {
  consumeGitHubInstallationState,
  verifyGitHubInstallState,
} from "~/github/install-state.server";
import { upsertVerifiedInstallation } from "~/github/installations.server";
import { publicOrigin } from "~/lib/ingress";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/github.installations.callback";

export const loader = (args: LoaderFunctionArgs) => {
  if (isGitHubInstallationCallbackStagingRequest(args.request)) {
    return stageGitHubInstallationCallback(args.request);
  }

  return sessionLoader(
    args,
    async ({ auth }) => {
      const fail = (error: string) => ({ error });
      const url = new URL(args.request.url);
      const callback = url.searchParams.has("failure")
        ? null
        : readStagedGitHubInstallationCallback(args.request);
      if (!callback?.state) {
        return fail(
          "This GitHub callback is invalid or has expired. Start again from Connect.",
        );
      }
      const state = verifyGitHubInstallState(callback.state);
      if (!state) {
        return fail(
          "This GitHub authorization link is invalid or has expired. Start again from Connect.",
        );
      }
      if (
        state.userId !== auth.user.id ||
        state.sessionId !== auth.session.id
      ) {
        return fail(
          "This GitHub authorization was started in a different harnesst session. Start again from Connect.",
        );
      }
      const active = await resolveActiveWorkspace(auth);
      if (!active || active.org.id !== state.orgId) {
        return fail(
          "This GitHub authorization was started in a different workspace. Switch back and start again from Connect.",
        );
      }

      const consumed = await consumeGitHubInstallationState({
        nonce: state.nonce,
        userId: auth.user.id,
        sessionId: auth.session.id,
        orgId: active.org.id,
      });
      if (!consumed) {
        return fail(
          "This GitHub authorization is invalid, expired, or has already been used. Start again from Connect.",
        );
      }
      if (callback.error) {
        return fail(
          "GitHub authorization was cancelled or denied. Start again from Connect.",
        );
      }
      if (!callback.code) {
        return fail(
          "GitHub did not return an authorization code. Start again from Connect.",
        );
      }

      try {
        const config = getGitHubConfig();
        const redirectUri = `${publicOrigin(args.request)}/github/installations/callback`;
        const accessToken = await exchangeGitHubUserCode({
          code: callback.code,
          codeVerifier: consumed.codeVerifier,
          redirectUri,
          config,
        });
        const installations = await listGitHubUserInstallations(accessToken);
        const verified = installations.find(
          (installation) => installation.id === consumed.installationId,
        );
        if (!verified) {
          return fail(
            "GitHub did not confirm that your account can manage this installation. Nothing was connected.",
          );
        }
        await upsertVerifiedInstallation({
          orgId: active.org.id,
          installationId: consumed.installationId,
          accountLogin: verified.accountLogin,
          verifiedByUserId: auth.user.id,
        });
      } catch (error) {
        return fail((error as Error).message);
      }
      throw redirect("/connect");
    },
    { ensureSignedIn: true, returnTo: "/connect" },
  );
};

export function meta() {
  return [{ title: "Authorize GitHub · harnesst" }, ...noindexMeta];
}

export default function GitHubInstallationCallback({
  loaderData,
}: Route.ComponentProps) {
  return (
    <AppShell userEmail={loaderData.user.email}>
      <PageHeader
        icon={KeyRound}
        accent="brand"
        title="Authorize GitHub"
        description="Something went wrong while verifying the GitHub App installation."
        actions={
          <Button variant="ghost" asChild>
            <Link to="/connect">← Back</Link>
          </Button>
        }
      />
      <Alert variant="destructive">
        <AlertTitle>GitHub authorization failed</AlertTitle>
        <AlertDescription>{loaderData.error}</AlertDescription>
      </Alert>
    </AppShell>
  );
}
