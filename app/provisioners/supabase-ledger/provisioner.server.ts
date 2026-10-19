/**
 * The `supabase-ledger` provisioner: installs the ledger into a Supabase project the team owns,
 * gives each role agent its ledger identity, registers harnesst's approvals key, verifies the
 * deployed wake routes, and keeps the database on the latest hosted migrations.
 *
 * Every Supabase management call uses the team's linked workspace connection
 * (state.server.ts → withLinkedCredential). The token is never stored here, never logged, and
 * never given to agents. Private state holds only what the ledger itself issued or the user
 * entered: publishable key, approver email, role members, actor keys, approvals key.
 */
import { createHash, randomBytes } from "node:crypto";

import { jobs, type BundleProvisioningRow } from "~/db/schema";
import { db } from "~/db/client.server";
import { listAgentEnvironments, listAgents } from "~/db/queries.server";
import { invalidateAgentEnvironments } from "~/deploy/env-reconcile.server";
import { listDrafts } from "~/drafts/drafts.server";
import { enqueue } from "~/jobs/queue.server";
import { teamRoster } from "~/marketplace/lock";
import { LEDGER_ROLES } from "~/marketplace/provisioning";
import {
  APPLIED_MIGRATIONS_QUERY,
  HOSTED_MIGRATIONS,
  SupabaseManagement,
  actorsQuery,
  approvalsAccessQuery,
  hostedMigrationQueries,
  latestHostedMigration,
  projectRef,
  refFromUrl,
  validatePublishableKey,
  type ActorCredentials,
} from "~/marketplace/supabase-provisioning.server";
import { writePendingSecret } from "~/project/secrets.server";
import { getRuntime } from "~/seams/index.server";
import { decodeKey, seal } from "~/seams/oss/secretbox";
import { ServiceConnectionUnusableError } from "~/service-connections/connections.server";
import {
  BUSY_STATUSES,
  INSTALLED_STATUSES,
  PROVISIONERS,
} from "../descriptors";
import {
  getProvisioning,
  lockProvisioning,
  openState,
  sealState,
  updateProvisioning,
  withExclusiveRun,
  withLinkedCredential,
} from "../state.server";
import type {
  Provisioner,
  ProvisionerSetupContext,
  UpgradeResult,
} from "../types";

const ID = "supabase-ledger" as const;

export type LedgerState = {
  publishableKey?: string;
  email?: string;
  members?: Record<string, string>;
  actors?: Record<string, ActorCredentials>;
  /** harnesst's key to the ledger approvals API. Never given to agents. */
  approvalsKey?: string;
  /** The newest hosted migration this ledger is known to have. */
  migratedThrough?: string;
};

/** Seals ledger state. Drops the Supabase token rows written before workspace connections. */
function encrypt(state: LedgerState & { token?: unknown }) {
  const { token: _legacy, ...rest } = state;
  return sealState(rest);
}

export function ledgerState(row: BundleProvisioningRow): LedgerState {
  return openState<LedgerState>(row);
}

export function getLedger(projectId: string) {
  return getProvisioning(projectId, ID);
}

/** What the approvals client needs; null until approvals are set up on this ledger. */
export async function ledgerApprovalsAccess(projectId: string) {
  const row = await getLedger(projectId);
  const state = row ? ledgerState(row) : {};
  if (!row?.projectRef || !state.publishableKey || !state.approvalsKey)
    return null;
  return {
    ref: row.projectRef,
    publishableKey: state.publishableKey,
    approvalsKey: state.approvalsKey,
    publicOrigin: row.publicOrigin,
  };
}

function isPublicOrigin(url: URL) {
  return (
    url.protocol === "https:" &&
    url.pathname === "/" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !/(^localhost$|\.test$|\.localhost$)/.test(url.hostname)
  );
}

async function listSupabaseProjects(
  projectId: string,
  opts?: { saveAutoLink?: boolean },
) {
  const projects = await withLinkedCredential(
    projectId,
    ID,
    (token) => new SupabaseManagement(token).call("projects"),
    opts,
  );
  if (!Array.isArray(projects))
    throw new Error("Supabase returned an invalid project list.");
  return projects as Array<{ id: string; name: string; status: string }>;
}

