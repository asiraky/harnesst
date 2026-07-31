import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

import { db } from "~/db/client.server";
import * as schema from "~/db/auth-schema";
import { sendOrganizationInvitation } from "~/email/send-organization-invitation.server";
import { sendEmailVerification } from "~/email/send-email-verification.server";
import { sendPasswordResetEmail } from "~/email/send-password-reset.server";
import { authCookieConfig } from "~/lib/auth-cookies";
import { assertProductionAuthEnvironment } from "~/lib/auth-env.server";

assertProductionAuthEnvironment();

const cookieConfig = authCookieConfig();

export const auth = betterAuth({
  appName: "harnesst",
  // Production request paths can carry one-time tokens. Better Auth's default error logger may
  // serialize endpoint params (its `args` can include token-bearing bodies), so production logs
  // the message line only — enough to observe provider failures (e.g. a swallowed invitation
  // email rejection) without ever serializing an error object or endpoint input. Development
  // keeps the framework's full diagnostics.
  logger:
    process.env.NODE_ENV === "production"
      ? {
          level: "error" as const,
          log: (level: string, message: string) => {
            console.error(`[better-auth:${level}] ${message}`);
          },
        }
      : undefined,
  onAPIError:
    process.env.NODE_ENV === "production" ? { throw: true } : undefined,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // 30-day rolling sessions for all users.
  session: {
    expiresIn: 60 * 60 * 24 * 30,
  },
  advanced: {
    // The supported production topology puts harnesst directly behind nginx, which overwrites
    // X-Real-IP with the TCP peer address. Reading that single trusted value keeps Better Auth's
    // production rate limits per-client without accepting a spoofable forwarded chain.
    ipAddress: { ipAddressHeaders: ["x-real-ip"] },
    // `__Host-` cookies (#296) — host-locked, so a sibling subdomain (notably the optional
    // PREVIEW_ORIGIN sandbox host, where agent-authored script runs by design) cannot set a cookie
    // this app will read. Better Auth prepends `__Secure-` itself when it considers cookies
    // secure, which would produce the meaningless `__Secure-__Host-…`, so its automatic prefixing
    // is turned off here and `Secure` — which `__Host-` requires — is restored for every cookie
    // through the default attributes. See app/lib/auth-cookies.ts for why http development keeps
    // an unprefixed name.
    useSecureCookies: false,
    defaultCookieAttributes: { secure: cookieConfig.secure },
    cookiePrefix: cookieConfig.cookiePrefix,
  },
  emailVerification: {
    // Ordinary email/password signup and sign-in stay verification-free. Verification is sent
    // manually only when Better Auth's organization plugin requires mailbox proof for an invite.
    sendOnSignUp: false,
    sendOnSignIn: false,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      // Await so a provider rejection fails the endpoint: the invite-verification gate is
      // hard-blocked on this email, and a silent 200 would strand the invitee behind a
      // "verification sent" message that never arrives.
      try {
        await sendEmailVerification({
          userEmail: user.email,
          verificationUrl: url,
        });
      } catch (error) {
        // Provider errors can include the token-bearing HTML body; log the error name only.
        console.error(
          `Could not send an email verification message (${(error as Error)?.name ?? "Error"}).`,
        );
        throw new APIError("INTERNAL_SERVER_ERROR", {
          message: "Could not send the verification email.",
        });
      }
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      // Deliberately fire-and-forget: /forgot-password must answer uniformly whether or not an
      // account exists (anti-enumeration), so a provider failure can't change the response. The
      // sanitized marker below keeps the failure observable in production logs.
      void sendPasswordResetEmail({
        userEmail: user.email,
        resetUrl: url,
      }).catch((error) => {
        // Do not log the error object: provider errors can include the token-bearing HTML body.
        console.error(
          `Could not send a password reset email (${(error as Error)?.name ?? "Error"}).`,
        );
      });
    },
  },
  plugins: [
    organization({
      // Better Auth ships POST /api/auth/organization/delete enabled by default; harnesst's tables
      // cascade from organization.id, so one owner-session call would erase an entire tenant
      // (projects, deployments, secrets — and the audit log recording it) while leaving deployed
      // containers orphaned. No harnesst flow calls it; keep it off until an app-owned teardown
      // exists.
      disableOrganizationDeletion: true,
      // CVE-2026-53514: invitation IDs can be listed by organization members. Require the
      // recipient to prove mailbox ownership before get/accept/reject invitation operations.
      requireEmailVerificationOnInvitation: true,
      // FOH repo scoping (PRD-FRONT-OF-HOUSE §5): one Better Auth team per connected repo,
      // mapped via projects.team_id (see app/auth/teams.server.ts). Invitations carry the
      // repo's teamId; accepting one auto-adds the invitee to that team.
      teams: {
        enabled: true,
        // harnesst mints teams 1:1 with repos (ensureProjectTeam); an auto-created default team
        // per organization would be an unmapped orphan in that model.
        defaultTeam: { enabled: false },
        // Deleting the last repo must delete its team; without this Better Auth refuses to
        // remove an organization's final team.
        allowRemovingAllTeams: true,
      },
      sendInvitationEmail: async (invitation) => {
        // Better Auth awaits this but swallows a rejection into logger.error, so log a sanitized
        // marker ourselves (never the error object — provider errors can include the
        // token-bearing HTML body) before rethrowing for the framework logger.
        try {
          await sendOrganizationInvitation(invitation);
        } catch (error) {
          console.error(
            `Could not send an organization invitation email (${(error as Error)?.name ?? "Error"}).`,
          );
          throw error;
        }
      },
    }),
  ],
});
