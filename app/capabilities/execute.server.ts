/**
 * Capability-call orchestration (issue #166) — the pure logic behind
 * `POST /api/capabilities/:provider/:operation`, split from the route like discord/send.server.ts.
 * The route authenticates the caller deployment (delegation token → deployment → env → agent)
 * and hands this module the resolved agent; everything from there is decided here, with every
 * touchpoint injectable so the whole ladder unit-tests with fakes:
 *
 *  1. Resolve the capability definition + operation — unknown → 404 (unlisted operations DO NOT
 *     EXIST; there is no passthrough).
 *  2. Enablement: the operation's group must be enabled for this agent, derived live from the
 *     draft-overlaid lock (union of `selectedCapabilityGroups` across the member's installs).
 *     Disabled → 200 `{ ok:false }` naming the permission — and because this check runs PER CALL,
 *     a Deployment-tab edit applies at the very next call (no reconnect, no redeploy).
 *  3. Zod-parse the input (unknown keys stripped), then acquire a current access token via the
 *     rotation-safe cached refresh (broker.server.ts) — the refresh token never appears here.
 *  4. Run the operation's `validate` invariants (they may consult the vendor with the live
 *     context), then `execute`. Business refusals → 200 `{ ok:false }`; vendor/transport
 *     failures → 502, exactly like the Discord send proxy.
 *  5. AUDIT every call that got this far — allowed, refused, or errored — with the operation's
 *     redacted input digest. Refusals are single appends (fail-open: a lost log line must not
 *     mask the refusal); the execute path is WRITE-AHEAD (a "pending" row lands before the vendor
 *     operation and is settled after — no row, no execution).
 */
import type { ZodError } from "zod";

import {
  capabilityAccessToken as realCapabilityAccessToken,
  type BrokerResult,
} from "~/connections/broker.server";
import { findGrant as realFindGrant } from "~/connections/grants.server";
import { getProvider } from "~/connections/providers.server";
import { listDrafts } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { overlayLock } from "~/marketplace/lock";
import { getRuntime } from "~/seams/index.server";
import {
  beginCapabilityCall as realBeginCapabilityCall,
  finalizeCapabilityCall as realFinalizeCapabilityCall,
  recordCapabilityCall as realRecordCapabilityCall,
  type CapabilityCallRecord,
} from "./audit.server";
import {
  findOperation,
  type CapabilityDefinition,
  type Operation,
} from "./definition.server";
import { enabledCapabilityGroupsByProvider } from "./enablement";
import { getCapability as realGetCapability } from "./registry.server";

/** The caller, resolved by the route from its delegation token. Nothing else is trusted. */
export interface CapabilityCaller {
  deploymentId: string;
  agent: { id: string; projectId: string; name: string; root: string };
}

export interface CapabilityCallInput {
  provider: string;
  operation: string;
  caller: CapabilityCaller;
  /** The request's parsed JSON body (unknown — zod decides). */
  body: unknown;
}

/** HTTP-ish result the route serializes: business refusals are 200 so the tool surfaces text. */
export interface CapabilityCallOutcome {
  status: number;
  body: { ok: boolean; error?: string; result?: unknown };
}

export interface CapabilityExecuteDeps {
  getCapability: (provider: string) => CapabilityDefinition | null;
  /**
   * The capability groups enabled for this agent+provider — derived from the draft-overlaid lock
   * (see `defaultEnabledGroups`). Read PER CALL: enablement edits are instant by construction.
   */
  enabledGroups: (
    caller: CapabilityCaller,
    provider: string,
  ) => Promise<string[]>;
  /** The grant's display-safe row (resource binding), or null when none exists. */
  findGrant: (input: {
    projectId: string;
    agentId: string;
    provider: string;
  }) => Promise<{ resourceId: string | null } | null>;
  /** A current access token — the rotation-safe, cached refresh (broker.server.ts). */
  accessToken: (input: {
    projectId: string;
    agentId: string;
    provider: string;
  }) => Promise<BrokerResult>;
  /** Single-append audit for outcomes known up front (refusals, pre-execute errors). */
  record: (record: CapabilityCallRecord) => Promise<void>;
  /**
   * WRITE-AHEAD audit row ("pending") inserted before `execute()` — a throw here refuses the
   * call, so a vendor mutation can never exist without a queryable row.
   */
  begin: (
    record: Omit<CapabilityCallRecord, "outcome" | "error">,
  ) => Promise<string>;
  /** Settle the write-ahead row with the execution's outcome. */
  finalize: (
    id: string,
    outcome: "ok" | "error",
    error: string | null,
  ) => Promise<void>;
  fetchImpl: typeof fetch;
}

