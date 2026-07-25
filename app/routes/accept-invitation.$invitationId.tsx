import { Form, Link, redirect } from "react-router";
import { eq } from "drizzle-orm";

import { verifyInvitationToken } from "~/auth/invitation-token.server";
import {
  requireSession,
  sessionLoader,
  type SessionAuth,
} from "~/auth/session.server";
import { db } from "~/db/client.server";
import { user } from "~/db/auth-schema";
import { AppShell, PageHeader } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { noindexMeta } from "~/lib/seo";
import { auth } from "~/lib/auth.server";
import { publicAuthErrorMessage } from "~/lib/auth-error.server";
import type { Route } from "./+types/accept-invitation.$invitationId";

function errorMessage(error: unknown): string {
  return publicAuthErrorMessage(
    error,
    "This invitation is invalid or no longer available.",
  );
}

function verificationRequired(error: unknown): boolean {
  const code = (error as { body?: { code?: string } } | null)?.body?.code;
  return (
    code === "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION" ||
    code ===
      "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION"
  );
}

function invitationCallbackUrl(request: Request, invitationId: string): string {
  const configured = process.env.BETTER_AUTH_URL?.trim();
  const origin = configured
    ? new URL(configured).origin
    : new URL(request.url).origin;
  return new URL(
    `/accept-invitation/${encodeURIComponent(invitationId)}`,
    origin,
  ).toString();
}

/**
 * Redeem the delivery token from the invitation email link as mailbox proof. The token is an
 * HMAC over (invitationId, invited email) minted when the email was sent, so presenting it
 * proves the bearer received that email — the same property a manual verification round-trip
 * establishes. When the signed-in account's email matches the invited address, mark it
 * verified so the organization plugin's invitation gate (kept ON against enumerable
 * invitation ids, CVE-2026-53514) passes without a redundant second email.
 */
async function redeemDeliveryToken(
  sessionUser: SessionAuth["user"],
  invitationId: string,
  token: string | null,
): Promise<void> {
  if (!token || sessionUser.emailVerified) return;
  const delivery = verifyInvitationToken(token, invitationId);
  if (!delivery) return;
  if (
    delivery.email.trim().toLowerCase() !==
    sessionUser.email.trim().toLowerCase()
  ) {
    return;
  }
  await db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, sessionUser.id));
}

async function requestVerificationEmail(
  request: Request,
  email: string,
  invitationId: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");

  // Use Better Auth's public handler path, not a direct server API call. Handler requests receive
  // Better Auth's trusted-origin checks and its dedicated 3-per-minute verification-email limit.
  return auth.handler(
    new Request(new URL("/api/auth/send-verification-email", request.url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        email,
        callbackURL: invitationCallbackUrl(request, invitationId),
      }),
      signal: request.signal,
    }),
  );
}

export const loader = (args: Route.LoaderArgs) =>
  sessionLoader(
    args,
    async ({ auth: session }) => {
      const invitationId = args.params.invitationId;
      // The delivery token from the emailed link; echoed to the accept form so the POST can
      // redeem it too. It is already visible in the visitor's own URL, so returning it to the
      // page discloses nothing new.
      const token = new URL(args.request.url).searchParams.get("token");
      if (!invitationId)
        return {
          invitation: null,
          error: "Invitation not found.",
          verificationRequired: false,
          token,
        };
      await redeemDeliveryToken(session.user, invitationId, token);
      try {
        const invitation = await auth.api.getInvitation({
          query: { id: invitationId },
          headers: session.requestHeaders,
        });
        return { invitation, error: null, verificationRequired: false, token };
      } catch (error) {
        const needsVerification = verificationRequired(error);
        return {
          invitation: null,
          error: needsVerification ? null : errorMessage(error),
          verificationRequired: needsVerification,
          token,
        };
      }
    },
    // Invitees usually have no account yet, so a signed-out click on the emailed link lands on
    // sign-up (which cross-links to sign-in); returnTo keeps the invitation URL — token included.
    { ensureSignedIn: true, signedOutRedirect: "signup" },
  );

