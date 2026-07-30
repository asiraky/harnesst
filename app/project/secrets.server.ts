/**
 * Secret mutation intents behind the settings route (PLAN-SECRETS-REWORK §6). The route action
 * parses the form and resolves scope (agent + environment); this module owns the decisions —
 * validation, write-through with metadata, the JSON payloads fetchers consume — with the
 * provider/store injected so every intent is unit-testable without Postgres or auth.
 *
 * Everything returns JSON (`{ ok, ... }` / `{ ok:false, error }`): no redirects, no page
 * reloads. Values are write-only: no result ever carries a plaintext value — the set echo is
 * name + fingerprint + audit metadata only.
 */
import type { HarnesstLock } from "~/marketplace/lock";
import type { SecretsProvider } from "~/seams/types";
import {
  deletePendingSecrets,
  deleteSharedSecret,
  getSecretRow,
  listAgentSecretRows,
  listAttachments,
  listDismissedRequirements,
  listPendingMemberNames,
  listPendingSecrets,
  setAttachment,
  setRequirementDismissed,
  setSecretSandboxExposed,
  writePendingSecret,
  drizzleSecretKV,
  type PendingSecretRow,
  type SecretKVStore,
  type SecretRow,
} from "~/seams/oss/secret-store";

export const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretIntentInput {
  intent:
    | "secret-set"
    | "secret-replace"
    | "secret-delete"
    | "secret-expose"
    | "secret-attach"
    | "secret-detach"
    | "secret-dismiss"
    | "shared-secret-set"
    | "shared-secret-delete"
    | "shared-secret-expose-default";
  projectId: string;
  /** Owning member, or null for the project-level shared scope (shared-* intents). */
  agentId: string | null;
  environmentId: string | null;
  key: string;
  value?: string;
  /** Sandbox exposure: undefined = leave the current flag untouched (a plain replace). */
  exposed?: boolean;
  /** secret-dismiss: true dismisses the requirement, false restores it. */
  dismissed?: boolean;
  userId: string;
}

export type SecretIntentResult =
  | {
      ok: true;
      secret?: {
        name: string;
        environmentId: string | null;
        sandboxExposed: boolean;
        fingerprint: string | null;
        updatedAt: string;
      };
      deleted?: { key: string; environmentId: string | null };
    }
  | { ok: false; error: string };

export interface SecretIntentDeps {
  secrets: SecretsProvider;
  getRow?: typeof getSecretRow;
  setExposed?: typeof setSecretSandboxExposed;
  attach?: typeof setAttachment;
  dismiss?: typeof setRequirementDismissed;
  deleteShared?: typeof deleteSharedSecret;
}

