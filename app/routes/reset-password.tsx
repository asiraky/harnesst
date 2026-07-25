import { useEffect, useState, type FormEvent } from "react";
import { Form, Link } from "react-router";

import { safeReturnTo } from "~/auth/return-to";
import { AuthLink, AuthScreen } from "~/components/auth/auth-screen";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { authClient } from "~/lib/auth-client";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/reset-password";

// Prefill only values that look like an email; anything else is dropped.
function safePrefillEmail(value: string | null): string {
  const email = (value ?? "").trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : "";
}

export async function loader({ request }: Route.LoaderArgs) {
  // Better Auth links here with ?token=…; expired/invalid links arrive as ?error=….
  // returnTo and email were planted in the redirectTo by /forgot-password.
  const url = new URL(request.url);
  const token = url.searchParams.get("error")
    ? null
    : url.searchParams.get("token");
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const email = safePrefillEmail(url.searchParams.get("email"));
  return { token, returnTo, email };
}

export function meta() {
  return [{ title: "Reset password · harnesst" }, ...noindexMeta];
}

export default function ResetPassword({ loaderData }: Route.ComponentProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // The response's no-referrer policy protects initial subresource requests. Once React has
    // captured loaderData, also remove Better Auth's one-time token from browser history and any
    // future same-tab navigation without losing the safe return destination/email prefill.
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token") && !url.searchParams.has("error"))
      return;
    url.searchParams.delete("token");
    url.searchParams.delete("error");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmation = String(form.get("passwordConfirmation") ?? "");
    if (newPassword.length < 8 || newPassword.length > 128) {
      setError("Password must be between 8 and 128 characters.");
      return;
    }
    if (newPassword !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const result = await authClient.resetPassword({
        newPassword,
        token: loaderData.token ?? "",
      });
      if (result.error) {
        setError(result.error.message || "Could not reset the password.");
        setPending(false);
        return;
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setPending(false);
      return;
    }
    setDone(true);
  }

  // The reset token never travels on these links — only the sanitized returnTo
  // (and the email, so a fresh request doesn't make the user retype it).
  const loginHref = `/login?returnTo=${encodeURIComponent(loaderData.returnTo)}`;
  const forgotHref = `/forgot-password?returnTo=${encodeURIComponent(loaderData.returnTo)}${loaderData.email ? `&email=${encodeURIComponent(loaderData.email)}` : ""}`;

  return (
    <AuthScreen
      title="Reset your password"
      description={
        done
          ? "Your password has been updated."
          : loaderData.token
            ? "Choose a new password for your account."
            : "This link can't be used."
      }
      footer={
        done || loaderData.token ? undefined : (
          <AuthLink to={loginHref}>Back to sign in</AuthLink>
        )
      }
    >
      {done ? (
        <div className="space-y-5">
          <p
            role="status"
            className="text-sm leading-relaxed text-muted-foreground"
          >
            You can now sign in with your new password.
          </p>
          <Button asChild className="h-10 w-full">
            <Link to={loginHref}>Sign in</Link>
          </Button>
        </div>
      ) : !loaderData.token ? (
        <div className="space-y-5">
          <p
            role="alert"
            className="text-sm leading-relaxed text-muted-foreground"
          >
            This password reset link is invalid or has expired. Request a new
            one and try again.
          </p>
          <Button asChild className="h-10 w-full">
            <Link to={forgotHref}>Request a new link</Link>
          </Button>
        </div>
      ) : (
        <Form method="post" onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="newPassword">New password</Label>
            <Input
              id="newPassword"
              name="newPassword"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              className="h-10"
              required
            />
            <p className="text-xs text-muted-foreground">
              At least 8 characters.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="passwordConfirmation">Confirm password</Label>
            <Input
              id="passwordConfirmation"
              name="passwordConfirmation"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              className="h-10"
              required
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="h-10 w-full" disabled={pending}>
            {pending ? "Updating…" : "Update password"}
          </Button>
        </Form>
      )}
    </AuthScreen>
  );
}
