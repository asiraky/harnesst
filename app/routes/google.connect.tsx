/**
 * "Connect Google" — legacy alias for the provider-generic connect flow (issues #30, #163).
 *
 * Kept as its own route because operators' Google OAuth apps registered
 * `<origin>/google/callback` as the redirect URI; the google registry entry's `redirectPath`
 * keeps issuing it, so no operator action is required. Delegates to the shared flow with the
 * google.server shim's config seam (the single mock point existing tests rely on).
 */
import { type LoaderFunctionArgs } from "react-router";

import { connectionConnectLoader } from "~/connections/connect-flow.server";
import { getGoogleOAuthConfig } from "~/connections/config.server";
import { ConnectionFlowErrorPage } from "~/connections/flow-page";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/google.connect";

export const loader = (args: LoaderFunctionArgs) =>
  connectionConnectLoader(args, "google", {
    getConfig: () => getGoogleOAuthConfig(),
  });

export function meta() {
  return [{ title: "Connect Google · harnesst" }, ...noindexMeta];
}

export default function GoogleConnect({ loaderData }: Route.ComponentProps) {
  const { error, backUrl, user } = loaderData;
  return (
    <ConnectionFlowErrorPage
      title="Connect Google"
      description="Authorize this agent to use your Google account."
      alertTitle="Can’t start the Google connect flow"
      error={error}
      backUrl={backUrl}
      userEmail={user.email}
    />
  );
}