export async function startLedgerInstall(input: {
  projectId: string;
  ref: string;
  publishableKey: string;
  email: string;
  origin: string;
  members: Record<string, string>;
}) {
  const row = await getLedger(input.projectId);
  if (!row) throw new Error("This team has no ledger to install.");
  if (BUSY_STATUSES.includes(row.status))
    throw new Error("Installation is already running.");
  const state = ledgerState(row);
  projectRef(input.ref);
  if (row.projectRef && row.projectRef !== input.ref)
    throw new Error(
      "This installation is already bound to a different Supabase project.",
    );
  const projects = await listSupabaseProjects(input.projectId);
  if (
    !projects.some((p) => p.id === input.ref && p.status === "ACTIVE_HEALTHY")
  )
    throw new Error("Select an accessible, healthy Supabase project.");
  const origin = new URL(input.origin);
  if (!isPublicOrigin(origin))
    throw new Error(
      "A public HTTPS harnesst address is required for ledger callbacks.",
    );
  validatePublishableKey(input.publishableKey);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email))
    throw new Error("Enter the human approver email.");
  if (
    LEDGER_ROLES.some(
      (r) => !/^[a-z][a-z0-9-]*$/.test(input.members[r] ?? ""),
    ) ||
    new Set(Object.values(input.members)).size !== LEDGER_ROLES.length
  )
    throw new Error("Choose a different team member for each ledger role.");
  const names = new Set((await listAgents(input.projectId)).map((a) => a.name));
  for (const draft of await listDrafts(input.projectId)) {
    const match = /^agents\/([^/]+)\/agent\/agent\.ts$/.exec(draft.path);
    if (match && draft.content !== null) names.add(match[1]);
  }
  if (LEDGER_ROLES.some((r) => !names.has(input.members[r])))
    throw new Error(
      "Install every team member first, then select their exact names.",
    );
  if (
    state.members &&
    // Roles added after an installation are assigned on their first retry.
    LEDGER_ROLES.some(
      (r) =>
        state.members![r] !== undefined &&
        state.members![r] !== input.members[r],
    )
  )
    throw new Error(
      "Role assignments are bound to this installation and cannot be changed on retry.",
    );
  // Keep existing credentials; mint only roles this installation has not seen.
  const actors = Object.fromEntries(
    [...LEDGER_ROLES, "github"].map((r) => [
      r,
      state.actors?.[r] ?? {
        actorKey: randomBytes(32).toString("hex"),
        wakeToken: randomBytes(32).toString("hex"),
      },
    ]),
  );
  // Serialize submissions before enqueueing; the worker resumes persisted steps after a restart.
  await db.transaction(async (tx) => {
    await lockProvisioning(tx, input.projectId);
    const current = await getProvisioning(input.projectId, ID, tx);
    if (!current || BUSY_STATUSES.includes(current.status))
      throw new Error("Installation is already running.");
    if (current.updatedAt.getTime() !== row.updatedAt.getTime())
      throw new Error("Installation settings changed. Refresh and retry.");
    await updateProvisioning(
      input.projectId,
      ID,
      {
        status: "running",
        step: "Queued",
        error: null,
        projectRef: input.ref,
        publicOrigin: origin.origin,
        encryptedState: encrypt({
          ...ledgerState(current),
          actors,
          approvalsKey: state.approvalsKey ?? randomBytes(32).toString("hex"),
          publishableKey: input.publishableKey,
          email: input.email,
          members: input.members,
        }),
      },
      tx,
    );
    await tx.insert(jobs).values({
      kind: "provision_bundle",
      payload: { projectId: input.projectId, provisioner: ID },
      maxAttempts: 3,
    });
  });
}

