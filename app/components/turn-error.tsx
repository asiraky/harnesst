import { Link } from "react-router";
import { useState } from "react";
import { Button } from "~/components/ui/button";

export function TurnError({
  message,
  detail,
  retryable,
  onRetry,
  busy,
}: {
  message: string;
  detail?: string | null;
  retryable?: boolean;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const authProvider =
    /(OpenAI Codex|OpenAI Platform|OpenRouter|Anthropic|Model provider) needs authentication/.exec(
      `${message} ${detail ?? ""}`,
    )?.[1];
  const errorDetail = detail || (authProvider ? message : null);
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap text-destructive">
        {authProvider
          ? `${authProvider} needs authentication. Reauthenticate the connection to resume this conversation with your existing model and effort selections.`
          : message}
      </p>
      {authProvider && (
        <Link className="text-sm underline" to="/settings/connections">
          Reauthenticate {authProvider}
        </Link>
      )}
      {(errorDetail || (retryable && onRetry)) && (
        <div className="flex flex-wrap items-center gap-3">
          {retryable && onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={busy}
            >
              Retry
            </Button>
          )}
          {errorDetail && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => setShowDetail((v) => !v)}
            >
              {showDetail ? "Hide details" : "Show details"}
            </button>
          )}
        </div>
      )}
      {showDetail && errorDetail && (
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs text-muted-foreground">
          {errorDetail}
        </pre>
      )}
    </div>
  );
}
