/**
 * Settings → Connections: workspace service connections (operator credentials harnesst uses on a
 * team's behalf, e.g. a Supabase access token for the ledger). The browser only ever sends a
 * token; it never receives one back.
 */
import { Database } from "lucide-react";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { LocalizedDateTime } from "~/components/localized-values";
import { accentText } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SecretInput } from "~/components/ui/secret-input";
import {
  SERVICE_PROVIDERS,
  type ServiceConnection,
  type ServiceProviderId,
} from "~/service-connections/providers";

type Result = { ok?: boolean; error?: string | null } | undefined;

const STATUS_BADGE: Record<
  ServiceConnection["status"],
  { variant: "success" | "warning" | "destructive"; label: string }
> = {
  active: { variant: "success", label: "Active" },
  expired: { variant: "warning", label: "Expired" },
  invalid: { variant: "destructive", label: "Rejected" },
};

export function ServiceConnectionsCard({
  connections,
  canManage,
}: {
  connections: ServiceConnection[];
  canManage: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className={`size-4 ${accentText.emerald}`} aria-hidden />
          Services
        </CardTitle>
        <CardDescription>
          Accounts harnesst uses to set up and maintain what your teams need,
          such as the ledger&rsquo;s Supabase database. Tokens are encrypted,
          used only by harnesst, and never given to agents. Link a connection to
          a team in its Setup.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {(Object.keys(SERVICE_PROVIDERS) as ServiceProviderId[]).map(
              (provider) => (
                <ServiceTokenDialog key={provider} provider={provider} />
              ),
            )}
          </div>
        )}
        {connections.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No service connections yet.
          </div>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {connections.map((c) => (
              <ServiceConnectionRow
                key={c.id}
                connection={c}
                canManage={canManage}
              />
            ))}
          </ul>
        )}
        {!canManage && (
          <p className="text-xs text-muted-foreground">
            Only workspace owners and admins can change service connections.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ServiceConnectionRow({
  connection,
  canManage,
}: {
  connection: ServiceConnection;
  canManage: boolean;
}) {
  const fetcher = useFetcher<Result>();
  const provider = SERVICE_PROVIDERS[connection.provider];
  const organizations = Array.isArray(connection.metadata.organizations)
    ? (connection.metadata.organizations as string[])
    : [];
  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium">{connection.label}</span>
            <span className="text-muted-foreground">
              {provider.displayName}
            </span>
            <Badge variant={STATUS_BADGE[connection.status].variant}>
              {STATUS_BADGE[connection.status].label}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {organizations.length > 0 && <>{organizations.join(", ")} · </>}
            Last verified{" "}
            {connection.lastVerifiedAt ? (
              <LocalizedDateTime value={connection.lastVerifiedAt} />
            ) : (
              "never"
            )}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={fetcher.state !== "idle"}
              onClick={() =>
                fetcher.submit(
                  { intent: "reverify-service", connectionId: connection.id },
                  { method: "post" },
                )
              }
            >
              {fetcher.state === "idle" ? "Re-verify" : "Checking…"}
            </Button>
            <ServiceTokenDialog
              provider={connection.provider}
              connection={connection}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={fetcher.state !== "idle"}
              onClick={() => {
                if (
                  window.confirm(
                    `Remove ${connection.label}? Teams using it can't install or update until they link another connection.`,
                  )
                )
                  fetcher.submit(
                    { intent: "remove-service", connectionId: connection.id },
                    { method: "post" },
                  );
              }}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
      {fetcher.data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {fetcher.data.error}
        </p>
      )}
    </li>
  );
}

/** Add a connection, or replace an existing one's token. */
function ServiceTokenDialog({
  provider,
  connection,
}: {
  provider: ServiceProviderId;
  connection?: ServiceConnection;
}) {
  const [open, setOpen] = useState(false);
  const info = SERVICE_PROVIDERS[provider];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={connection ? "outline" : "default"}
        >
          {connection ? "Replace token" : `Connect ${info.displayName}`}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {connection
              ? `Replace the ${connection.label} token`
              : `Connect ${info.displayName}`}
          </DialogTitle>
          <DialogDescription>
            {info.description} Create a token in{" "}
            <a
              href={info.tokenUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {info.displayName} account settings
            </a>
            . harnesst checks it with {info.displayName} before saving it.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ServiceTokenForm
            provider={provider}
            connection={connection}
            onDone={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ServiceTokenForm({
  provider,
  connection,
  onDone,
}: {
  provider: ServiceProviderId;
  connection?: ServiceConnection;
  onDone: () => void;
}) {
  const fetcher = useFetcher<Result>();
  const info = SERVICE_PROVIDERS[provider];
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) onDone();
  }, [fetcher.data, fetcher.state, onDone]);
  return (
    <fetcher.Form method="post" className="space-y-4">
      <input
        type="hidden"
        name="intent"
        value={connection ? "replace-service" : "connect-service"}
      />
      <input type="hidden" name="provider" value={provider} />
      {connection && (
        <input type="hidden" name="connectionId" value={connection.id} />
      )}
      <div className="space-y-1.5">
        <Label htmlFor="serviceLabel">Connection name</Label>
        <Input
          id="serviceLabel"
          name="label"
          required
          maxLength={80}
          defaultValue={connection?.label}
          placeholder={`e.g. ${info.displayName} production`}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="serviceToken">{info.credentialLabel}</Label>
        <SecretInput
          id="serviceToken"
          name="token"
          required
          revealLabel="token"
          wrapperClassName="w-full"
          className="w-full"
          placeholder={info.placeholder}
        />
      </div>
      {fetcher.data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {fetcher.data.error}
        </p>
      )}
      <Button type="submit" disabled={fetcher.state !== "idle"}>
        {fetcher.state === "idle"
          ? connection
            ? "Replace token"
            : "Connect"
          : "Verifying…"}
      </Button>
    </fetcher.Form>
  );
}
