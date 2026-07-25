/**
 * Google connect callback staging — an instance of the generic staged-callback mechanism (see
 * oauth-callback-staging.server.ts). Google's redirect carries a one-time authorization `code`;
 * staging keeps it out of history, logs, referrers, and rendered error documents.
 */
import {
  createOAuthCallbackStaging,
  type OAuthCallbackPayload,
} from "./oauth-callback-staging.server";

export type GoogleCallbackPayload = OAuthCallbackPayload;

const staging = createOAuthCallbackStaging({
  cookieName: "harnesst-google-oauth-callback",
  path: "/google/callback",
});

export const isGoogleCallbackStagingRequest = staging.isStagingRequest;
export const stageGoogleCallback = staging.stage;
export const readStagedGoogleCallback = staging.readStaged;
export const clearGoogleCallbackCookie = staging.clearCookie;
