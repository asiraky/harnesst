/**
 * Shared Secrets — the repo-level section (PLAN-SECRETS-REWORK §8). Project-level secrets are
 * defined once here and attached per member from each agent's Secrets card; nothing here grants
 * a member access (attachment is always an explicit per-agent act). Same fetcher-JSON intents,
 * same row anatomy and write-only stance as the member card; replace/delete dialogs state the
 * blast radius from the loader's `usedBy` rows so the confirm can render before submitting.
 */
import { useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { Copy, KeyRound, Lock, MoreHorizontal } from "lucide-react";

import { COPY, SECRET_NAME_RE, normalizeSecretName } from "~/components/secrets-card";
import { RelativeTime } from "~/components/localized-values";
import { SectionHeader } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SecretInput } from "~/components/ui/secret-input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { contextPath } from "~/lib/paths";
import { copyText } from "~/components/chat/clipboard";

const MASK = "••••••••";

export interface SharedSecretRowView {
  key: string;
  environmentId: string | null;
  fingerprint: string | null;
  updatedAt: string;
  sandboxExposed: boolean;
  usedBy: {
    agentName: string;
    sandboxExposed: boolean;
    requiredByTemplate: boolean;
  }[];
}

function SharedRow({
  row,
  projectId,
  isTeam,
  onFlash,
}: {
  row: SharedSecretRowView;
  projectId: string;
  isTeam: boolean;
  onFlash: (msg: string) => void;
}) {
  const replaceFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const deleteFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const defaultFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [showUsedBy, setShowUsedBy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [value, setValue] = useState("");
  const busy =
    replaceFetcher.state !== "idle" ||
    deleteFetcher.state !== "idle" ||
    defaultFetcher.state !== "idle";

  // Optimistic removal on delete; an error restores the row via revalidation.
  if (deleteFetcher.state !== "idle" || (deleteFetcher.data?.ok && !deleteFetcher.data?.error)) {
    return null;
  }

  const exposedDefault = defaultFetcher.formData
    ? defaultFetcher.formData.get("exposed") === "1"
    : row.sandboxExposed;
  const dependents = row.usedBy;
  const goesMissing = dependents.filter((d) => d.requiredByTemplate);

  const submitReplace = () => {
    if (!value) return;
    replaceFetcher.submit(
      { intent: "shared-secret-set", key: row.key, value },
      { method: "post" },
    );
    setReplacing(false);
    setValue("");
  };

  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound
          className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden
        />
        <span className="font-mono text-sm">{row.key}</span>
        <span className="select-none text-xs text-muted-foreground" aria-hidden>
          {MASK}
        </span>
        <Badge variant="outline">All envs</Badge>
        <div className="ml-auto flex items-center gap-2">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={exposedDefault}
                    disabled={busy}
                    aria-label={`Sandbox default for ${row.key}`}
                    onChange={(e) =>
                      defaultFetcher.submit(
                        {
                          intent: "shared-secret-expose-default",
                          key: row.key,
                          exposed: e.target.checked ? "1" : "0",
                        },
                        { method: "post" },
                      )
                    }
                  />
                  Sandbox default
                </Label>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                Default for new attachments only — agents that already attached this secret
                keep their own flag.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`Copy secret name ${row.key}`}
            onClick={() => {
              void copyText(row.key).then((ok) =>
                onFlash(
                  ok ? COPY.copyNameToast : "Couldn't copy to the clipboard.",
                ),
              );
            }}
          >
            <Copy className="size-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={busy}
                aria-label={`Actions for ${row.key}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setReplacing(true)}>
                Replace value…
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Set <RelativeTime value={row.updatedAt} />
        </span>
        <span aria-hidden>·</span>
        {row.fingerprint ? (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="font-mono underline-offset-4 hover:underline"
                  onClick={() => {
                    void copyText(row.fingerprint!).then((ok) =>
                      onFlash(
                        ok
                          ? "Fingerprint copied."
                          : "Couldn't copy to the clipboard.",
                      ),
                    );
                  }}
                >
                  fp {row.fingerprint.slice(0, 6)}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{COPY.fingerprintTooltip}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <span title="fingerprint unavailable — set before fingerprints existed">fp —</span>
        )}
        <span aria-hidden>·</span>
        <button
          type="button"
          className="underline-offset-4 hover:underline"
          aria-expanded={showUsedBy}
          onClick={() => setShowUsedBy((v) => !v)}
        >
          Used by {dependents.length} agent{dependents.length === 1 ? "" : "s"}{" "}
          {showUsedBy ? "▴" : "▾"}
        </button>
      </div>
      {showUsedBy && dependents.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 pl-4 text-xs text-muted-foreground">
          {dependents.map((d) => (
            <li key={d.agentName} className="flex items-center gap-2">
              <Link
                to={`${contextPath(projectId, isTeam ? d.agentName : null)}/settings`}
                className="font-mono underline-offset-4 hover:underline"
              >
                {d.agentName}
              </Link>
              <span>(sandbox {d.sandboxExposed ? "✓" : "–"})</span>
              {d.requiredByTemplate && <span>· required by its template</span>}
            </li>
          ))}
        </ul>
      )}
      {(replaceFetcher.data?.error || deleteFetcher.data?.error) && (
        <p className="mt-1 text-xs text-destructive">
          {replaceFetcher.data?.error ?? deleteFetcher.data?.error}
        </p>
      )}

      {/* Replace = rotation: dialog states the blast radius (§8, copy verbatim). */}
      <Dialog open={replacing} onOpenChange={setReplacing}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Replace {row.key}?</DialogTitle>
            <DialogDescription>
              {dependents.length > 0
                ? COPY.sharedReplaceConfirm(dependents.length)
                : COPY.replaceConfirm}
            </DialogDescription>
          </DialogHeader>
          <SecretInput
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="new value (write-only)"
            autoFocus
            revealLabel="value"
            className="font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitReplace();
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReplacing(false)}>
              Cancel
            </Button>
            <Button disabled={!value} onClick={submitReplace}>
              Replace value
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete: dependents listed by name; attachments cascade (§11.4). */}
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {row.key}?</DialogTitle>
            <DialogDescription>
              {dependents.length === 0
                ? "No agents are attached to this secret. The stored value can't be recovered."
                : `Detaches it from ${dependents
                    .map((d) => d.agentName)
                    .join(", ")}. The stored value can't be recovered.`}
              {goesMissing.length > 0 &&
                ` ${goesMissing.map((d) => d.agentName).join(", ")} will show it as a missing required secret.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteFetcher.submit(
                  { intent: "shared-secret-delete", key: row.key },
                  { method: "post" },
                );
                setDeleting(false);
              }}
            >
              {dependents.length > 0
                ? `Delete for ${dependents.length} agent${dependents.length === 1 ? "" : "s"}`
                : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

export function SharedSecretsSection({
  projectId,
  isTeam,
  shared,
}: {
  projectId: string;
  isTeam: boolean;
  shared: SharedSecretRowView[];
}) {
  const addFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [sandboxDefault, setSandboxDefault] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2500);
  };

  const collision = name.length > 0 && shared.some((s) => s.key === name);
  const canAdd = !!name && !!value && SECRET_NAME_RE.test(name) && !collision;
  const badge = useMemo(() => <Badge variant="secondary">{shared.length}</Badge>, [shared.length]);

  const submitAdd = () => {
    if (!canAdd) return;
    addFetcher.submit(
      {
        intent: "shared-secret-set",
        key: name,
        value,
        exposed: sandboxDefault ? "1" : "0",
      },
      { method: "post" },
    );
    setName("");
    setValue("");
    setSandboxDefault(false);
  };

  return (
    <section>
      <SectionHeader title="Shared Secrets" badges={badge} icon={KeyRound} accent="indigo" />
      <Card>
        <CardContent className="py-4">
          <p className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            <span>
              Define once, attach to any agent from its Secrets card. {COPY.sectionNote}
            </span>
          </p>
          {flash && (
            <p aria-live="polite" className="mb-2 text-xs text-muted-foreground">
              {flash}
            </p>
          )}

          {shared.length > 0 ? (
            <ul className="mb-4 divide-y rounded-lg border">
              {shared.map((row) => (
                <SharedRow
                  key={`${row.key}|${row.environmentId ?? ""}`}
                  row={row}
                  projectId={projectId}
                  isTeam={isTeam}
                  onFlash={doFlash}
                />
              ))}
            </ul>
          ) : (
            <p className="mb-4 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
              No shared secrets yet. Add one below, then attach it to agents that need it —
              attaching is always an explicit per-agent choice.
            </p>
          )}

          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}
          >
            <div className="grid w-full gap-1.5 sm:w-auto">
              <Label htmlFor="shared-add-name">Name</Label>
              <Input
                id="shared-add-name"
                value={name}
                placeholder="GITHUB_TOKEN"
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore=""
                className="w-full font-mono sm:w-52"
                onChange={(e) => {
                  setName(normalizeSecretName(e.target.value));
                  setNameError(null);
                }}
                onBlur={() => {
                  if (name && !SECRET_NAME_RE.test(name)) {
                    setNameError("Must be a valid env var name (A–Z, 0–9, _).");
                  }
                }}
              />
            </div>
            <div className="grid w-full gap-1.5 sm:w-auto">
              <Label htmlFor="shared-add-value">Value</Label>
              <SecretInput
                id="shared-add-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="value (write-only)"
                revealLabel="value"
                wrapperClassName="w-full sm:w-auto"
                className="w-full font-mono sm:w-60"
              />
            </div>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Label className="flex items-center gap-1.5 pb-2 text-xs font-normal text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={sandboxDefault}
                      onChange={(e) => setSandboxDefault(e.target.checked)}
                    />
                    Sandbox default
                  </Label>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">
                  Default for new attachments only.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button type="submit" disabled={!canAdd || addFetcher.state !== "idle"}>
              {addFetcher.state !== "idle" ? "Saving…" : "Add"}
            </Button>
            <div className="basis-full space-y-0.5">
              {nameError && <p className="text-xs text-destructive">{nameError}</p>}
              {collision && (
                <p className="text-xs text-destructive">
                  {name} already exists — use Replace on its row instead.
                </p>
              )}
              {addFetcher.data?.error && (
                <p className="text-xs text-destructive">{addFetcher.data.error}</p>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
