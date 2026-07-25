/**
 * GitHub App manifest callback staging — an instance of the generic staged-callback mechanism
 * (see app/connections/oauth-callback-staging.server.ts). The manifest `code` converts into the
 * App's PEM private key and webhook secret, so it must never survive in the raw callback URL
 * (history, request logs, referrers, rendered error documents) any more than Google's does.
 */
import {
  createOAuthCallbackStaging,
  type OAuthCallbackPayload,
} from "~/connections/oauth-callback-staging.server";

export type GitHubManifestCallbackPayload = OAuthCallbackPayload;

const staging = createOAuthCallbackStaging({
  cookieName: "harnesst-github-manifest-callback",
  path: "/github/apps/callback",
});

export const isGitHubManifestCallbackStagingRequest = staging.isStagingRequest;
export const stageGitHubManifestCallback = staging.stage;
export const readStagedGitHubManifestCallback = staging.readStaged;
export const clearGitHubManifestCallbackCookie = staging.clearCookie;