export async function handleSecretIntent(
  input: SecretIntentInput,
  deps: SecretIntentDeps,
): Promise<SecretIntentResult> {
  const getRow = deps.getRow ?? getSecretRow;
  const setExposed = deps.setExposed ?? setSecretSandboxExposed;
  const attach = deps.attach ?? setAttachment;
  const dismiss = deps.dismiss ?? setRequirementDismissed;
  const deleteShared = deps.deleteShared ?? deleteSharedSecret;

  const key = input.key.trim();
  // shared-* intents address the project-level scope (agentId null) regardless of the form.
  const agentId = input.intent.startsWith("shared-") ? null : input.agentId;
  const ref = {
    projectId: input.projectId,
    agentId,
    environmentId: input.environmentId,
    key,
  };

  switch (input.intent) {
    case "secret-set":
    case "secret-replace":
    case "shared-secret-set": {
      if (!SECRET_KEY_RE.test(key)) {
        return { ok: false, error: "Key must be a valid env var name (A–Z, 0–9, _)." };
      }
      if (!input.value) return { ok: false, error: "Value is required." };
      await deps.secrets.set(ref, input.value, {
        sandboxExposed: input.exposed,
        updatedBy: input.userId,
      });
      const row: SecretRow | null = await getRow(ref);
      return {
        ok: true,
        secret: {
          name: key,
          environmentId: input.environmentId,
          sandboxExposed: row?.sandboxExposed ?? input.exposed ?? false,
          fingerprint: row?.fingerprint ?? null,
          updatedAt: row?.updatedAt ?? new Date().toISOString(),
        },
      };
    }

    case "secret-delete": {
      await deps.secrets.delete(ref);
      return { ok: true, deleted: { key, environmentId: input.environmentId } };
    }

    // The shared default flips like any exposure flag — it only seeds FUTURE attachments.
    case "secret-expose":
    case "shared-secret-expose-default": {
      await setExposed(ref, input.exposed ?? false, input.userId);
      return { ok: true };
    }

    // Deleting a shared secret removes every env row of the name AND its attachments (§11.4).
    case "shared-secret-delete": {
      await deleteShared(input.projectId, key);
      return { ok: true, deleted: { key, environmentId: null } };
    }

    // Attach covers first attach AND the per-attachment sandbox flip (upsert semantics).
    case "secret-attach": {
      if (!key) return { ok: false, error: "Missing secret name." };
      if (!agentId) return { ok: false, error: "Attachments are per-agent." };
      await attach({
        projectId: input.projectId,
        agentId,
        key,
        attached: true,
        sandboxExposed: input.exposed,
        createdBy: input.userId,
      });
      return { ok: true };
    }

    case "secret-detach": {
      if (!agentId) return { ok: false, error: "Attachments are per-agent." };
      await attach({
        projectId: input.projectId,
        agentId,
        key,
        attached: false,
      });
      return { ok: true };
    }

    case "secret-dismiss": {
      if (!agentId) return { ok: false, error: "Dismissals are per-agent." };
      await dismiss({
        projectId: input.projectId,
        agentId,
        key,
        dismissed: input.dismissed ?? true,
        createdBy: input.userId,
      });
      return { ok: true };
    }
  }
}

/**
 * The §6/§9 missing-requirements computation, pure: lock-required names for a member minus
 * (set ∪ attached ∪ dismissed). Grouped by name with every requiring template id (a name two
 * installs require renders once with `+1`, §11.6). Used by the Settings loader (required rows)
 * and the deploy guard alike so they can never disagree.
 *
 * Issue #47: a `provisioned` secret (GITHUB_APP_ID and friends, set by the Create GitHub App
 * guided flow — never by the user) is NEVER the user's to supply, so it is filtered out of
 * `missing` and `dismissed`: it must not nag, prompt, count toward "N secrets missing", or trip
 * the deploy guard before the guided flow has run. It DELIBERATELY stays in `all` — the
 * Deployment tab detects which channel-setup cards to show (GitHub/Discord guided flows) by
 * looking for those names in `all`, so dropping them there would hide the very flow that sets them.
 * Issue #163: a `generated` secret (minted by harnesst at first deploy) gets the same treatment —
 * never missing/dismissed, kept in `all`.
 */
export interface RequiredSecretComputed {
  name: string;
  description?: string;
  sandbox?: boolean;
  provisioned?: boolean;
  generated?: boolean;
  sources: string[];
}

export function computeRequiredSecrets(input: {
  /** Lock entries owned by this member (already filtered by member). */
  lockSecrets: Array<{
    templateId: string;
    secrets: Array<{
      name: string;
      description?: string;
      sandbox?: boolean;
      provisioned?: boolean;
      generated?: boolean;
    }>;
  }>;
  setNames: string[];
  attachedNames: string[];
  dismissedNames: string[];
}): { missing: RequiredSecretComputed[]; dismissed: RequiredSecretComputed[]; all: RequiredSecretComputed[] } {
  const byName = new Map<string, RequiredSecretComputed>();
  for (const entry of input.lockSecrets) {
    for (const s of entry.secrets) {
      const existing = byName.get(s.name);
      if (existing) {
        existing.sources.push(entry.templateId);
        // First description wins; sandbox/provisioned/generated true from ANY source sticks.
        if (!existing.description && s.description) existing.description = s.description;
        if (s.sandbox) existing.sandbox = true;
        if (s.provisioned) existing.provisioned = true;
        if (s.generated) existing.generated = true;
      } else {
        byName.set(s.name, {
          name: s.name,
          description: s.description,
          sandbox: s.sandbox,
          provisioned: s.provisioned,
          generated: s.generated,
          sources: [entry.templateId],
        });
      }
    }
  }
  const satisfied = new Set([...input.setNames, ...input.attachedNames]);
  const dismissedSet = new Set(input.dismissedNames);
  const all = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    all,
    // Issue #47: provisioned secrets are harnesst's to set, never the user's — they can't be
    // "missing" or "dismissed" from the user's perspective, so exclude them from both lists.
    // They remain in `all` for Deployment-tab channel-setup detection (see the doc comment).
    // Issue #163: generated secrets are harnesst-minted at deploy — same exclusion.
    missing: all.filter(
      (r) =>
        !r.provisioned && !r.generated && !satisfied.has(r.name) && !dismissedSet.has(r.name),
    ),
    dismissed: all.filter(
      (r) =>
        !r.provisioned && !r.generated && !satisfied.has(r.name) && dismissedSet.has(r.name),
    ),
  };
}

