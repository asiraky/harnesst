/**
 * Secrets card — the per-member secrets surface of the secrets rework (PLAN-SECRETS-REWORK §7).
 *
 * Four groups in one card: Required by template (missing only) → This agent's secrets → Shared
 * with project (opt-in attach toggles) → Add form, plus a collapsed "Dismissed requirements".
 * Every mutation is a useFetcher intent against the settings action — JSON in, JSON out, no
 * document navigation, no page reload (the old <Form>+redirect jank, gripes #1–#3). Env pills
 * are pure client state synced to `?env=` with history.replaceState (no navigation); non-matching
 * rows dim rather than hide.
 *
 * Values are write-only end-to-end: nothing here ever renders a stored value — the substitutes
 * are the fixed eight-dot mask, the SHA-256 fingerprint prefix, and set-audit metadata.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFetcher } from "react-router";
import { Copy, KeyRound, Lock, MoreHorizontal } from "lucide-react";

import { RelativeTime } from "~/components/localized-values";
import { SectionHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

const ALL = "all";

// ── Canonical copy (§10 — verbatim) ──────────────────────────────────────────
export const COPY = {
  sectionNote:
    "Values are encrypted write-only — they can be replaced but never viewed, even by you.",
  whyPopover:
    "harnesst never exposes secret values after save, so a compromised browser session or screen-share can't leak them. To rotate a secret, replace its value.",
  fingerprintTooltip:
    "A one-way fingerprint of the value. Compare it against a value you hold to check they match. The value itself is never shown.",
  copyNameToast:
    "Name copied. Values can't be copied — harnesst stores them write-only.",
  sandboxTooltip:
    "Adds this variable to the agent's terminal environment at deploy. Leave off for secrets only harnesst's tools should use.",
  requiredBadge: "Required — not set",
  replaceConfirm:
    "Replacing overwrites the stored value immediately. The old value can't be recovered.",
  sharedReplaceConfirm: (n: number) =>
    `${n} agents use this secret. The new value applies to all of them on their next deploy.`,
  deployDialogTitle: "Missing required secrets",
  installDeferral:
    "Values are held securely and attached when the agent goes live. Held values are discarded if the install is cancelled.",
  detachWarning: (agent: string, name: string) =>
    `${agent}'s template requires ${name}. Detaching will mark it missing.`,
} as const;

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fixed mask — never length-proportional (a value's length is itself information). */
const MASK = "••••••••";

// ── View types ───────────────────────────────────────────────────────────────

export interface SecretRowView {
  key: string;
  environmentId: string | null;
  sandboxExposed: boolean;
  fingerprint: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/** A template requirement from the lock (§4.5) that hasn't been satisfied. */
export interface RequiredSecretView {
  name: string;
  description?: string;
  sandbox?: boolean;
  /** Template ids requiring this name — first shown, rest as `+n` (§11.6). */
  sources: string[];
  /** A shared secret with this name exists — offer Attach (never auto-attach, §11.2). */
  sharedExists: boolean;
}

export interface SharedSecretView {
  key: string;
  environmentId: string | null;
  fingerprint: string | null;
  updatedAt: string;
  /** The shared default seeded into new attachments. */
  sandboxExposed: boolean;
}

export interface AttachmentView {
  key: string;
  sandboxExposed: boolean;
}

export interface SecretsCardProps {
  activeAgent: string;
  isTeam: boolean;
  envs: { id: string; name: string }[];
  secrets: SecretRowView[];
  initialEnvId: string | null;
  secretsConfigured: boolean;
  secretsError: string | null;
  /** Missing template requirements (already excludes set/attached/dismissed names). */
  required?: RequiredSecretView[];
  /** Dismissed requirement rows (recoverable). */
  dismissed?: { name: string; sources: string[] }[];
  /** Project-level shared secrets (all of them; attach state says which apply here). */
  shared?: SharedSecretView[];
  /** This member's attachments. */
  attachments?: AttachmentView[];
  /** Names required by templates (set or not) — powers the detach warning (§10). */
  requiredNames?: string[];
}

// ── Small shared pieces ──────────────────────────────────────────────────────

/** Auto-uppercase a name as typed: spaces/dashes → underscores, lowercase → upper (§7). */
export function normalizeSecretName(raw: string): string {
  return raw.toUpperCase().replace(/[ -]+/g, "_").replace(/[^A-Z0-9_]/g, "");
}

function envLabel(
  environmentId: string | null,
  envs: { id: string; name: string }[],
): string {
  if (environmentId === null) return "All envs";
  return envs.find((e) => e.id === environmentId)?.name ?? "unknown env";
}

/** Transient inline "toast" — small, self-clearing, announced politely. */
function useFlash(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2500);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [msg, flash];
}

