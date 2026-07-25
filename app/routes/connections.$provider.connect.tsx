/**
 * Provider-generic "Connect <provider>" route (issue #163) — step 1 of the connection flow for
 * every registered provider. The provider id comes from the URL and is resolved against the
 * registry (unknown id → readable error page). Google is also reachable here; its registry
 * entry keeps issuing the legacy /google/callback redirect URI.
 */
import { getProviderOAuthConfig } from "~/connections/config.server";
import { connectionConnectLoader } from "~/connections/connect-flow.server";
import { ConnectionFlowErrorPage } from "~/connections/flow-page";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/connections.$provider.connect";

export const loader = (args: Route.LoaderArgs) =>
  connectionConnectLoader(args, args.params.provider ?? "", {
    getConfig: getProviderOAuthConfig,
  });

export function meta() {
  return [{ title: "Connect · harnesst" }, ...noindexMeta];
}

export default function ConnectionConnect({
  loaderData,
}: Route.ComponentProps) {
  const { error, backUrl, providerLabel, user } = loaderData;
  return (
    <ConnectionFlowErrorPage
      title={`Connect ${providerLabel}`}
      description={`Authorize this agent to use your ${providerLabel} account.`}
      alertTitle={`Can’t start the ${providerLabel} connect flow`}
      error={error}
      backUrl={backUrl}
      userEmail={user.email}
    />
  );
}