/** The lock entries whose secrets a member must satisfy (member-owned installs only). */
export function lockSecretsForMember(
  lock: HarnesstLock,
  memberName: string,
  isTeam: boolean,
): Array<{ templateId: string; secrets: NonNullable<HarnesstLock["installs"][number]["secrets"]> }> {
  return lock.installs
    .filter(
      (e) =>
        (e.member === memberName || (e.member === null && !isTeam)) &&
        (e.secrets?.length ?? 0) > 0,
    )
    .map((e) => ({ templateId: e.id, secrets: e.secrets! }));
}

/**
 * A member's required-secret state, from the DB: computeRequiredSecrets over its set names,
 * attachments, and dismissals. The agent-page badge ("N secrets missing") and the deploy guard
 * (§9) both read this, so they can never disagree with Settings.
 */
export async function agentRequiredSecretState(input: {
  projectId: string;
  agentId: string;
  memberName: string;
  isTeam: boolean;
  lock: HarnesstLock;
}): Promise<ReturnType<typeof computeRequiredSecrets>> {
  const lockSecrets = lockSecretsForMember(input.lock, input.memberName, input.isTeam);
  if (lockSecrets.length === 0) return { all: [], missing: [], dismissed: [] };
  const [rows, attachments, dismissedNames] = await Promise.all([
    listAgentSecretRows(input.projectId, input.agentId),
    listAttachments(input.agentId),
    listDismissedRequirements(input.agentId),
  ]);
  return computeRequiredSecrets({
    lockSecrets,
    setNames: rows.map((r) => r.key),
    attachedNames: attachments.map((a) => a.key),
    dismissedNames,
  });
}

// ── Install wizard secret decisions (§9) ─────────────────────────────────────

/** One manifest secret's fate at install time, decided from the wizard form. */
export type InstallSecretOp =
  /** Write an agent-scoped value now (member installs) or hold it sealed (new-member). */
  | { kind: "set"; name: string; value: string; sandbox: boolean }
  /** Opt into the project-level shared secret of the same name. */
  | { kind: "attach"; name: string; sandbox: boolean }
  /** Deferred — becomes a required-missing row after install/ship. */
  | { kind: "skip"; name: string };

/**
 * Decide each manifest secret's install op from the wizard's form fields, pure (§9):
 *  - `secretmode:<name>` = shared | value | skip (default: shared when a shared secret with
 *    that name exists — prevents token sprawl; else value).
 *  - `secret:<name>` = the value (blank value ⇒ skip; Continue is never gated).
 *  - `secretsandbox:<name>` = "1"/"0" — pre-checked from the manifest, user-editable.
 * A `provisioned` secret (set by a guided harnesst flow, never collected by the wizard) is always
 * a skip, no matter what the form carries — the wizard renders no input for it, and this is
 * the defense in depth if a value is somehow submitted anyway. A `generated` secret (minted by
 * harnesst at first deploy, issue #163) is a skip for the same reason.
 * Values pass through here transiently; they are never returned to a client or logged.
 */
