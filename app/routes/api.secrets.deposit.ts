/**
 * POST /api/secrets/deposit — the Vercel issuer's credential drop (issue #364).
 *
 * The provisioning tool mints a project-scoped Vercel token inside its own process and needs it
 * to land in a TEAMMATE's container env without ever touching model context, delegation
 * messages, or the sandbox shell. This route is that one hop: bearer delegation token → caller
 * derived server-side → secret sealed into the store for the target member → env revision bumped
 * so the queued redeploy delivers it.
 *
 * Authorization is the committed lock, not the payload: the caller's member must carry the
 * `vercel-issuer` AGENT install (`hasAgentInstalled`) — the same convention that gates the
 * deposit URL env var at deploy time (`controller.server.ts`), re-checked here on every call so a
 * leaked team token from any other container still writes nothing. Drafts are deliberately NOT
 * overlaid: a staged-but-unpublished install must not grant cross-member secret writes.
 *
 * Writable keys are restricted to `VERCEL_*` and writes are always sandbox-sealed — this is a
 * purpose-built deposit slot, not a general secrets API.
 *
 * Bad token → 401; business outcomes → 200 `{ ok:false, error }` so the tool surfaces the text.
 * Every attempt by an authenticated caller is audited (key name, never the value), mirroring the
 * capability proxy. Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { recordCapabilityCall } from "~/capabilities/audit.server";
import { invalidateAgentEnvironments } from "~/deploy/env-reconcile.server";
import { listDrafts } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { hasAgentInstalled, LOCK_PATH, overlayLock } from "~/marketplace/lock";
import { writePendingSecret } from "~/project/secrets.server";
import { getRuntime } from "~/seams/index.server";
import { decodeKey, fingerprint, seal } from "~/seams/oss/secretbox";
import { verifyDelegationToken } from "~/team/token.server";

/** The only template whose install authorizes deposits. */
const ISSUER_TEMPLATE_ID = "vercel-issuer";

/** The deposit slot is Vercel-shaped by design; widen only with a new authz story. */
const KEY_PATTERN = /^VERCEL_[A-Z0-9_]+$/;

/** Tokens and ids, not documents — anything bigger is a misuse, not a secret. */
const MAX_VALUE_BYTES = 8 * 1024;

export async function action({ request }: ActionFunctionArgs) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  // Resolve the caller from the token's deployment — nothing but the deployment id is trusted
  // from the client (the capability-proxy pattern).
  const store = getRuntime().data;
  const deployment = await store.deployments.findById(deploymentId);
  const env = deployment
    ? await store.environments.findById(deployment.environmentId)
    : null;
  const caller = env ? await store.agents.findById(env.agentId) : null;
  if (!caller) {
    return data(
      { ok: false, error: "Your deployment is no longer known to harnesst." },
      { status: 403 },
    );
  }

  const audit = async (
    outcome: "ok" | "refused" | "error",
    error: string | null,
    inputSummary: Record<string, unknown>,
  ) => {
    try {
      await recordCapabilityCall({
        agentId: caller.id,
        deploymentId,
        provider: "harnesst",
        operation: "secrets.deposit",
        groupId: null,
        outcome,
        error,
        inputSummary,
      });
    } catch (err) {
      console.error("[secrets.deposit] audit write failed:", err);
    }
  };

  const refuse = async (error: string, summary: Record<string, unknown> = {}) => {
    await audit("refused", error, summary);
    return data({ ok: false, error });
  };

  let body: {
    member?: unknown;
    key?: unknown;
    value?: unknown;
    sandboxExposed?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return refuse("Send a JSON body with `member`, `key`, and `value`.");
  }

  const member = typeof body.member === "string" ? body.member.trim() : "";
  const key = typeof body.key === "string" ? body.key : "";
  const value = typeof body.value === "string" ? body.value : "";
  const summary = { member, key };
  if (!member || !key || !value) {
    return refuse("`member`, `key`, and `value` are all required.", summary);
  }
  if (!KEY_PATTERN.test(key)) {
    return refuse("Only VERCEL_* keys can be deposited through this route.", summary);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    return refuse("The value is too large for a credential deposit.", summary);
  }
  // The whole point of the flow is a credential the sandbox shell cannot see; there is no
  // legitimate sandbox-exposed deposit, so a request for one is refused rather than clamped.
  if (body.sandboxExposed === true) {
    return refuse("Deposited credentials are never sandbox-exposed.", summary);
  }

  const project = await store.projects.findById(caller.projectId);
  if (!project?.repoOwner || !project.repoName || !project.repoInstallationId) {
    return refuse("This repository is not connected to GitHub.", summary);
  }

  // Committed lock only — see the module comment for why drafts don't count here.
  const source = await getAgentSource(project.repoInstallationId, {
    owner: project.repoOwner,
    repo: project.repoName,
  });
  const lock = overlayLock(source.files[LOCK_PATH] ?? null, []);
  const callerMember = caller.root === "agent" ? null : caller.name;
  if (!hasAgentInstalled(lock, ISSUER_TEMPLATE_ID, callerMember)) {
    return refuse(
      "Only the Vercel issuer agent may deposit credentials for teammates.",
      summary,
    );
  }

  // Live roster member → real secret write + queued redeploy delivers it.
  const roster = (await store.agents.listByProject(project.id)).filter(
    (a) => a.kind === "member",
  );
  const target = roster.find((a) => a.name === member);
  if (target) {
    await getRuntime().secrets.set(
      { projectId: project.id, agentId: target.id, environmentId: null, key },
      value,
      { sandboxExposed: false, updatedBy: null },
    );
    await invalidateAgentEnvironments({ agentIds: [target.id], createdBy: null });
    await audit("ok", null, { ...summary, delivery: "queued" });
    return data({ ok: true, delivery: "queued" });
  }

  // Pending member (installed but not yet shipped): the member has repo files or a staged draft
  // under agents/<name>/ but no agents row. Hold the sealed value in pending_secrets; the ship
  // point migrates it (`migratePendingSecrets`).
  const memberPrefix = `agents/${member}/`;
  const committed = Object.keys(source.files).some((p) => p.startsWith(memberPrefix));
  const drafted =
    committed ||
    (await listDrafts(project.id)).some((d) => d.path.startsWith(memberPrefix));
  if (!drafted) {
    return refuse(`No teammate named "${member}" exists in this project.`, summary);
  }

  const sealKey = decodeKey(process.env.HARNESST_SECRETS_KEY);
  await writePendingSecret({
    projectId: project.id,
    memberName: member,
    key,
    sealed: seal(sealKey, value),
    fingerprint: fingerprint(value),
    sandboxExposed: false,
    attachShared: false,
    createdBy: null,
  });
  await audit("ok", null, { ...summary, delivery: "held" });
  return data({ ok: true, delivery: "held" });
}
