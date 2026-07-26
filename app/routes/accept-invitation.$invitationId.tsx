import { Form, Link, redirect } from "react-router";
import { eq, sql } from "drizzle-orm";

import {
  NO_ACCESS_INVITATION_MESSAGE,
  invitationGrantsNoAccess,
} from "~/auth/invitation-grant.server";
import { verifyInvitationToken } from "~/auth/invitation-token.server";
import {
  getSessionAuth,
  requireSession,
  signupPath,
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

function errorCode(error: unknown): string | undefined {
  return (error as { body?: { code?: string } } | null)?.body?.code;
}

function verificationRequired(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION" ||
    code ===
      "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION"
  );
}

/**
 * Better Auth compares the invitation's email to the SESSION's email on get/accept/reject and
 * rejects a mismatch outright, so a wrong signed-in account can never be bound to the invite —
 * it just fails. Recognising the code turns that dead end into the account-switch screen.
 */
function wrongRecipient(error: unknown): boolean {
  return errorCode(error) === "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION";
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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

/** This screen's own path, token included so a round-trip through auth lands back intact. */
function invitationPath(invitationId: string, token: string | null): string {
  const path = `/accept-invitation/${encodeURIComponent(invitationId)}`;
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

/** Sign-in for the invited account, returning to this invitation once signed in. */
function signInForInvitation(
  invitationId: string,
  token: string | null,
  invitedEmail: string | null,
): string {
  const returnTo = encodeURIComponent(invitationPath(invitationId, token));
  const email = invitedEmail
    ? `&email=${encodeURIComponent(invitedEmail)}`
    : "";
  return `/login?returnTo=${returnTo}${email}`;
}

/** Whether a harnesst account already exists for an address (case-insensitive). */
async function accountExists(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return rows.length > 0;
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
  if (!sameEmail(delivery.email, sessionUser.email)) return;
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

/** End the current session, then continue to `to` (the sign-out cookies ride along). */
async function signOutAndContinue(
  request: Request,
  to: string,
): Promise<Response> {
  const response = await auth.api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  // betterAuthSessionMiddleware will not append a stale rolling cookie over a deletion for the
  // same cookie name, so the redirect really does arrive signed out.
  return redirect(to, { headers: response.headers });
}

export async function loader(args: Route.LoaderArgs) {
  const invitationId = args.params.invitationId ?? "";
  const url = new URL(args.request.url);
  // The delivery token from the emailed link; echoed to the accept form so the POST can redeem
  // it too. It is already visible in the visitor's own URL, so returning it discloses nothing new.
  const token = url.searchParams.get("token");
  // A verified token is mailbox proof for (invitationId, invited email) — the only thing that
  // lets this route reason about WHO the invite is for before anyone signs in.
  const delivery = token ? verifyInvitationToken(token, invitationId) : null;
  const session = await getSessionAuth(args);

  if (!session.user) {
    // Issue #220.1: an invitee who already has an account used to be funnelled into "Create an
    // account" and stranded when signup rejected the duplicate. Route by whether the invited
    // address already exists. Only the bearer of a valid delivery token gets that answer, so
    // this is not an enumeration oracle: without a token the destination stays sign-up, which
    // cross-links to sign-in with returnTo preserved.
    const returnTo = `${url.pathname}${url.search}`;
    if (delivery) {
      throw redirect(
        (await accountExists(delivery.email))
          ? signInForInvitation(invitationId, token, delivery.email)
          : `${signupPath(args.request, returnTo)}&email=${encodeURIComponent(delivery.email)}`,
      );
    }
    throw redirect(signupPath(args.request, returnTo));
  }

  const base = {
    user: session.user,
    token,
    invitation: null,
    error: null as string | null,
    verificationRequired: false,
    wrongAccount: false,
    invitedEmail: null as string | null,
  };

  if (!invitationId) return { ...base, error: "Invitation not found." };

  // Issue #220.2: a different account is signed in. The token names the invited address, so say
  // so plainly and offer the switch instead of failing deep inside Better Auth.
  if (delivery && !sameEmail(delivery.email, session.user.email)) {
    return { ...base, wrongAccount: true, invitedEmail: delivery.email };
  }

  await redeemDeliveryToken(session.user, invitationId, token);
  try {
    const invitation = await auth.api.getInvitation({
      query: { id: invitationId },
      headers: session.requestHeaders,
    });
    // A grant can decay after it is sent (see invitation-grant.server). Say so here rather than
    // offering an Accept button whose only outcome is a workspace with nothing in it.
    if (await invitationGrantsNoAccess(invitationId)) {
      return { ...base, invitation, error: NO_ACCESS_INVITATION_MESSAGE };
    }
    return { ...base, invitation };
  } catch (error) {
    // Without a token the invited address is unknown, so Better Auth's own recipient check is
    // what surfaces the mismatch — same screen, just no address to name.
    if (wrongRecipient(error)) return { ...base, wrongAccount: true };
    const needsVerification = verificationRequired(error);
    return {
      ...base,
      error: needsVerification ? null : errorMessage(error),
      verificationRequired: needsVerification,
    };
  }
}

export async function action(args: Route.ActionArgs) {
  const session = await requireSession(args);
  const form = await args.request.formData();
  const invitationId = String(form.get("invitationId") ?? "");
  const intent = String(form.get("intent") ?? "accept");
  const formToken = form.get("token");
  const token = typeof formToken === "string" && formToken ? formToken : null;
  const delivery = token ? verifyInvitationToken(token, invitationId) : null;

  if (intent === "switch-account") {
    // Issue #220.2: accepting must work regardless of who is signed in. End the wrong session
    // and land on sign-in for the invited account, returning straight back to this invitation.
    throw await signOutAndContinue(
      args.request,
      signInForInvitation(invitationId, token, delivery?.email ?? null),
    );
  }

  await redeemDeliveryToken(session.user, invitationId, token);

  if (intent === "send-verification") {
    try {
      await auth.api.getInvitation({
        query: { id: invitationId },
        headers: session.requestHeaders,
      });
      throw redirect(invitationPath(invitationId, token));
    } catch (error) {
      if (error instanceof Response) throw error;
      if (wrongRecipient(error)) return { wrongAccount: true as const };
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

  // A token that names someone else proves this session is the wrong one before Better Auth is
  // even asked: sign out and continue rather than returning an error the invitee can't act on.
  if (delivery && !sameEmail(delivery.email, session.user.email)) {
    throw await signOutAndContinue(
      args.request,
      signInForInvitation(invitationId, token, delivery.email),
    );
  }

  // The acceptance boundary is the only place the "no member without a team" invariant can
  // actually hold: the grant is checked against the workspace as it stands right now, not as it
  // stood when the invitation was written.
  if (await invitationGrantsNoAccess(invitationId)) {
    return { error: NO_ACCESS_INVITATION_MESSAGE };
  }

  try {
    await auth.api.acceptInvitation({
      body: { invitationId },
      headers: session.requestHeaders,
    });
  } catch (error) {
    if (wrongRecipient(error)) return { wrongAccount: true as const };
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
  const wrongAccount =
    loaderData.wrongAccount ||
    Boolean(
      actionData && "wrongAccount" in actionData && actionData.wrongAccount,
    );
  const needsVerification =
    !wrongAccount &&
    (loaderData.verificationRequired || actionVerificationRequired);
  const error = actionError ?? loaderData.error;
  const invitation = loaderData.invitation;
  const invitationId = invitation?.id ?? params.invitationId;

  return (
    <AppShell userEmail={loaderData.user.email}>
      <PageHeader
        title="Workspace invitation"
        description={
          wrongAccount
            ? "This invitation belongs to a different account."
            : needsVerification
              ? "Verify your email to continue."
              : "Review and accept your invitation."
        }
      />
      <Card className="mx-auto max-w-lg">
        {wrongAccount ? (
          <>
            <CardHeader>
              <CardTitle>Switch accounts to continue</CardTitle>
              <CardDescription>
                {loaderData.invitedEmail
                  ? `This invitation was sent to ${loaderData.invitedEmail}.`
                  : "This invitation was sent to a different email address."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                You're signed in as {loaderData.user.email}. Continue to sign
                out and sign in
                {loaderData.invitedEmail
                  ? ` as ${loaderData.invitedEmail}`
                  : " as the invited account"}{" "}
                — you'll come straight back to this invitation.
              </p>
              <Form method="post" className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="intent" value="switch-account" />
                <input type="hidden" name="invitationId" value={invitationId} />
                {loaderData.token ? (
                  <input type="hidden" name="token" value={loaderData.token} />
                ) : null}
                <Button type="submit">Sign out and continue</Button>
                <Button asChild variant="outline">
                  <Link to="/">Stay signed in</Link>
                </Button>
              </Form>
            </CardContent>
          </>
        ) : needsVerification ? (
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
                  ? `${invitation.inviterEmail} invited ${invitation.email} to this workspace.`
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
