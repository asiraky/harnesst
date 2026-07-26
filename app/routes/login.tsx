import { useEffect, useRef, useState, type FormEvent } from "react";
import { Form, Link, redirect } from "react-router";

import { safeReturnTo } from "~/auth/return-to";
import { getSessionAuth } from "~/auth/session.server";
import { AuthLink, AuthScreen } from "~/components/auth/auth-screen";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { authClient } from "~/lib/auth-client";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/login";

export async function loader(args: Route.LoaderArgs) {
  const { request } = args;
  const returnTo = safeReturnTo(
    new URL(request.url).searchParams.get("returnTo"),
  );
  const session = await getSessionAuth(args);
  if (session.user) throw redirect(returnTo);
  return { returnTo };
}

export function meta() {
  return [{ title: "Sign in · harnesst" }, ...noindexMeta];
}

export default function Login({ loaderData }: Route.ComponentProps) {
  // Two screens, one route: the email step never touches the server, so advancing
  // reveals nothing about whether an account exists.
  const [step, setStep] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "password") passwordRef.current?.focus();
    else emailRef.current?.focus();
  }, [step]);

  function continueToPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setEmail(
      String(form.get("email") ?? "")
        .trim()
        .toLowerCase(),
    );
    setError(null);
    setStep("password");
  }

  function changeEmail() {
    setError(null);
    setStep("email");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await authClient.signIn.email({
        email,
        password: String(form.get("password") ?? ""),
      });
      if (result.error) {
        setError(result.error.message || "Could not sign in.");
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
      title="Sign in"
      description={
        step === "email"
          ? "Continue to your harnesst workspace."
          : "Enter your password."
      }
      footer={
        <>
          New to harnesst?{" "}
          <AuthLink
            to={`/signup?returnTo=${encodeURIComponent(loaderData.returnTo)}`}
          >
            Create an account
          </AuthLink>
        </>
      }
    >
      {step === "email" ? (
        <Form
          method="post"
          onSubmit={continueToPassword}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={email}
              className="h-10"
              required
            />
          </div>
          <Button type="submit" className="h-10 w-full">
            Continue
          </Button>
        </Form>
      ) : (
        <Form method="post" onSubmit={submit} className="space-y-5">
          <div className="flex items-baseline justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <span className="truncate text-muted-foreground" title={email}>
              {email}
            </span>
            <button
              type="button"
              onClick={changeEmail}
              className="shrink-0 font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground"
            >
              Change
            </button>
          </div>
          {/* Hidden username field so password managers pair the saved login. */}
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            readOnly
            hidden
            tabIndex={-1}
          />
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                to={`/forgot-password?returnTo=${encodeURIComponent(loaderData.returnTo)}${email ? `&email=${encodeURIComponent(email)}` : ""}`}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              ref={passwordRef}
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
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
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </Form>
      )}
    </AuthScreen>
  );
}
