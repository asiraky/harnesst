import {
  createOAuthCallbackStaging,
  type OAuthCallbackPayload,
} from "~/connections/oauth-callback-staging.server";

export type GitHubInstallationCallbackPayload = OAuthCallbackPayload;

const staging = createOAuthCallbackStaging({
  cookieName: "harnesst-github-installation-callback",
  path: "/github/installations/callback",
});

export const isGitHubInstallationCallbackStagingRequest =
  staging.isStagingRequest;
export const stageGitHubInstallationCallback = staging.stage;
export const readStagedGitHubInstallationCallback = staging.readStaged;
export const clearGitHubInstallationCallbackCookie = staging.clearCookie;