export async function savedLedgerInputs(projectId: string) {
  for (const agent of await listAgents(projectId)) {
    const values = await getRuntime().secrets.resolve({
      projectId,
      agentId: agent.id,
      environmentId: null,
    });
    if (values.LEDGER_URL && values.LEDGER_ANON_KEY)
      return { url: values.LEDGER_URL, key: values.LEDGER_ANON_KEY };
  }
  return null;
}

/** Lazy: the worker module imports the registry, which imports this module. */
async function startWorker() {
  (await import("~/jobs/worker.server")).ensureWorkerStarted();
}

/** Messages safe to persist: never upstream text, which can echo SQL carrying keys. */
function failureMessage(error: unknown, fallback: string) {
  return error instanceof ServiceConnectionUnusableError
    ? error.message
    : fallback;
}

export async function runLedgerInstall(projectId: string) {
  const row = await getLedger(projectId);
  if (!row || !BUSY_STATUSES.includes(row.status)) return;
  const state = ledgerState(row);
  const update = (values: Parameters<typeof updateProvisioning>[2]) =>
    updateProvisioning(projectId, ID, values);
  if (
    !state.actors ||
    !state.approvalsKey ||
    !state.members ||
    !state.email ||
    !state.publishableKey ||
    !row.projectRef ||
    !row.publicOrigin
  ) {
    await update({
      status: "failed",
      error: "Installation settings are incomplete.",
    });
    return;
  }
  const ref = projectRef(row.projectRef);
  let step = "Install database";
  try {
    const latest = await withLinkedCredential(projectId, ID, async (token) => {
      const api = new SupabaseManagement(token);
      let applied = "";
      for (const { file, query } of await hostedMigrationQueries(projectId)) {
        step = `Install database (${file.slice(0, 14)})`;
        await update({ step });
        await api.query(ref, query);
        applied = file;
      }
      step = "Create team identities";
      await update({ step });
      await api.query(ref, actorsQuery(state.actors!, state.email!));
      step = "Connect approvals";
      await update({ step });
      await api.query(ref, approvalsAccessQuery(state.approvalsKey!));
      return applied;
    });
    step = "Store agent credentials";
    await update({ step });
    const agents = await listAgents(projectId);
    for (const role of LEDGER_ROLES) {
      const agent = agents.find((a) => a.name === state.members![role]);
      const values: Record<string, string> = {
        LEDGER_URL: `https://${ref}.supabase.co`,
        LEDGER_ANON_KEY: state.publishableKey,
        LEDGER_ACTOR_KEY: state.actors[role].actorKey,
        LEDGER_WAKE_TOKEN: state.actors[role].wakeToken,
      };
      // Infra onboards each product repository with `gh` from its sandbox: it writes the
      // repository's Actions secrets (LEDGER_URL, LEDGER_ANON_KEY and the GitHub actor's key),
      // so infra alone holds the GitHub actor key and sees those three in its shell. Infra's
      // App can already edit workflows and secrets on those repositories, so this widens nothing.
      const sandbox = new Set<string>();
      if (role === "infra") {
        values.LEDGER_GITHUB_ACTOR_KEY = state.actors.github.actorKey;
        for (const key of [
          "LEDGER_URL",
          "LEDGER_ANON_KEY",
          "LEDGER_GITHUB_ACTOR_KEY",
        ])
          sandbox.add(key);
      }
      for (const [key, value] of Object.entries(values)) {
        const sandboxExposed = sandbox.has(key);
        if (agent) {
          await getRuntime().secrets.set(
            { projectId, agentId: agent.id, environmentId: null, key },
            value,
            { sandboxExposed },
          );
          // Generated installation credentials own every environment; remove stale overrides.
          for (const environment of await listAgentEnvironments(agent.id))
            await getRuntime().secrets.delete({
              projectId,
              agentId: agent.id,
              environmentId: environment.id,
              key,
            });
        } else
          await writePendingSecret({
            projectId,
            memberName: state.members[role],
            key,
            sealed: seal(decodeKey(process.env.HARNESST_SECRETS_KEY), value),
            fingerprint: createHash("sha256").update(value).digest("hex"),
            sandboxExposed,
            attachShared: false,
            createdBy: null,
          });
      }
    }
    step = "Verify ledger access";
    await update({ step });
    for (const role of LEDGER_ROLES) {
      const response = await fetch(
        `https://${ref}.supabase.co/rest/v1/rpc/ledger_whoami`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            apikey: state.publishableKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            p_key: state.actors[role].actorKey,
            p_args: {},
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok)
        throw new Error(
          "Ledger verification failed. Retry after Supabase has refreshed its API schema.",
        );
      const result = await response.json();
      if (result.role !== role)
        throw new Error("Ledger identity verification failed.");
    }
    await update({ status: "activating", step: "Deploying agents" });
    await invalidateAgentEnvironments({
      agentIds: agents
        .filter((a) => Object.values(state.members!).includes(a.name))
        .map((a) => a.id),
    });
    await db.transaction(async (tx) => {
      await lockProvisioning(tx, projectId);
      const current = await getProvisioning(projectId, ID, tx);
      await updateProvisioning(
        projectId,
        ID,
        {
          status: "provisioned",
          step: "Ledger installed; deployment verification pending",
          error: null,
          encryptedState: encrypt({
            ...ledgerState(current ?? row),
            ...(latest ? { migratedThrough: latest } : {}),
          }),
        },
        tx,
      );
      await tx.insert(jobs).values({
        kind: "verify_bundle",
        payload: { projectId, provisioner: ID, attempt: 0 },
        runAt: new Date(Date.now() + 5000),
        maxAttempts: 1,
      });
    });
  } catch (error) {
    // Deliberately do not persist/log upstream exceptions or SQL text containing keys.
    await update({
      status: "failed",
      step,
      error: failureMessage(
        error,
        `${step} failed. Check Supabase permissions and retry; completed migrations and identities are preserved.`,
      ),
    });
  }
}

