/**
 * Google connect callback — legacy alias for the provider-generic callback flow (issues #30,
 * #163). Operators' Google OAuth apps registered `<origin>/google/callback`, so this URL (and
 * its dedicated staging cookie) must keep working. Delegates to the shared flow with Google's
 * staging + the google.server shim's exchange/userinfo seams (the single mock point existing
 * tests rely on).
 */
import { type LoaderFunctionArgs } from "react-router";

import { connectionCallbackLoader } from "~/connections/connect-flow.server";
import { getGoogleOAuthConfig } from "~/connections/config.server";
import { ConnectionFlowErrorPage } from "~/connections/flow-page";
import {
  isGoogleCallbackStagingRequest,
  readStagedGoogleCallback,
  stageGoogleCallback,
} from "~/connections/google-callback.server";
import {
  exchangeCode,
  fetchAccountEmail,
} from "~/connections/google.server";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/google.callback";

export const loader = (args: LoaderFunctionArgs) =>
  connectionCallbackLoader(args, "google", {
    isStagingRequest: isGoogleCallbackStagingRequest,
    stage: stageGoogleCallback,
    readStaged: readStagedGoogleCallback,
    getConfig: () => getGoogleOAuthConfig(),
    // Old Google-bound signature on purpose: google-auth-routes.test.ts asserts these exact calls.
    exchangeCode: ({ config, code, redirectUri }) =>
      exchangeCode({ config, code, redirectUri }),
    fetchAccountEmail: (_provider, accessToken) =>
      fetchAccountEmail(accessToken),
  });

export function meta() {
  return [{ title: "Connect Google · harnesst" }, ...noindexMeta];
}

export default function GoogleCallback({ loaderData }: Route.ComponentProps) {
  const { error, backUrl, user } = loaderData;
  return (
    <ConnectionFlowErrorPage
      title="Connect Google"
      description="Something went wrong while connecting Google."
      alertTitle="Google connect failed"
      error={error}
      backUrl={backUrl}
      userEmail={user.email}
    />
  );
}