/**
 * Default enablement derivation: the project's repo lock with staged drafts overlaid (the same
 * read the connect flow uses), so a permission edit staged from the Deployment tab takes effect
 * immediately — before it is even published.
 */
async function defaultEnabledGroups(
  caller: CapabilityCaller,
  provider: string,
): Promise<string[]> {
  const store = getRuntime().data;
  const project = await store.projects.findById(caller.agent.projectId);
  if (!project?.repoOwner || !project.repoName || !project.repoInstallationId) {
    return [];
  }
  const [source, drafts] = await Promise.all([
    getAgentSource(project.repoInstallationId, {
      owner: project.repoOwner,
      repo: project.repoName,
    }),
    listDrafts(project.id),
  ]);
  const lock = overlayLock(
    source.files["harnesst-lock.json"] ?? null,
    drafts.map((d) => ({ path: d.path, content: d.content })),
  );
  const member = caller.agent.root === "agent" ? null : caller.agent.name;
  return enabledCapabilityGroupsByProvider(lock, member).get(provider) ?? [];
}

function defaultDeps(): CapabilityExecuteDeps {
  return {
    getCapability: realGetCapability,
    enabledGroups: defaultEnabledGroups,
    findGrant: realFindGrant,
    accessToken: (input) => realCapabilityAccessToken(input),
    record: realRecordCapabilityCall,
    begin: realBeginCapabilityCall,
    finalize: realFinalizeCapabilityCall,
    fetchImpl: fetch,
  };
}

/** A best-effort redacted digest for audit rows written before/without a successful parse. */
function safeSummary(
  operation: Operation | null,
  body: unknown,
): Record<string, unknown> {
  if (!operation) return {};
  const parsed = operation.input.safeParse(body);
  if (!parsed.success) return {};
  try {
    return operation.summarize(parsed.data);
  } catch {
    return {};
  }
}

