/**
 * The ledger's Setup UI: the install form, manual update, callback address, and wake checks.
 * The generic Setup page renders the workspace-connection picker above this and looks these
 * components up through app/provisioners/ui.tsx.
 */
import { Form, useNavigation } from "react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SecretInput } from "~/components/ui/secret-input";
import type { ProvisionerStepProps } from "../ui-types";
import type { LedgerSetupDetails } from "./provisioner.server";

function Hidden({ provisioner, op }: { provisioner: string; op: string }) {
  return (
    <>
      <input type="hidden" name="intent" value="provision" />
      <input type="hidden" name="provisioner" value={provisioner} />
      <input type="hidden" name="op" value={op} />
    </>
  );
}

export function LedgerInstall({
  provisioner,
  details,
  link,
  busy,
  needsUpdate,
  email,
  memberNames,
}: ProvisionerStepProps) {
  const navigation = useNavigation();
  const l = details as LedgerSetupDetails | null;
  if (!l) return null;
  const disabled = busy || navigation.state !== "idle";
  const installed = ["provisioned", "ready"].includes(l.status);
  const usable = link.state === "ready";
  return (
    <>
      <p role="status" className="text-sm">
        <strong>{l.step}</strong>
      </p>
      {(l.error || l.connectionError) && (
        <p role="alert" className="text-sm text-destructive">
          {l.error || l.connectionError}
        </p>
      )}
      {installed && needsUpdate && (
        <Form method="post" className="space-y-2">
          <Hidden provisioner={provisioner} op="update" />
          <p className="text-sm">
            A newer ledger version is available. Harnesst applies it
            automatically after each publish; update now to apply it straight
            away. Agents keep their keys.
          </p>
          <Button size="sm" disabled={disabled || !usable}>
            Update ledger
          </Button>
        </Form>
      )}
      {!installed && usable && (
        <Form method="post" className="space-y-2">
          <Hidden provisioner={provisioner} op="install" />
          <p className="text-sm">
            The ledger is the team&rsquo;s work tracker, in a Supabase project
            you own. Harnesst installs it with the workspace&rsquo;s Supabase
            connection and keeps it up to date after each publish. The
            connection&rsquo;s token is never given to agents.
          </p>
          <Label htmlFor="ref">Supabase project</Label>
          <select
            id="ref"
            name="ref"
            defaultValue={l.ref}
            required
            disabled={disabled}
            className="w-full rounded border bg-background p-2"
          >
            <option value="">Choose project</option>
            {l.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
          <Label htmlFor="publishableKey">Project publishable key</Label>
          <SecretInput
            id="publishableKey"
            name="publishableKey"
            revealLabel="publishable key"
            placeholder={
              l.savedKey
                ? "Use saved key for the matching project"
                : "sb_publishable_…"
            }
            required={!l.savedKey}
            disabled={disabled}
          />
          <Label htmlFor="email">Engineering and UAT approver email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            defaultValue={email}
            required
            disabled={disabled}
          />
          <Label htmlFor="origin">Public harnesst address</Label>
          <Input
            id="origin"
            name="origin"
            type="url"
            defaultValue={l.origin}
            placeholder="https://your-harnesst-host"
            required
            disabled={disabled}
          />
          <p className="text-sm text-muted-foreground">
            Supabase must reach this address to wake agents. In local
            development, the harnesst host must have its HTTPS tunnel running.
          </p>
          {l.roles.map((role) => (
            <div key={role}>
              <Label htmlFor={`member-${role}`}>{role} agent</Label>
              <Input
                id={`member-${role}`}
                name={`member:${role}`}
                defaultValue={l.members[role]}
                list="setup-members"
                required
                disabled={disabled}
              />
            </div>
          ))}
          <datalist id="setup-members">
            {memberNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <p className="text-sm text-muted-foreground">
            Use a dedicated Supabase project for this team. Retrying preserves
            existing work and keys.
          </p>
          <Button size="sm" disabled={disabled}>
            {disabled
              ? "Installing…"
              : l.status === "failed"
                ? "Retry installation"
                : "Install ledger"}
          </Button>
        </Form>
      )}
      {installed && (
        <details className="text-sm">
          <summary>Update public address</summary>
          <p className="mt-2">
            Enter the new address, then re-run the installation. Harnesst
            preserves actor credentials.
          </p>
          <Form method="post" className="mt-2 space-y-2">
            <Hidden provisioner={provisioner} op="origin" />
            <Label htmlFor="updated-origin">Public harnesst address</Label>
            <Input
              id="updated-origin"
              name="origin"
              type="url"
              defaultValue={l.origin}
              required
            />
            <Button size="sm" disabled={disabled || !usable}>
              Update address
            </Button>
          </Form>
        </details>
      )}
    </>
  );
}

export function LedgerVerify({
  provisioner,
  details,
  busy,
}: ProvisionerStepProps) {
  const navigation = useNavigation();
  const l = details as LedgerSetupDetails | null;
  if (l?.status !== "provisioned")
    return (
      <p className="text-sm text-muted-foreground">
        Available once the ledger is installed and the agents are published.
      </p>
    );
  return (
    <Form method="post" className="space-y-2">
      <Hidden provisioner={provisioner} op="verify" />
      <p className="text-sm">
        Checks that every agent is deployed and that the ledger can wake each of
        them.
      </p>
      <Button size="sm" disabled={busy || navigation.state !== "idle"}>
        Check deployment and callbacks
      </Button>
    </Form>
  );
}