function GroupHeading({ children }: { children: ReactNode }) {
  return (
    <p className="mt-5 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:mt-0">
      {children}
    </p>
  );
}

/** Metadata line: `Set 12d ago · fp a3f9c2` — fp click copies the full hash (§7). */
function MetaLine({
  updatedAt,
  fingerprint,
  onCopied,
}: {
  updatedAt: string;
  fingerprint: string | null;
  onCopied: (msg: string) => void;
}) {
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>
        Set <RelativeTime value={updatedAt} />
      </span>
      <span aria-hidden>·</span>
      {fingerprint ? (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="font-mono underline-offset-4 hover:underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(fingerprint);
                  onCopied("Fingerprint copied.");
                }}
              >
                fp {fingerprint.slice(0, 6)}
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {COPY.fingerprintTooltip}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span title="fingerprint unavailable — set before fingerprints existed">
          fp —
        </span>
      )}
    </span>
  );
}

/** Sandbox checkbox with the canonical tooltip. Optimistic via its own fetcher. */
function SandboxToggle({
  checked,
  disabled,
  label = "Sandbox",
  onChange,
  name,
}: {
  checked: boolean;
  disabled?: boolean;
  label?: string;
  onChange: (next: boolean) => void;
  name: string;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Label className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              aria-label={`Expose ${name} to the agent's sandbox shell`}
              onChange={(e) => onChange(e.target.checked)}
            />
            {label}
          </Label>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{COPY.sandboxTooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Copy-NAME icon (values can't be copied — write-only). */
function CopyNameButton({
  name,
  onCopied,
}: {
  name: string;
  onCopied: (msg: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={`Copy secret name ${name}`}
      onClick={() => {
        void navigator.clipboard?.writeText(name);
        onCopied(COPY.copyNameToast);
      }}
    >
      <Copy className="size-3.5" />
    </Button>
  );
}

// ── Agent secret row ─────────────────────────────────────────────────────────

function AgentSecretRow({
  row,
  envs,
  activeAgent,
  activeEnvId,
  overridesShared,
  justAdded,
  onCopied,
}: {
  row: SecretRowView;
  envs: { id: string; name: string }[];
  activeAgent: string;
  activeEnvId: string | null | typeof ALL;
  overridesShared: boolean;
  justAdded: boolean;
  onCopied: (msg: string) => void;
}) {
  const exposeFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const deleteFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const replaceFetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    secret?: { fingerprint: string | null; updatedAt: string };
  }>();
  const [replacing, setReplacing] = useState(false);
  const [replaceValue, setReplaceValue] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rowEnvValue = row.environmentId ?? ALL;
  // §11.7 — row actions disable while ANY fetcher for this row is in flight.
  const rowBusy =
    exposeFetcher.state !== "idle" ||
    deleteFetcher.state !== "idle" ||
    replaceFetcher.state !== "idle";

  // Optimistic delete: the row disappears on submit; an error restores it.
  useEffect(() => {
    if (deleteFetcher.state === "idle" && deleteFetcher.data?.error) {
      setDeleteError(deleteFetcher.data.error);
    }
  }, [deleteFetcher.state, deleteFetcher.data]);
  const deleting = deleteFetcher.state !== "idle" && !deleteError;
  if (deleting) return null;

  // Optimistic expose flag while the flip is in flight (the proven toggle pattern).
  const exposed = exposeFetcher.formData
    ? exposeFetcher.formData.get("exposed") === "1"
    : row.sandboxExposed;

  // Optimistic replace metadata: "Set just now" the moment Save is pressed.
  const replaced = replaceFetcher.data?.ok ? replaceFetcher.data.secret : null;
  const optimisticReplace = replaceFetcher.state !== "idle";
  const updatedAt = optimisticReplace
    ? new Date().toISOString()
    : (replaced?.updatedAt ?? row.updatedAt);
  const fingerprint = optimisticReplace
    ? null
    : (replaced?.fingerprint ?? row.fingerprint);

  const dimmed =
    activeEnvId !== ALL &&
    row.environmentId !== null &&
    row.environmentId !== activeEnvId;

  const submitReplace = () => {
    if (!replaceValue) return;
    replaceFetcher.submit(
      {
        intent: "secret-replace",
        agent: activeAgent,
        env: rowEnvValue,
        key: row.key,
        value: replaceValue,
      },
      { method: "post" },
    );
    setReplacing(false);
    setReplaceValue("");
  };

  return (
    <li
      className={cn(
        "px-4 py-2 transition-colors",
        dimmed && "opacity-50",
        justAdded && "bg-emerald-500/10",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-emerald-600 dark:text-emerald-400" aria-hidden>
          ✓
        </span>
        <span className="font-mono text-sm">{row.key}</span>
        <span className="select-none text-xs text-muted-foreground" aria-hidden>
          {MASK}
        </span>
        <Badge variant={row.environmentId ? "secondary" : "outline"}>
          {envLabel(row.environmentId, envs)}
        </Badge>
        {overridesShared && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="text-xs">
                  overrides shared
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                An agent-level secret with this name shadows the attached shared
                one. Delete this value to fall back to the shared secret.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <div className="ml-auto flex items-center gap-2">
          <SandboxToggle
            name={row.key}
            checked={exposed}
            disabled={rowBusy}
            onChange={(next) =>
              exposeFetcher.submit(
                {
                  intent: "secret-expose",
                  key: row.key,
                  env: rowEnvValue,
                  agent: activeAgent,
                  exposed: next ? "1" : "0",
                },
                { method: "post" },
              )
            }
          />
          <CopyNameButton name={row.key} onCopied={onCopied} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={rowBusy}
                aria-label={`Actions for ${row.key}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setReplacing(true)}>
                Replace value…
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  setDeleteError(null);
                  deleteFetcher.submit(
                    {
                      intent: "secret-delete",
                      agent: activeAgent,
                      env: rowEnvValue,
                      key: row.key,
                    },
                    { method: "post" },
                  );
                }}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-6">
        {optimisticReplace ? (
          <span className="text-xs text-muted-foreground">Set just now · saving…</span>
        ) : (
          <MetaLine
            updatedAt={updatedAt}
            fingerprint={fingerprint}
            onCopied={onCopied}
          />
        )}
      </div>
      {deleteError && (
        <p className="mt-1 pl-6 text-xs text-destructive">
          Couldn&rsquo;t delete: {deleteError}
        </p>
      )}
      {replaceFetcher.data?.error && !replacing && (
        <p className="mt-1 pl-6 text-xs text-destructive">
          Couldn&rsquo;t replace: {replaceFetcher.data.error}
        </p>
      )}
      {replacing && (
        <div className="mt-2 space-y-1.5 pl-6">
          <p className="text-xs text-muted-foreground">{COPY.replaceConfirm}</p>
          <div className="flex flex-wrap items-center gap-2">
            <SecretInput
              value={replaceValue}
              onChange={(e) => setReplaceValue(e.target.value)}
              placeholder="new value (write-only)"
              autoFocus
              revealLabel="value"
              wrapperClassName="w-full sm:w-auto"
              className="w-full font-mono sm:w-64"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitReplace();
                }
              }}
            />
            <Button type="button" size="sm" disabled={!replaceValue} onClick={submitReplace}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setReplacing(false);
                setReplaceValue("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Required-by-template row (§7) ────────────────────────────────────────────

function RequiredSecretRow({
  req,
  activeAgent,
  activeEnvId,
  onCopied,
}: {
  req: RequiredSecretView;
  activeAgent: string;
  activeEnvId: string | null | typeof ALL;
  onCopied: (msg: string) => void;
}) {
  const setFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const attachFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const dismissFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [value, setValue] = useState("");
  const [enteringOwn, setEnteringOwn] = useState(!req.sharedExists);
  const [sandbox, setSandbox] = useState(req.sandbox ?? false);
  const busy =
    setFetcher.state !== "idle" ||
    attachFetcher.state !== "idle" ||
    dismissFetcher.state !== "idle";

  // Optimistically drop the row once a save/attach/dismiss lands (revalidation confirms).
  if (
    (setFetcher.data?.ok && setFetcher.state === "idle") ||
    (attachFetcher.data?.ok && attachFetcher.state === "idle") ||
    (dismissFetcher.data?.ok && dismissFetcher.state === "idle")
  ) {
    return null;
  }
  void activeEnvId;

  const source = req.sources[0] ?? "template";
  const extra = req.sources.length - 1;

  const save = () => {
    if (!value) return;
    setFetcher.submit(
      {
        intent: "secret-set",
        agent: activeAgent,
        env: ALL,
        key: req.name,
        value,
        exposed: sandbox ? "1" : "0",
      },
      { method: "post" },
    );
    setValue("");
  };

  return (
    <li className="border-l-2 border-amber-500 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-amber-600 dark:text-amber-400" aria-hidden>
          ⚠
        </span>
        <span className="font-mono text-sm">{req.name}</span>
        <Badge variant="warning">{COPY.requiredBadge}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          required · {source}
          {extra > 0 && ` +${extra}`}
        </span>
        <CopyNameButton name={req.name} onCopied={onCopied} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              aria-label={`Actions for ${req.name}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() =>
                dismissFetcher.submit(
                  {
                    intent: "secret-dismiss",
                    agent: activeAgent,
                    key: req.name,
                    dismissed: "1",
                  },
                  { method: "post" },
                )
              }
            >
              Mark as not needed
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {req.description && (
        <p className="mt-0.5 pl-6 text-xs text-muted-foreground">
          &ldquo;{req.description}&rdquo;
        </p>
      )}
      <div className="mt-2 space-y-1.5 pl-6">
        {req.sharedExists && !enteringOwn ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                attachFetcher.submit(
                  {
                    intent: "secret-attach",
                    agent: activeAgent,
                    key: req.name,
                    exposed: (req.sandbox ?? false) ? "1" : "0",
                  },
                  { method: "post" },
                )
              }
            >
              Attach it
            </Button>
            <span className="text-xs text-muted-foreground">
              A project-level {req.name} exists — attach it, or{" "}
              <button
                type="button"
                className="underline underline-offset-4"
                onClick={() => setEnteringOwn(true)}
              >
                enter an agent-specific value
              </button>
              .
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <SecretInput
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="value (write-only)"
              revealLabel="value"
              wrapperClassName="w-full sm:w-auto"
              className="w-full font-mono sm:w-64"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
              }}
            />
            <SandboxToggle
              name={req.name}
              checked={sandbox}
              disabled={busy}
              label={req.sandbox ? "Sandbox (from template)" : "Sandbox"}
              onChange={setSandbox}
            />
            <Button type="button" size="sm" disabled={busy || !value} onClick={save}>
              Save
            </Button>
            {req.sharedExists && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-4"
                onClick={() => setEnteringOwn(false)}
              >
                use the shared secret instead
              </button>
            )}
          </div>
        )}
        {req.sandbox && (
          <p className="text-xs text-muted-foreground">Sandbox pre-set by template.</p>
        )}
        {(setFetcher.data?.error || attachFetcher.data?.error) && (
          <p className="text-xs text-destructive">
            {setFetcher.data?.error ?? attachFetcher.data?.error}
          </p>
        )}
      </div>
    </li>
  );
}

// ── Shared-with-project row (§7) ─────────────────────────────────────────────

function SharedSecretRow({
  row,
  envs,
  activeAgent,
  attachment,
  overriddenByAgent,
  requiredByTemplate,
  activeEnvId,
  onCopied,
}: {
  row: SharedSecretView;
  envs: { id: string; name: string }[];
  activeAgent: string;
  attachment: AttachmentView | null;
  overriddenByAgent: boolean;
  requiredByTemplate: boolean;
  activeEnvId: string | null | typeof ALL;
  onCopied: (msg: string) => void;
}) {
  const attachFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const exposeFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const busy = attachFetcher.state !== "idle" || exposeFetcher.state !== "idle";

  // Optimistic attach state while the toggle is in flight.
  const attached = attachFetcher.formData
    ? attachFetcher.formData.get("intent") === "secret-attach"
    : attachment !== null;
  const exposed = exposeFetcher.formData
    ? exposeFetcher.formData.get("exposed") === "1"
    : (attachment?.sandboxExposed ?? row.sandboxExposed);

  const dimmed =
    (activeEnvId !== ALL &&
      row.environmentId !== null &&
      row.environmentId !== activeEnvId) ||
    (!attached && !overriddenByAgent);

  return (
    <li className={cn("px-4 py-2", dimmed && "opacity-60", overriddenByAgent && "opacity-50")}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className={
            attached
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
          }
        >
          {attached ? "●" : "○"}
        </span>
        <span className="font-mono text-sm">{row.key}</span>
        <span className="select-none text-xs text-muted-foreground" aria-hidden>
          {attached ? MASK : "········"}
        </span>
        <Badge variant={row.environmentId ? "secondary" : "outline"}>
          {envLabel(row.environmentId, envs)}
        </Badge>
        <Badge
          variant="outline"
          className="border-indigo-500/40 text-indigo-600 dark:text-indigo-400"
        >
          Shared
        </Badge>
        {overriddenByAgent && (
          <span className="text-xs text-muted-foreground">overridden above</span>
        )}
        {!overriddenByAgent && (
          <div className="ml-auto flex items-center gap-2">
            <Label className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <input
                type="checkbox"
                checked={attached}
                disabled={busy}
                aria-label={`Attach shared secret ${row.key} to ${activeAgent}`}
                onChange={(e) =>
                  attachFetcher.submit(
                    {
                      intent: e.target.checked ? "secret-attach" : "secret-detach",
                      agent: activeAgent,
                      key: row.key,
                      // Attach seeds the per-attachment sandbox flag from the shared default.
                      ...(e.target.checked ? { exposed: row.sandboxExposed ? "1" : "0" } : {}),
                    },
                    { method: "post" },
                  )
                }
              />
              Attach
            </Label>
            <CopyNameButton name={row.key} onCopied={onCopied} />
          </div>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-3 pl-6">
        {attached && !overriddenByAgent ? (
          <>
            <MetaLine updatedAt={row.updatedAt} fingerprint={row.fingerprint} onCopied={onCopied} />
            <SandboxToggle
              name={row.key}
              checked={exposed}
              disabled={busy}
              label="Sandbox (this agent)"
              onChange={(next) =>
                exposeFetcher.submit(
                  {
                    intent: "secret-attach",
                    agent: activeAgent,
                    key: row.key,
                    exposed: next ? "1" : "0",
                  },
                  { method: "post" },
                )
              }
            />
          </>
        ) : !overriddenByAgent ? (
          <span className="text-xs text-muted-foreground">
            Project secret · not attached
          </span>
        ) : null}
      </div>
      {/* Detach-while-required warning (§10, verbatim) — shown before/after the fact. */}
      {requiredByTemplate && attached && !overriddenByAgent && (
        <p className="mt-1 pl-6 text-xs text-amber-700 dark:text-amber-400">
          {COPY.detachWarning(activeAgent, row.key)}
        </p>
      )}
      {attachFetcher.data?.error && (
        <p className="mt-1 pl-6 text-xs text-destructive">{attachFetcher.data.error}</p>
      )}
    </li>
  );
}

// ── Pending add rows (optimistic, one fetcher per in-flight add) ─────────────

interface PendingAdd {
  id: number;
  key: string;
  env: string; // env id or "all"
  value: string;
  exposed: boolean;
}

function PendingAddRow({
  pending,
  envs,
  activeAgent,
  onDone,
  onDiscard,
}: {
  pending: PendingAdd;
  envs: { id: string; name: string }[];
  activeAgent: string;
  onDone: (id: number, key: string, env: string) => void;
  onDiscard: (id: number) => void;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const submitted = useRef(false);
  const submit = () =>
    fetcher.submit(
      {
        intent: "secret-set",
        agent: activeAgent,
        env: pending.env,
        key: pending.key,
        value: pending.value,
        exposed: pending.exposed ? "1" : "0",
      },
      { method: "post" },
    );

  useEffect(() => {
    if (!submitted.current) {
      submitted.current = true;
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      onDone(pending.id, pending.key, pending.env);
    }
  }, [fetcher.state, fetcher.data, onDone, pending.id, pending.key, pending.env]);

  const failed = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok;

  if (failed) {
    // Error row: red border + server message + Retry/Discard. The fetcher retains the
    // payload — the value is NEVER dumped back into the form (§7).
    return (
      <li className="border-l-2 border-destructive px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">{pending.key}</span>
          <span className="select-none text-xs text-muted-foreground" aria-hidden>
            {MASK}
          </span>
          <Badge variant="outline">
            {pending.env === ALL ? "All envs" : envLabel(pending.env, envs)}
          </Badge>
          <span className="text-xs text-destructive">{fetcher.data?.error}</span>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={submit}>
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onDiscard(pending.id)}
            >
              Discard
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="px-4 py-2 opacity-60">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-emerald-600 dark:text-emerald-400" aria-hidden>
          ✓
        </span>
        <span className="font-mono text-sm">{pending.key}</span>
        <span className="select-none text-xs text-muted-foreground" aria-hidden>
          {MASK}
        </span>
        <Badge variant="outline">
          {pending.env === ALL ? "All envs" : envLabel(pending.env, envs)}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">Saving…</span>
      </div>
    </li>
  );
}

// ── Add form (§7) ────────────────────────────────────────────────────────────

function AddSecretForm({
  envs,
  activeAgent,
  activeEnvId,
  existing,
  sharedNames,
  disabled,
  onSubmit,
}: {
  envs: { id: string; name: string }[];
  activeAgent: string;
  activeEnvId: string | null | typeof ALL;
  /** (name, envId|null) pairs that already exist at agent level — collision check. */
  existing: { key: string; environmentId: string | null }[];
  sharedNames: Set<string>;
  disabled: boolean;
  onSubmit: (add: Omit<PendingAdd, "id">) => void;
}) {
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [env, setEnv] = useState<string>(
    activeEnvId === ALL || activeEnvId === null ? ALL : activeEnvId,
  );
  const [exposed, setExposed] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Env select defaults to the active pill; follow pill changes until the user touches it.
  const touchedEnv = useRef(false);
  useEffect(() => {
    if (!touchedEnv.current) {
      setEnv(activeEnvId === ALL || activeEnvId === null ? ALL : activeEnvId);
    }
  }, [activeEnvId]);

  const envIdOrNull = env === ALL ? null : env;
  // Live collision check per (name, env) — §11.3.
  const collision =
    name.length > 0 &&
    existing.some((e) => e.key === name && e.environmentId === envIdOrNull);
  const sharedMatch = name.length > 0 && sharedNames.has(name);

  const canAdd = !disabled && !!name && !!value && SECRET_NAME_RE.test(name) && !collision;

  const submit = () => {
    if (!canAdd) return;
    onSubmit({ key: name, env, value, exposed });
    // Inputs clear immediately; focus returns to Name for rapid multi-add (§7).
    setName("");
    setValue("");
    setExposed(false);
    setNameError(null);
    nameRef.current?.focus();
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-0 flex-1 gap-1.5 sm:max-w-52">
          <Label htmlFor="secret-add-name">Name</Label>
          <Input
            id="secret-add-name"
            ref={nameRef}
            value={name}
            placeholder="API_KEY"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore=""
            className="w-full font-mono"
            aria-invalid={!!nameError || collision}
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
        <div className="grid min-w-0 flex-1 gap-1.5 sm:max-w-60">
          <Label htmlFor="secret-add-value">Value</Label>
          <SecretInput
            id="secret-add-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value (write-only)"
            revealLabel="value"
            wrapperClassName="w-full"
            className="w-full font-mono"
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Env</Label>
          <Select
            value={env}
            onValueChange={(v) => {
              touchedEnv.current = true;
              setEnv(v);
            }}
          >
            <SelectTrigger className="h-9 w-full min-w-36" aria-label="Environment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All environments</SelectItem>
              {envs.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <SandboxToggle
          name={name || "this secret"}
          label="Expose to sandbox"
          checked={exposed}
          onChange={setExposed}
        />
        <Button type="submit" disabled={!canAdd}>
          Add
        </Button>
      </div>
      {(nameError || collision || (sharedMatch && !collision)) && (
        <div className="space-y-0.5">
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          {collision && (
            <p className="text-xs text-destructive">
              {name} already exists for{" "}
              {envIdOrNull === null ? "all environments" : envLabel(envIdOrNull, envs)} — use
              Replace on its row instead.
            </p>
          )}
          {sharedMatch && !collision && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              A project-level {name} exists — consider attaching the shared secret instead
              (see Shared with project above).
            </p>
          )}
        </div>
      )}
    </form>
  );
}

// ── The card ─────────────────────────────────────────────────────────────────

export function SecretsCard({
  activeAgent,
  isTeam,
  envs,
  secrets,
  initialEnvId,
  secretsConfigured,
  secretsError,
  required = [],
  dismissed = [],
  shared = [],
  attachments = [],
  requiredNames = [],
}: SecretsCardProps) {
  // Env pills: pure client state; sync to ?env= via history.replaceState (NO navigation, §7).
  const [activeEnv, setActiveEnv] = useState<string>(initialEnvId ?? ALL);
  const selectEnv = (id: string) => {
    setActiveEnv(id);
    const url = new URL(window.location.href);
    if (id === ALL) url.searchParams.delete("env");
    else url.searchParams.set("env", id);
    window.history.replaceState(null, "", url);
  };

  const [flash, doFlash] = useFlash();

  // Pending optimistic adds (multiple in-flight allowed — one fetcher per row).
  const [pendingAdds, setPendingAdds] = useState<PendingAdd[]>([]);
  const nextId = useRef(1);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const addPending = (add: Omit<PendingAdd, "id">) =>
    setPendingAdds((p) => [...p, { ...add, id: nextId.current++ }]);
  const finishPending = (id: number, key: string, env: string) => {
    setPendingAdds((p) => p.filter((a) => a.id !== id));
    const mark = `${key}|${env === ALL ? "" : env}`;
    setJustAdded((s) => new Set(s).add(mark));
    setTimeout(
      () =>
        setJustAdded((s) => {
          const next = new Set(s);
          next.delete(mark);
          return next;
        }),
      1200,
    );
  };
  const discardPending = (id: number) =>
    setPendingAdds((p) => p.filter((a) => a.id !== id));

  const [showDismissed, setShowDismissed] = useState(false);
  const restoreFetcher = useFetcher<{ ok?: boolean }>();

  const attachmentByKey = useMemo(
    () => new Map(attachments.map((a) => [a.key, a])),
    [attachments],
  );
  const agentNames = useMemo(() => new Set(secrets.map((s) => s.key)), [secrets]);
  const sharedNames = useMemo(() => new Set(shared.map((s) => s.key)), [shared]);
  const requiredNameSet = useMemo(() => new Set(requiredNames), [requiredNames]);

  // Rows sorted by (name, env-label) — groups a name's per-env lines together (§11.3).
  const sortedSecrets = useMemo(
    () =>
      [...secrets].sort((a, b) =>
        a.key !== b.key
          ? a.key < b.key
            ? -1
            : 1
          : (a.environmentId ?? "") < (b.environmentId ?? "")
            ? -1
            : 1,
      ),
    [secrets],
  );
  const sortedShared = useMemo(
    () => [...shared].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    [shared],
  );

  const badge = useMemo(
    () => <Badge variant="secondary">{secrets.length}</Badge>,
    [secrets.length],
  );

  return (
    <section>
      <SectionHeader title="Secrets" badges={badge} icon={KeyRound} accent="brand" />
      <Card>
        <CardContent className="py-4">
          {/* Header row: env pills + the write-only note with its Why popover. */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div
              className="flex items-center gap-1 overflow-x-auto"
              role="tablist"
              aria-label="Environment filter"
            >
              {[{ id: ALL, name: "All" }, ...envs].map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={activeEnv === e.id}
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1 text-xs transition-colors",
                    activeEnv === e.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => selectEnv(e.id)}
                >
                  {e.name}
                </button>
              ))}
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5" aria-hidden />
              <span>{COPY.sectionNote}</span>
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="underline underline-offset-4">
                    Why?
                  </button>
                </PopoverTrigger>
                <PopoverContent className="max-w-72 text-xs">
                  {COPY.whyPopover}
                </PopoverContent>
              </Popover>
            </p>
          </div>
          {isTeam && (
            <p className="mb-3 text-xs text-muted-foreground">
              Scoped to this agent only — other agents cannot read its
              credentials. Values are injected at deploy time.
            </p>
          )}

          {flash && (
            <p aria-live="polite" className="mb-2 text-xs text-muted-foreground">
              {flash}
            </p>
          )}

          {!secretsConfigured && (
            <Alert className="mb-4">
              <AlertTitle>Secrets store not configured.</AlertTitle>
              <AlertDescription>{secretsError}</AlertDescription>
            </Alert>
          )}

          {/* Required by template — missing only (§7). */}
          {required.length > 0 && (
            <>
              <GroupHeading>Required by template</GroupHeading>
              <ul className="divide-y rounded-lg border">
                {required.map((req) => (
                  <RequiredSecretRow
                    key={req.name}
                    req={req}
                    activeAgent={activeAgent}
                    activeEnvId={activeEnv === ALL ? ALL : activeEnv}
                    onCopied={doFlash}
                  />
                ))}
              </ul>
            </>
          )}

          {/* This agent's secrets. */}
          <GroupHeading>This agent&rsquo;s secrets</GroupHeading>
          {sortedSecrets.length === 0 && pendingAdds.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
              No secrets yet. Add one below — the value is encrypted on save.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {pendingAdds.map((p) => (
                <PendingAddRow
                  key={p.id}
                  pending={p}
                  envs={envs}
                  activeAgent={activeAgent}
                  onDone={finishPending}
                  onDiscard={discardPending}
                />
              ))}
              {sortedSecrets.map((row) => (
                <AgentSecretRow
                  key={`${row.key}|${row.environmentId ?? ""}`}
                  row={row}
                  envs={envs}
                  activeAgent={activeAgent}
                  activeEnvId={activeEnv === ALL ? ALL : activeEnv}
                  overridesShared={
                    sharedNames.has(row.key) && attachmentByKey.has(row.key)
                  }
                  justAdded={justAdded.has(`${row.key}|${row.environmentId ?? ""}`)}
                  onCopied={doFlash}
                />
              ))}
            </ul>
          )}

          {/* Shared with project (§7): every project shared secret, attach opt-in. */}
          {sortedShared.length > 0 && (
            <>
              <GroupHeading>Shared with project</GroupHeading>
              <ul className="divide-y rounded-lg border">
                {sortedShared.map((row) => (
                  <SharedSecretRow
                    key={`${row.key}|${row.environmentId ?? ""}`}
                    row={row}
                    envs={envs}
                    activeAgent={activeAgent}
                    attachment={attachmentByKey.get(row.key) ?? null}
                    overriddenByAgent={
                      agentNames.has(row.key) && attachmentByKey.has(row.key)
                    }
                    requiredByTemplate={requiredNameSet.has(row.key)}
                    activeEnvId={activeEnv === ALL ? ALL : activeEnv}
                    onCopied={doFlash}
                  />
                ))}
              </ul>
            </>
          )}

          {/* Add form — always visible, bottom of card (§7). */}
          <GroupHeading>Add a secret</GroupHeading>
          <AddSecretForm
            envs={envs}
            activeAgent={activeAgent}
            activeEnvId={activeEnv === ALL ? ALL : activeEnv}
            existing={[
              ...secrets.map((s) => ({ key: s.key, environmentId: s.environmentId })),
              ...pendingAdds.map((p) => ({
                key: p.key,
                environmentId: p.env === ALL ? null : p.env,
              })),
            ]}
            sharedNames={sharedNames}
            disabled={!secretsConfigured}
            onSubmit={addPending}
          />

          {/* Dismissed requirements — collapsed, recoverable (§7). */}
          <div className="mt-4">
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              aria-expanded={showDismissed}
              onClick={() => setShowDismissed((v) => !v)}
            >
              Dismissed requirements ({dismissed.length}) {showDismissed ? "▴" : "▾"}
            </button>
            {showDismissed && dismissed.length > 0 && (
              <ul className="mt-2 divide-y rounded-lg border">
                {dismissed.map((d) => (
                  <li
                    key={d.name}
                    className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm"
                  >
                    <span className="font-mono">{d.name}</span>
                    <span className="text-xs text-muted-foreground">
                      required · {d.sources[0]}
                      {d.sources.length > 1 && ` +${d.sources.length - 1}`} · dismissed
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      disabled={restoreFetcher.state !== "idle"}
                      onClick={() =>
                        restoreFetcher.submit(
                          {
                            intent: "secret-dismiss",
                            agent: activeAgent,
                            key: d.name,
                            dismissed: "0",
                          },
                          { method: "post" },
                        )
                      }
                    >
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
