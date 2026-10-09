import type { ReactNode } from "react";
import { Loader2, RotateCw, TriangleAlert } from "lucide-react";

import { Button } from "~/components/ui/button";

/** The viewers' "still fetching" line. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground"
    >
      <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
      {label}
    </p>
  );
}

/** A viewer that could not load, with a retry when trying again could help. */
export function Failure({
  message,
  onRetry,
  children,
}: {
  message: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-2 px-4 py-3 text-xs text-destructive"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="shrink-0 text-foreground"
        >
          <RotateCw /> Retry
        </Button>
      )}
      {children}
    </div>
  );
}

/** A quiet one-line note under or above a view: "only the first 1 MB", "first 2,000 rows". */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="border-t border-border/60 bg-background px-4 py-2 text-[11px] text-muted-foreground italic">
      {children}
    </p>
  );
}

export const CUT_NOTICE =
  "Showing the first 1 MB. Download the file for the rest.";