/** Authenticated empty POST proves the deployed wake route has the right key, without a model turn. */
export async function verifyLedgerInstallation(projectId: string, attempt = 0) {
  const row = await getLedger(projectId);
  if (!row || !INSTALLED_STATUSES.includes(row.status)) return;
  const state = ledgerState(row);
  const agents = await listAgents(projectId);
  const pending: string[] = [];
  for (const role of LEDGER_ROLES) {
    const agent = agents.find((a) => a.name === state.members?.[role]);
    const envs = agent ? await listAgentEnvironments(agent.id) : [];
    // A ledger identity has one wake target. Never silently select across multiple environments.
    if (envs.length !== 1) {
      pending.push(`${role}: needs one deployed environment`);
      continue;
    }
    const wakeUrl = `${row.publicOrigin}/e/${envs[0].id}/eve/v1/ledger/wake`;
    try {
      const response = await fetch(wakeUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${state.actors![role].wakeToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(10000),
      });
      if (
        response.status !== 400 ||
        (await response.json()).error !== "outbox_id required"
      )
        throw new Error("Not ready");
      const registration = await fetch(
        `https://${projectRef(row.projectRef!)}.supabase.co/rest/v1/rpc/ledger_set_wake_url`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            apikey: state.publishableKey!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            p_key: state.actors![role].actorKey,
            p_args: { url: wakeUrl },
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!registration.ok) throw new Error("Registration failed");
    } catch {
      pending.push(`${role}: callback not reachable yet`);
    }
  }
  if (pending.length) {
    await updateProvisioning(projectId, ID, {
      status: "provisioned",
      step: "Waiting for agent deployment and callbacks",
      error: pending.join("; "),
    });
    if (attempt < 30)
      await enqueue(
        "verify_bundle",
        { projectId, provisioner: ID, attempt: attempt + 1 },
        { runAt: new Date(Date.now() + 10000), maxAttempts: 1 },
      );
  } else
    await updateProvisioning(projectId, ID, {
      status: "ready",
      step: "Ledger installation complete",
      error: null,
    });
}

