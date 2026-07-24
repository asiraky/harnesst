import { useState, type FormEvent } from "react";
import { Form, redirect } from "react-router";

import { safeEmailHint, safeReturnTo } from "~/auth/return-to";
import { getSessionAuth } from "~/auth/session.server";
import { AuthLink, AuthScreen } from "~/components/auth/auth-screen";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { authClient } from "~/lib/auth-client";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/signup";

export async function loader(args: Route.LoaderArgs) {
  const { request } = args;
  const returnTo = safeReturnTo(
    new URL(request.url).searchParams.get("returnTo"),
  );
  const session = await getSessionAuth(args);
  if (session.user) throw redirect(returnTo);
  // Prefilled when an invitation link routed a brand-new invitee here.
  return {
    returnTo,
    email: safeEmailHint(new URL(request.url).searchParams.get("email")),
  };
}

export function meta() {
  return [{ title: "Create an account · eden" }, ...noindexMeta];
}

export default function Signup({ loaderData }: Route.ComponentProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await authClient.signUp.email({
        name: String(form.get("name") ?? "").trim(),
        email: String(form.get("email") ?? "")
          .trim()
          .toLowerCase(),
        password: String(form.get("password") ?? ""),
      });
      if (result.error) {
        setError(result.error.message || "Could not create the account.");
        setPending(false);
        return;
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setPending(false);
      return;
    }
    window.location.assign(loaderData.returnTo);
  }

  return (
    <AuthScreen
      title="Create an account"
      description="Start with a personal workspace. You can join others later."
      footer={
        <>
          Already have an account?{" "}
          <AuthLink
            to={`/login?returnTo=${encodeURIComponent(loaderData.returnTo)}${loaderData.email ? `&email=${encodeURIComponent(loaderData.email)}` : ""}`}
          >
            Sign in
          </AuthLink>
        </>
      }
    >
      <Form method="post" onSubmit={submit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            autoComplete="name"
            className="h-10"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={loaderData.email ?? ""}
            className="h-10"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
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
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="h-10 w-full" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </Form>
    </AuthScreen>
  );
}
