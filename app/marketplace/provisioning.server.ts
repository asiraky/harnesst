import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "~/db/client.server";
import { bundleProvisioning, jobs } from "~/db/schema";
import { listAgentEnvironments, listAgents } from "~/db/queries.server";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";
import { getRuntime } from "~/seams/index.server";
import { invalidateAgentEnvironments } from "~/deploy/env-reconcile.server";
import { listDrafts } from "~/drafts/drafts.server";
import { enqueue } from "~/jobs/queue.server";
import { writePendingSecret } from "~/project/secrets.server";
import {
  SupabaseManagement,
  actorsQuery,
  hostedMigrationQueries,
  projectRef,
  validatePublishableKey,
  type ActorCredentials,
} from "./supabase-provisioning.server";

import { LEDGER_ROLES } from "./provisioning";
type PrivateState = {
  token?: string;
  supabaseAuthorizationPending?: boolean;
  publishableKey?: string;
  email?: string;
  members?: Record<string, string>;
  actors?: Record<string, ActorCredentials>;
  mayiSetupToken?: string;
  mayiComponentsReady?: boolean;
  dispatchToken?: string;
};
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Serializes provisioning writes for one project for the rest of the transaction. */
function lockProject(tx: Tx, projectId: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
}
export function encrypt(state: PrivateState) {
  return seal(
    decodeKey(process.env.HARNESST_SECRETS_KEY),
    JSON.stringify(state),
  );
}
export function privateState(
  row: NonNullable<Awaited<ReturnType<typeof getProvisioning>>>,
): PrivateState {
  return row.encryptedState
    ? JSON.parse(
        open(decodeKey(process.env.HARNESST_SECRETS_KEY), row.encryptedState),
      )
    : {};
}
export async function getProvisioning(projectId: string) {
  return (
    (
      await db
        .select()
        .from(bundleProvisioning)
        .where(eq(bundleProvisioning.projectId, projectId))
    )[0] ?? null
  );
}
export async function ensureProvisioning(projectId: string) {
  await db
    .insert(bundleProvisioning)
    .values({ projectId })
    .onConflictDoNothing();
}
async function update(
  projectId: string,
  values: Partial<typeof bundleProvisioning.$inferInsert>,
) {
  await db
    .update(bundleProvisioning)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(bundleProvisioning.projectId, projectId));
}
export async function connectSupabase(projectId: string, token: string) {
  if (!token.trim())
    throw new Error("Enter a Supabase access token to authorize installation.");
  const projects = await new SupabaseManagement(token).call("projects");
  if (!Array.isArray(projects))
    throw new Error("Supabase returned an invalid project list.");
  await ensureProvisioning(projectId);
  await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const row = (
      await tx
        .select()
        .from(bundleProvisioning)
        .where(eq(bundleProvisioning.projectId, projectId))
    )[0];
    if (["running", "activating"].includes(row.status))
      throw new Error("Installation is already running.");
    await tx
      .update(bundleProvisioning)
      .set({
        encryptedState: encrypt({ ...privateState(row), token, supabaseAuthorizationPending: true }),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(bundleProvisioning.projectId, projectId));
  });
  return projects.map((p: any) => ({
    id: p.id,
    name: p.name,
    status: p.status,
  }));
}
export async function startProvisioning(input: {
  projectId: string;
  ref: string;
  publishableKey: string;
  email: string;
  origin: string;
  members: Record<string, string>;
}) {
  const row = await getProvisioning(input.projectId);
  if (!row) throw new Error("Connect Supabase first.");
  if (["running", "activating"].includes(row.status))
    throw new Error("Installation is already running.");
  const state = privateState(row);
  if (!state.token)
    throw new Error("Connect Supabase to authorize installation.");
  projectRef(input.ref);
  if (row.projectRef && row.projectRef !== input.ref)
    throw new Error(
      "This installation is already bound to a different Supabase project.",
    );
  const projects = await new SupabaseManagement(state.token).call("projects");
  if (
    !projects.some(
      (p: any) => p.id === input.ref && p.status === "ACTIVE_HEALTHY",
    )
  )
    throw new Error("Select an accessible, healthy Supabase project.");
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    /(^localhost$|\.test$|\.localhost$)/.test(origin.hostname)
  )
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
    await lockProject(tx, input.projectId);
    const current = (
      await tx
        .select()
        .from(bundleProvisioning)
        .where(eq(bundleProvisioning.projectId, input.projectId))
    )[0];
    if (["running", "activating"].includes(current.status))
      throw new Error("Installation is already running.");
    if (current.updatedAt.getTime() !== row.updatedAt.getTime())
      throw new Error("Installation settings changed. Refresh and retry.");
    await tx
      .update(bundleProvisioning)
      .set({
        status: "running",
        step: "Queued",
        error: null,
        projectRef: input.ref,
        publicOrigin: origin.origin,
        encryptedState: encrypt({
          ...state,
          actors,
          publishableKey: input.publishableKey,
          email: input.email,
          members: input.members,
        }),
        updatedAt: new Date(),
      })
      .where(eq(bundleProvisioning.projectId, input.projectId));
    await tx.insert(jobs).values({
      kind: "provision_bundle",
      payload: { projectId: input.projectId },
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
export async function runLedgerProvisioning(projectId: string) {
  const row = await getProvisioning(projectId);
  if (!row || !["running", "activating"].includes(row.status)) return;
  const state = privateState(row);
  if (
    !state.token ||
    !state.actors ||
    !state.members ||
    !state.email ||
    !state.publishableKey ||
    !row.projectRef ||
    !row.publicOrigin
  ) {
    await update(projectId, {
      status: "failed",
      error: "Installation authorization is incomplete.",
    });
    return;
  }
  const api = new SupabaseManagement(state.token);
  const ref = projectRef(row.projectRef);
  let step = "Install database";
  try {
    for (const { file, query } of await hostedMigrationQueries(projectId)) {
      step = `Install database (${file.slice(0, 14)})`;
      await update(projectId, { step });
      await api.query(ref, query);
    }
    step = "Create team identities";
    await update(projectId, { step });
    await api.query(ref, actorsQuery(state.actors, state.email));
    step = "Store agent credentials";
    await update(projectId, { step });
    const agents = await listAgents(projectId);
    for (const role of LEDGER_ROLES) {
      const agent = agents.find((a) => a.name === state.members![role]);
      const values = {
        LEDGER_URL: `https://${ref}.supabase.co`,
        LEDGER_ANON_KEY: state.publishableKey,
        LEDGER_ACTOR_KEY: state.actors[role].actorKey,
        LEDGER_WAKE_TOKEN: state.actors[role].wakeToken,
      };
      for (const [key, value] of Object.entries(values)) {
        if (agent) {
          await getRuntime().secrets.set(
            { projectId, agentId: agent.id, environmentId: null, key },
            value,
            { sandboxExposed: false },
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
            sandboxExposed: false,
            attachShared: false,
            createdBy: null,
          });
      }
    }
    step = "Verify ledger access";
    await update(projectId, { step });
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
    await update(projectId, { status: "activating", step: "Deploying agents" });
    await invalidateAgentEnvironments({
      agentIds: agents
        .filter((a) => Object.values(state.members!).includes(a.name))
        .map((a) => a.id),
    });
    // Retain provisioning authorization until the May I backend components are installed.
    await db.transaction(async (tx) => {
      await tx
        .update(bundleProvisioning)
        .set({
          status: "provisioned",
          step: "Ledger installed; deployment verification pending",
          error: null,
          encryptedState: encrypt(state),
          updatedAt: new Date(),
        })
        .where(eq(bundleProvisioning.projectId, projectId));
      await tx.insert(jobs).values({
        kind: "verify_bundle",
        payload: { projectId, attempt: 0 },
        runAt: new Date(Date.now() + 5000),
        maxAttempts: 1,
      });
    });
  } catch (error) {
    // Deliberately do not persist/log upstream exceptions or SQL text containing keys.
    await update(projectId, {
      status: "failed",
      step,
      error: `${step} failed. Check Supabase permissions and retry; completed migrations and identities are preserved.`,
    });
  }
}

/** Authenticated empty POST proves the deployed wake route has the right key, without a model turn. */
export async function verifyLedgerInstallation(projectId: string, attempt = 0) {
  const row = await getProvisioning(projectId);
  if (!row || !["provisioned", "ready"].includes(row.status)) return;
  const state = privateState(row);
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
    await update(projectId, {
      status: "provisioned",
      step: "Waiting for agent deployment and callbacks",
      error: pending.join("; "),
    });
    if (attempt < 30)
      await enqueue(
        "verify_bundle",
        { projectId, attempt: attempt + 1 },
        { runAt: new Date(Date.now() + 10000), maxAttempts: 1 },
      );
  } else
    await update(projectId, {
      status: "ready",
      step: "Ledger installation complete",
      error: null,
    });
}

export async function changeLedgerOrigin(projectId: string, origin: string) {
  const row = await getProvisioning(projectId);
  if (!row || !["provisioned", "ready"].includes(row.status))
    throw new Error("Install the ledger before updating callbacks.");
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /(^localhost$|\.test$|\.localhost$)/.test(url.hostname)
  )
    throw new Error("Use the public HTTPS harnesst address.");
  // Updating registered wake addresses requires operator authorization to the ledger database.
  const state = privateState(row);
  if (!state.token)
    throw new Error("Reconnect Supabase below to update agent wake addresses.");
  await update(projectId, {
    status: "pending",
    publicOrigin: url.origin,
    step: "Update callback address",
    error: null,
  });
}