export function planInstallSecretOps(input: {
  secrets: Array<{ name: string; sandbox?: boolean; provisioned?: boolean; generated?: boolean }>;
  form: Pick<FormData, "get" | "has">;
  sharedNames: string[];
}): InstallSecretOp[] {
  const shared = new Set(input.sharedNames);
  return input.secrets.map((s) => {
    if (s.provisioned || s.generated) return { kind: "skip", name: s.name };
    const sandbox = input.form.has(`secretsandbox:${s.name}`)
      ? input.form.get(`secretsandbox:${s.name}`) === "1"
      : (s.sandbox ?? false);
    const mode = String(
      input.form.get(`secretmode:${s.name}`) ??
        (shared.has(s.name) ? "shared" : "value"),
    );
    if (mode === "skip") return { kind: "skip", name: s.name };
    if (mode === "shared" && shared.has(s.name)) {
      return { kind: "attach", name: s.name, sandbox };
    }
    const value = String(input.form.get(`secret:${s.name}`) ?? "").trim();
    if (!value) return { kind: "skip", name: s.name };
    return { kind: "set", name: s.name, value, sandbox };
  });
}

// ── Pending-secret ship migration + abandonment cleanup (§4.4) ───────────────

export interface PendingMigrationDeps {
  listPending: typeof listPendingSecrets;
  deletePending: typeof deletePendingSecrets;
  /** Writes the already-sealed value + metadata (same secretbox — no re-encryption). */
  upsertSealed: SecretKVStore["upsert"];
  attach: typeof setAttachment;
}

const defaultMigrationDeps = (): PendingMigrationDeps => ({
  listPending: listPendingSecrets,
  deletePending: deletePendingSecrets,
  upsertSealed: drizzleSecretKV.upsert,
  attach: setAttachment,
});

/**
 * The ship point (§4.4): a new-member install's held secrets become real agent-scoped secrets
 * (environmentId null) the moment the member's `agents` row exists. Sealed values move as-is
 * (same secretbox key); attach-only rows become `secret_attachments`. Held rows are deleted
 * after migration. Returns how many rows were applied.
 */
export async function migratePendingSecrets(
  input: { projectId: string; memberName: string; agentId: string },
  deps: PendingMigrationDeps = defaultMigrationDeps(),
): Promise<number> {
  const pending: PendingSecretRow[] = await deps.listPending(
    input.projectId,
    input.memberName,
  );
  if (pending.length === 0) return 0;
  for (const row of pending) {
    if (row.attachShared) {
      await deps.attach({
        projectId: input.projectId,
        agentId: input.agentId,
        key: row.key,
        attached: true,
        sandboxExposed: row.sandboxExposed,
        createdBy: row.createdBy,
      });
    } else {
      await deps.upsertSealed(
        {
          projectId: input.projectId,
          agentId: input.agentId,
          environmentId: null,
          key: row.key,
        },
        row.sealed,
        {
          fingerprint: row.fingerprint ?? undefined,
          sandboxExposed: row.sandboxExposed,
          updatedBy: row.createdBy,
        },
      );
    }
  }
  await deps.deletePending(input.projectId, input.memberName);
  return pending.length;
}

export interface PendingCleanupDeps {
  listPendingMembers: typeof listPendingMemberNames;
  deletePending: typeof deletePendingSecrets;
}

/**
 * Abandonment cleanup (§4.4, §11.8): drop held secrets whose install can no longer go live —
 * the member name has no roster row AND no saved draft under `agents/<name>/` remains.
 * Called after draft discards (the abandonment path).
 */
export async function cleanupOrphanedPendingSecrets(
  input: {
    projectId: string;
    rosterNames: string[];
    draftPaths: string[];
  },
  deps: PendingCleanupDeps = {
    listPendingMembers: listPendingMemberNames,
    deletePending: deletePendingSecrets,
  },
): Promise<string[]> {
  const held = await deps.listPendingMembers(input.projectId);
  const roster = new Set(input.rosterNames);
  const removed: string[] = [];
  for (const name of held) {
    if (roster.has(name)) continue;
    const hasDraft = input.draftPaths.some((p) => p.startsWith(`agents/${name}/`));
    if (hasDraft) continue;
    await deps.deletePending(input.projectId, name);
    removed.push(name);
  }
  return removed;
}

/** Re-exported for the install wizard's pending writes (sealing happens route-side). */
export { writePendingSecret };
