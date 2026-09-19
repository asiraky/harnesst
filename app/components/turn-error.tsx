import { Link } from "react-router";
import { useState } from "react";
import {
  modelConnectionSettingsUrl,
  parseProviderModelReference,
  MODEL_PROVIDERS,
} from "~/models/provider-reference";
import { Button } from "~/components/ui/button";

export function TurnError({
  message,
  detail,
  recoveryModelId,
  retryable,
  onRetry,
  busy,
}: {
  message: string;
  detail?: string | null;
  recoveryModelId?: string | null;
  retryable?: boolean;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const reference = recoveryModelId
    ? parseProviderModelReference(recoveryModelId)
    : null;
  const provider = reference
    ? MODEL_PROVIDERS[reference.provider].displayName
    : null;
  const errorDetail = detail;
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap text-destructive">{message}</p>
      {reference && recoveryModelId && (
        <div className="space-y-1 text-sm">
          <Link
            className="underline"
            to={modelConnectionSettingsUrl(recoveryModelId)}
          >
            Review {provider} connection
          </Link>
          <p className="text-muted-foreground">
            If authentication is needed, ask a workspace owner or admin to
            reauthenticate this connection.
          </p>
        </div>
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