export async function changeLedgerOrigin(projectId: string, origin: string) {
  const row = await getLedger(projectId);
  if (!row || !INSTALLED_STATUSES.includes(row.status))
    throw new Error("Install the ledger before updating callbacks.");
  const url = new URL(origin);
  if (!isPublicOrigin(url))
    throw new Error("Use the public HTTPS harnesst address.");
  // Re-running the install re-registers wake addresses; it needs a usable connection, so check
  // now rather than leave the ledger pending on a run that can't start.
  await listSupabaseProjects(projectId);
  await updateProvisioning(projectId, ID, {
    status: "pending",
    publicOrigin: url.origin,
    step: "Update callback address",
    error: null,
  });
}

/** Persists an approvals key if this ledger predates approvals. Never rotates an existing one. */
async function ensureApprovalsKey(projectId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await lockProvisioning(tx, projectId);
    const row = await getProvisioning(projectId, ID, tx);
    if (!row) throw new Error("This team has no ledger.");
    const state = ledgerState(row);
    if (state.approvalsKey) return state.approvalsKey;
    const approvalsKey = randomBytes(32).toString("hex");
    await updateProvisioning(
      projectId,
      ID,
      { encryptedState: encrypt({ ...state, approvalsKey }) },
      tx,
    );
    return approvalsKey;
  });
}

/**
 * Brings an installed ledger to the latest hosted migrations and makes sure approvals are
 * registered. Applies only versions the ledger hasn't journalled; `migrationQuery` makes a
 * replayed version a no-op anyway. Failures are recorded on the row (status unchanged: the
 * ledger still works on its current version) and returned, never thrown.
 */
export async function upgradeLedger(projectId: string): Promise<UpgradeResult> {
  const row = await getLedger(projectId);
  if (!row || !INSTALLED_STATUSES.includes(row.status) || !row.projectRef)
    return { outcome: "skipped" };
  const ref = projectRef(row.projectRef);
  const result = await withExclusiveRun(
    projectId,
    ID,
    async (): Promise<UpgradeResult> => {
      try {
        const applied = await withLinkedCredential(
          projectId,
          ID,
          async (token) => {
            const api = new SupabaseManagement(token);
            const journal = (await api.query(
              ref,
              APPLIED_MIGRATIONS_QUERY,
            )) as Array<{
              version: string;
            }>;
            const done = new Set(journal.map((r) => r.version));
            const pending = (await hostedMigrationQueries(projectId)).filter(
              (m) => !done.has(m.file),
            );
            for (const { file, query } of pending) {
              await updateProvisioning(projectId, ID, {
                step: `Update database (${file.slice(0, 14)})`,
              });
              await api.query(ref, query);
            }
            await api.query(
              ref,
              approvalsAccessQuery(await ensureApprovalsKey(projectId)),
            );
            return pending.map((m) => m.file);
          },
        );
        const latest = await latestHostedMigration();
        await db.transaction(async (tx) => {
          await lockProvisioning(tx, projectId);
          const current = await getProvisioning(projectId, ID, tx);
          if (!current) return;
          await updateProvisioning(
            projectId,
            ID,
            {
              error: null,
              ...(applied.length
                ? { step: "Ledger updated to the latest version" }
                : {}),
              encryptedState: encrypt({
                ...ledgerState(current),
                migratedThrough: latest,
              }),
            },
            tx,
          );
        });
        return { outcome: "upgraded", applied };
      } catch (error) {
        const message = failureMessage(
          error,
          "Ledger update failed. Check Supabase permissions, then update the ledger in Setup.",
        );
        await updateProvisioning(projectId, ID, {
          step: "Ledger update failed",
          error: message,
        });
        return { outcome: "failed", error: message };
      }
    },
  );
  return result === "busy" ? { outcome: "busy" } : result;
}

export async function ledgerNeedsUpgrade(
  row: BundleProvisioningRow,
): Promise<boolean> {
  if (!INSTALLED_STATUSES.includes(row.status)) return false;
  const state = ledgerState(row);
  // An install that never recorded its version (older harnesst) is upgraded once to learn it.
  return (
    !state.approvalsKey ||
    !state.migratedThrough ||
    state.migratedThrough < (await latestHostedMigration())
  );
}

