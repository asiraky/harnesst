import { useState, type FormEvent } from "react";
import { Form, redirect } from "react-router";

import { safeReturnTo } from "~/auth/return-to";
import { getSessionAuth } from "~/auth/session.server";
import { AuthLink, AuthScreen } from "~/components/auth/auth-screen";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { authClient } from "~/lib/auth-client";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/forgot-password";

// Prefill only values that look like an email; anything else is dropped.
function safePrefillEmail(value: string | null): string {
  const email = (value ?? "").trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : "";
}

export async function loader(args: Route.LoaderArgs) {
  const { request } = args;
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const email = safePrefillEmail(url.searchParams.get("email"));
  const session = await getSessionAuth(args);
  if (session.user) throw redirect(returnTo);
  return { returnTo, email };
}

export function meta() {
  return [{ title: "Forgot password · harnesst" }, ...noindexMeta];
}

export default function ForgotPassword({ loaderData }: Route.ComponentProps) {
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    // The emailed link comes back to /reset-password; returnTo (and the email,
    // for the request-a-new-link path) ride along as query params. Better Auth
    // appends its token/error via searchParams, so the query survives.
    const redirectTo = new URL("/reset-password", window.location.origin);
    redirectTo.searchParams.set("returnTo", loaderData.returnTo);
    if (email) redirectTo.searchParams.set("email", email);
    try {
      await authClient.requestPasswordReset({
        email,
        redirectTo: redirectTo.href,
      });
    } catch {
      // Fall through to the neutral copy — the response must not reveal
      // whether an account exists for the address.
    }
    setPending(false);
    setSubmitted(true);
  }

  const loginHref = `/login?returnTo=${encodeURIComponent(loaderData.returnTo)}`;

  return (
    <AuthScreen
      title="Reset your password"
      description={
        submitted
          ? "Check your email."
          : "Enter your email and we'll send you a reset link."
      }
      footer={<AuthLink to={loginHref}>Back to sign in</AuthLink>}
    >
      {submitted ? (
        <p role="status" className="text-sm leading-relaxed text-muted-foreground">
          If an account exists for that email, we&apos;ve sent a link to reset
          your password. It may take a minute to arrive.
        </p>
      ) : (
        <Form method="post" onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={loaderData.email}
              className="h-10"
              required
            />
          </div>
          <Button type="submit" className="h-10 w-full" disabled={pending}>
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </Form>
      )}
    </AuthScreen>
  );
}
