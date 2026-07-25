/**
 * Shared shell for the standalone auth screens (login, signup, forgot/reset
 * password). Keeps the logo, card proportions, and footer treatment identical
 * across the four routes so spacing decisions live in one place.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";

import { Logo } from "~/components/marketing/logo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { cn } from "~/lib/utils";

export function AuthScreen({
  title,
  description,
  children,
  footer,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-harnesst-bg px-6 py-12 text-harnesst-fg">
      <div className="w-full max-w-sm">
        <Link
          to="/"
          className="mx-auto mb-8 block w-fit"
          aria-label="harnesst home"
        >
          <Logo className="h-7" />
        </Link>
        <Card className="gap-6 [--card-spacing:--spacing(6)]">
          <CardHeader className="gap-1.5">
            <CardTitle className="text-lg">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {footer ? (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {footer}
          </p>
        ) : null}
      </div>
    </main>
  );
}

/** Quiet inline text link used in auth footers and secondary actions. */
export function AuthLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground",
        className,
      )}
    >
      {children}
    </Link>
  );
}
