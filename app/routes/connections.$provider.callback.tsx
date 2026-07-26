/**
 * Provider-generic connect callback route (issue #163) — step 2 of the connection flow at the
 * canonical redirect URI `<origin>/connections/<provider>/callback`. Uses the shared
 * connection-callback staging (path-scoped cookie) and the provider-generic exchange/userinfo
 * calls; everything else is the shared flow.
 */
import { getProviderOAuthConfig } from "~/connections/config.server";
import { connectionCallbackLoader } from "~/connections/connect-flow.server";
import {
  isConnectionCallbackStagingRequest,
  readStagedConnectionCallback,
  stageConnectionCallback,
} from "~/connections/connection-callback.server";
import { ConnectionFlowErrorPage } from "~/connections/flow-page";
import { exchangeCode, fetchAccountEmail } from "~/connections/oauth.server";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/connections.$provider.callback";

export const loader = (args: Route.LoaderArgs) =>
  connectionCallbackLoader(args, args.params.provider ?? "", {
    isStagingRequest: isConnectionCallbackStagingRequest,
    stage: stageConnectionCallback,
    readStaged: readStagedConnectionCallback,
    getConfig: getProviderOAuthConfig,
    exchangeCode: (input) => exchangeCode(input),
    fetchAccountEmail: (provider, accessToken) =>
      fetchAccountEmail(provider, accessToken),
  });

export function meta() {
  return [{ title: "Connect · harnesst" }, ...noindexMeta];
}

export default function ConnectionCallback({
  loaderData,
}: Route.ComponentProps) {
  const { error, backUrl, providerLabel, user } = loaderData;
  return (
    <ConnectionFlowErrorPage
      title={`Connect ${providerLabel}`}
      description={`Something went wrong while connecting ${providerLabel}.`}
      alertTitle={`${providerLabel} connect failed`}
      error={error}
      backUrl={backUrl}
      userEmail={user.email}
    />
  );
}