/** Run one capability call end-to-end. Never throws; every outcome is a readable result. */
export async function executeCapabilityCall(
  input: CapabilityCallInput,
  deps: CapabilityExecuteDeps = defaultDeps(),
): Promise<CapabilityCallOutcome> {
  const { caller } = input;
  const audit = async (
    outcome: CapabilityCallRecord["outcome"],
    error: string | null,
    groupId: string | null,
    inputSummary: Record<string, unknown>,
  ) => {
    try {
      await deps.record({
        agentId: caller.agent.id,
        deploymentId: caller.deploymentId,
        provider: input.provider,
        operation: input.operation,
        groupId,
        outcome,
        error,
        inputSummary,
      });
    } catch (err) {
      // Refusal-path audits are fail-open: nothing reached the vendor, so the refusal itself must
      // not be masked by a failed log write. The EXECUTE path is different — see the write-ahead
      // `begin` below, which fail-closes so a vendor mutation can never exist without a row.
      console.error("[capabilities] audit write failed:", err);
    }
  };

  // ── Resolve: unknown provider/operation → 404. Unlisted operations DO NOT EXIST. ──
  const providerDef = getProvider(input.provider);
  const capability =
    providerDef?.credentialDelivery === "capability"
      ? deps.getCapability(input.provider)
      : null;
  if (!providerDef || !capability) {
    const error = `"${input.provider}" is not a capability provider this harnesst installation supports.`;
    await audit("refused", error, null, {});
    return { status: 404, body: { ok: false, error } };
  }
  const found = findOperation(capability, input.operation);
  if (!found) {
    const error = `${providerDef.label} has no operation "${input.operation}".`;
    await audit("refused", error, null, {});
    return { status: 404, body: { ok: false, error } };
  }
  const { group, operation } = found;

  // ── Enablement: the group must be enabled for this agent — checked PER CALL. ──
  const enabled = await deps.enabledGroups(caller, input.provider);
  if (!enabled.includes(group.id)) {
    const error =
      `The "${group.label}" permission isn't enabled for this agent — enable the ` +
      `"${group.label}" permission from the agent's Deployment tab.`;
    await audit("refused", error, group.id, safeSummary(operation, input.body));
    return { status: 200, body: { ok: false, error } };
  }

  // ── Shape: zod-parse the input (unknown keys — including Status/Type — are stripped). ──
  const parsed = operation.input.safeParse(input.body);
  if (!parsed.success) {
    const error = `Invalid input: ${describeZodError(parsed.error)}`;
    await audit("refused", error, group.id, {});
    return { status: 200, body: { ok: false, error } };
  }
  const summary = safeSummary(operation, parsed.data);

  // ── Credential: resource binding + a current access token. The refresh token never leaves
  // the broker's refresh step; the access token is used immediately and never stored here. ──
  const scope = {
    projectId: caller.agent.projectId,
    agentId: caller.agent.id,
    provider: input.provider,
  };
  const grant = await deps.findGrant(scope);
  if (capability.resource && !grant?.resourceId) {
    const error =
      `The ${providerDef.label} connection isn't bound to ${aOrAn(capability.resource.label)} ` +
      `${capability.resource.label} yet — finish connecting it from the agent's Deployment tab.`;
    await audit("refused", error, group.id, summary);
    return { status: 200, body: { ok: false, error } };
  }
  const token = await deps.accessToken(scope);
  if (!token.ok) {
    // Dead grant (403) is a business outcome the tool should surface as text; infrastructure
    // failures keep their status like the Discord proxy's 502s.
    const status = token.status === 403 ? 200 : token.status;
    await audit("error", token.error, group.id, summary);
    return { status, body: { ok: false, error: token.error } };
  }

  const ctx = {
    accessToken: token.accessToken,
    resourceId: grant?.resourceId ?? null,
    agentId: caller.agent.id,
    fetch: deps.fetchImpl,
  };

  // ── Invariants: the whitelist's teeth. A readable refusal is a 200 business outcome. ──
  if (operation.validate) {
    let verdict;
    try {
      verdict = await operation.validate(parsed.data, ctx);
    } catch (error) {
      const message = `Couldn't validate the request against ${providerDef.label}: ${(error as Error).message}`;
      await audit("error", message, group.id, summary);
      return { status: 502, body: { ok: false, error: message } };
    }
    if (!verdict.ok) {
      await audit("refused", verdict.error, group.id, summary);
      return { status: 200, body: { ok: false, error: verdict.error } };
    }
  }

  // ── Write-ahead audit: the "pending" row lands BEFORE the vendor operation, so a mutation
  // can never exist without a queryable capability_calls row (acceptance criterion 5). If the
  // row can't be written, the call is refused before anything reaches the vendor. ──
  let auditId: string;
  try {
    auditId = await deps.begin({
      agentId: caller.agent.id,
      deploymentId: caller.deploymentId,
      provider: input.provider,
      operation: input.operation,
      groupId: group.id,
      inputSummary: summary,
    });
  } catch (err) {
    console.error("[capabilities] write-ahead audit failed:", err);
    return {
      status: 502,
      body: {
        ok: false,
        error:
          "harnesst couldn't record this call in its audit log, so it was not executed — retry.",
      },
    };
  }
  const finalize = async (outcome: "ok" | "error", error: string | null) => {
    try {
      await deps.finalize(auditId, outcome, error);
    } catch (err) {
      // The pending row already recorded the call; a failed settle must not mask the result.
      console.error("[capabilities] audit finalize failed:", err);
    }
  };

  // ── Execute — the control plane performs the one blessed operation itself. ──
  try {
    const result = await operation.execute(parsed.data, ctx);
    await finalize("ok", null);
    return { status: 200, body: { ok: true, result } };
  } catch (error) {
    const message = (error as Error).message;
    await finalize("error", message);
    return { status: 502, body: { ok: false, error: message } };
  }
}

/** "a"/"an" for the resource label in the unbound-resource message. */
function aOrAn(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}

/** A compact, readable rendering of a zod failure the agent can act on. */
function describeZodError(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}