export interface LedgerSetupDetails {
  roles: readonly string[];
  projects: { id: string; name: string }[];
  connectionError: string | null;
  savedKey: boolean;
  ref: string;
  origin: string;
  status: string;
  step: string;
  error: string | null;
  members: Record<string, string>;
}

async function setupDetails(
  ctx: ProvisionerSetupContext,
  row: BundleProvisioningRow,
): Promise<LedgerSetupDetails> {
  const saved = await savedLedgerInputs(ctx.project.id);
  const state = ledgerState(row);
  // Ledger roles default to the team install's role → member map, else to the role names.
  const roster = teamRoster(ctx.lock)?.roster ?? [];
  const rosterDefaults = Object.fromEntries(
    LEDGER_ROLES.map((role) => [
      role,
      roster.find((r) => r.role === role)?.member ?? role,
    ]),
  );
  let projects: { id: string; name: string }[] = [];
  let connectionError: string | null = null;
  const installed = INSTALLED_STATUSES.includes(row.status);
  if (
    ctx.link.state === "ready" &&
    !installed &&
    !BUSY_STATUSES.includes(row.status)
  ) {
    try {
      projects = (
        await listSupabaseProjects(ctx.project.id, { saveAutoLink: false })
      ).map((p) => ({ id: p.id, name: p.name }));
    } catch (error) {
      connectionError =
        error instanceof ServiceConnectionUnusableError
          ? error.message
          : "Supabase is unavailable right now. Check again in a moment.";
    }
  }
  let savedRef = "";
  try {
    savedRef = saved ? refFromUrl(saved.url) : "";
  } catch {
    /* Show the project chooser for a malformed saved URL. */
  }
  return {
    roles: LEDGER_ROLES,
    projects,
    connectionError,
    savedKey: !!saved,
    ref: row.projectRef ?? savedRef,
    origin: row.publicOrigin ?? process.env.HARNESST_PUBLIC_ORIGIN ?? "",
    status: row.status,
    step: row.step ?? "Connect Supabase",
    error: row.error,
    members: state.members ?? rosterDefaults,
  };
}

async function setupAction(
  ctx: ProvisionerSetupContext,
  op: string,
  form: FormData,
) {
  const projectId = ctx.project.id;
  switch (op) {
    case "install": {
      const saved = await savedLedgerInputs(projectId);
      const ref = String(form.get("ref") ?? "");
      const enteredKey = String(form.get("publishableKey") ?? "").trim();
      const key =
        enteredKey || (saved && refFromUrl(saved.url) === ref ? saved.key : "");
      await startLedgerInstall({
        projectId,
        ref,
        publishableKey: key,
        email: String(form.get("email") ?? ""),
        origin: String(form.get("origin") ?? ""),
        members: Object.fromEntries(
          LEDGER_ROLES.map((r) => [r, String(form.get(`member:${r}`) ?? "")]),
        ),
      });
      await startWorker();
      return;
    }
    case "update": {
      const result = await upgradeLedger(projectId);
      if (result.outcome === "failed") throw new Error(result.error);
      if (result.outcome === "busy")
        throw new Error("A ledger update is already running.");
      if (result.outcome === "skipped")
        throw new Error("Install the ledger before updating it.");
      return;
    }
    case "origin":
      await changeLedgerOrigin(projectId, String(form.get("origin") ?? ""));
      return;
    case "verify":
      await enqueue(
        "verify_bundle",
        { projectId, provisioner: ID, attempt: 0 },
        { maxAttempts: 1 },
      );
      await startWorker();
      return;
    default:
      throw new Error("Unknown ledger action.");
  }
}

export const supabaseLedger: Provisioner<LedgerSetupDetails> = {
  descriptor: PROVISIONERS[ID],
  migrations: HOSTED_MIGRATIONS,
  install: runLedgerInstall,
  verify: verifyLedgerInstallation,
  upgrade: upgradeLedger,
  needsUpgrade: ledgerNeedsUpgrade,
  setupDetails,
  setupAction,
};
