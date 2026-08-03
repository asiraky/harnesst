/**
 * In-pane error state for the FOH panes (issue #250). Without a route-level ErrorBoundary a
 * loader throw in `foh.agent`/`foh.session` bubbles to root, which replaces the whole
 * three-pane shell — including the session list the reader needs to get out. Rendering the
 * failure inside the pane keeps the shell, keeps the way back, and puts the message where the
 * reader is already looking.
 */
import { ChevronLeft } from "lucide-react";
import { isRouteErrorResponse, Link } from "react-router";

import { Button } from "~/components/ui/button";

/**
 * The reader-facing message for a thrown route error. A `data()`/`Response` throw carries the
 * loader's own wording ("Session not found"), which is too terse to act on, so the status
 * decides the sentence; anything else is a bug and says so without leaking internals.
 */
export function paneErrorMessage(error: unknown, subject: string): string {
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return `This ${subject} isn't available — it may have been archived or removed, or it may belong to someone else.`;
    }
    if (error.status === 403) {
      return `You don't have access to this ${subject}.`;
    }
    return `Couldn't open this ${subject} (error ${error.status}).`;
  }
  return `Something went wrong opening this ${subject}.`;
}

/** Developer detail — only in dev, and never for a thrown route response (no stack to show). */
function paneErrorStack(error: unknown): string | null {
  if (!import.meta.env.DEV) return null;
  if (isRouteErrorResponse(error) || !(error instanceof Error)) return null;
  return error.stack ?? error.message;
}

export function FohPaneError({
  error,
  subject,
  backTo,
  backLabel,
}: {
  error: unknown;
  /** What failed to open, e.g. "conversation" — used in the message and the heading. */
  subject: string;
  backTo: string;
  backLabel: string;
}) {
  const stack = paneErrorStack(error);
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-2 shrink-0 gap-0.5 px-1.5"
        >
          <Link to={backTo} aria-label={backLabel}>
            <ChevronLeft className="size-4" aria-hidden />
            {backLabel}
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Couldn&rsquo;t open this {subject}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <div className="mx-auto w-full max-w-2xl space-y-3">
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {paneErrorMessage(error, subject)}
          </p>
          {stack && (
            <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-xs">
              <code>{stack}</code>
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}