export async function action(args: Route.ActionArgs) {
  const session = await requireSession(args);
  const form = await args.request.formData();
  const invitationId = String(form.get("invitationId") ?? "");
  const intent = String(form.get("intent") ?? "accept");
  const token = form.get("token");

  await redeemDeliveryToken(
    session.user,
    invitationId,
    typeof token === "string" && token ? token : null,
  );

  if (intent === "send-verification") {
    try {
      await auth.api.getInvitation({
        query: { id: invitationId },
        headers: session.requestHeaders,
      });
      throw redirect(`/accept-invitation/${encodeURIComponent(invitationId)}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      if (!verificationRequired(error)) return { error: errorMessage(error) };
    }

    try {
      const response = await requestVerificationEmail(
        args.request,
        session.user.email,
        invitationId,
      );
      if (response.status === 429) {
        return {
          error:
            "Too many verification emails. Please wait a minute and try again.",
        };
      }
      if (!response.ok) {
        return { error: "Could not send the verification email." };
      }
      return { verificationSent: true };
    } catch {
      return { error: "Could not send the verification email." };
    }
  }

  try {
    await auth.api.acceptInvitation({
      body: { invitationId },
      headers: session.requestHeaders,
    });
  } catch (error) {
    return {
      error: errorMessage(error),
      verificationRequired: verificationRequired(error),
    };
  }
  // Front of house is home (FOH D18): invitees are typically `member`-role and back of house
  // would turn them away anyway.
  throw redirect("/");
}

export function meta() {
  return [{ title: "Accept invitation · harnesst" }, ...noindexMeta];
}

export default function AcceptInvitation({
  loaderData,
  actionData,
  params,
}: Route.ComponentProps) {
  const actionError =
    actionData && "error" in actionData ? actionData.error : null;
  const verificationSent = Boolean(
    actionData &&
    "verificationSent" in actionData &&
    actionData.verificationSent,
  );
  const actionVerificationRequired = Boolean(
    actionData &&
    "verificationRequired" in actionData &&
    actionData.verificationRequired,
  );
  const needsVerification =
    loaderData.verificationRequired || actionVerificationRequired;
  const error = actionError ?? loaderData.error;
  const invitation = loaderData.invitation;
  const invitationId = invitation?.id ?? params.invitationId;

  return (
    <AppShell userEmail={loaderData.user.email}>
      <PageHeader
        title="Workspace invitation"
        description={
          needsVerification
            ? "Verify your email to continue."
            : "Review and accept your invitation."
        }
      />
      <Card className="mx-auto max-w-lg">
        {needsVerification ? (
          <>
            <CardHeader>
              <CardTitle>Verify your email</CardTitle>
              <CardDescription>
                This workspace invitation requires a verified email address.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {actionError ? (
                <p role="alert" className="text-sm text-destructive">
                  {actionError}
                </p>
              ) : null}
              <p className="text-sm text-muted-foreground">
                You're signed in as {loaderData.user.email}. This email address
                must be verified before you can accept this invitation. Opening
                the invitation link from your email verifies it automatically —
                or send a verification email below.
              </p>
              {verificationSent ? (
                <p role="status" className="text-sm text-muted-foreground">
                  We've sent a verification link to {loaderData.user.email}.
                  Check your email, then return here to accept the invitation.
                </p>
              ) : null}
              <Form method="post">
                <input type="hidden" name="intent" value="send-verification" />
                <input type="hidden" name="invitationId" value={invitationId} />
                <Button type="submit">
                  {verificationSent
                    ? "Resend verification email"
                    : "Send verification email"}
                </Button>
              </Form>
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle>
                {invitation
                  ? `Join ${invitation.organizationName}`
                  : "Invitation unavailable"}
              </CardTitle>
              <CardDescription>
                {invitation
                  ? `${invitation.inviterEmail} invited ${loaderData.user.email} to this workspace.`
                  : "The invitation could not be opened for this account."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {error ? (
                <div className="space-y-4">
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                  <Button asChild variant="outline">
                    <Link to="/dashboard">Back to dashboard</Link>
                  </Button>
                </div>
              ) : invitation ? (
                <Form method="post">
                  <input
                    type="hidden"
                    name="invitationId"
                    value={invitation.id}
                  />
                  {loaderData.token ? (
                    <input
                      type="hidden"
                      name="token"
                      value={loaderData.token}
                    />
                  ) : null}
                  <Button type="submit">Accept invitation</Button>
                </Form>
              ) : null}
            </CardContent>
          </>
        )}
      </Card>
    </AppShell>
  );
}
