/**
 * Generic capability route (issue #166): `POST /api/capabilities/:provider/:operation`. An agent
 * instance's thin per-operation tool POSTs its typed input here with
 * `Authorization: Bearer <HARNESST_TEAM_TOKEN>` — the SAME delegation-token auth as the Discord send
 * proxy and #167's token broker (one instance-facing auth story, three consumers). The token
 * authenticates the CALLER DEPLOYMENT; the control plane resolves deployment → environment →
 * agent, then hands off to the framework (capabilities/execute.server.ts): enablement → shape →
 * invariants → execute with the control-plane-held credential → audit. The vendor credential
 * never reaches the instance in any form.
 *
 * Bad token → 401; business outcomes → 200 `{ ok:false, error }` so the tool surfaces the text;
 * vendor/transport failures → 502. The body is read through a hard size cap BEFORE it is
 * buffered (agent containers dial the control-plane port directly — no nginx limit shields this
 * route from a compromised agent streaming an unbounded payload): over the cap → 413. Malformed
 * or oversized bodies from an AUTHENTICATED caller are still audited (every request that passes
 * auth lands a capability_calls row). Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { recordCapabilityCall } from "~/capabilities/audit.server";
import { executeCapabilityCall } from "~/capabilities/execute.server";
import { getRuntime } from "~/seams/index.server";
import { verifyDelegationToken } from "~/team/token.server";

/**
 * Hard cap on the request body: comfortably above the largest legitimate payload — a 10 MiB
 * attachment is ~13.4 MiB as base64 plus JSON overhead — while keeping a hostile instance from
 * exhausting control-plane memory.
 */
const MAX_BODY_BYTES = 15 * 1024 * 1024;

type BoundedBody = { over: true } | { over: false; text: string };

/** Read the body up to MAX_BODY_BYTES, bailing out the moment the stream exceeds the cap. */
async function readBoundedBody(request: Request): Promise<BoundedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { over: true };
  }
  if (!request.body) return { over: false, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { over: true };
    }
    chunks.push(value);
  }
  return { over: false, text: Buffer.concat(chunks).toString("utf8") };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  // Resolve the caller from the token's deployment: deployment → env → agent (the exact pattern
  // of the Discord send proxy). Nothing but the deployment id is trusted from the client.
  // Resolved BEFORE the body is read so transport-level refusals below can still be audited
  // against the verified caller.
  const store = getRuntime().data;
  const deployment = await store.deployments.findById(deploymentId);
  const env = deployment
    ? await store.environments.findById(deployment.environmentId)
    : null;
  const agent = env ? await store.agents.findById(env.agentId) : null;
  if (!agent) {
    return data(
      { ok: false, error: "Your deployment is no longer known to harnesst." },
      { status: 403 },
    );
  }

  // An authenticated request that never yields a parseable body is still a capability call the
  // installer can query — refused at the transport layer, audited like every other refusal
  // (fail-open: no vendor mutation is at stake here).
  const auditTransportRefusal = async (error: string) => {
    try {
      await recordCapabilityCall({
        agentId: agent.id,
        deploymentId,
        provider: params.provider ?? "",
        operation: params.operation ?? "",
        groupId: null,
        outcome: "refused",
        error,
        inputSummary: {},
      });
    } catch (err) {
      console.error("[capabilities] audit write failed:", err);
    }
  };

  const bounded = await readBoundedBody(request);
  if (bounded.over) {
    const error = `The request body exceeds this route's ${Math.floor(MAX_BODY_BYTES / (1024 * 1024))} MiB limit.`;
    await auditTransportRefusal(error);
    return data({ ok: false, error }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch {
    const error = "Send the operation's input as a JSON body.";
    await auditTransportRefusal(error);
    return data({ ok: false, error }, { status: 400 });
  }

  const outcome = await executeCapabilityCall({
    provider: params.provider ?? "",
    operation: params.operation ?? "",
    caller: {
      deploymentId,
      agent: {
        id: agent.id,
        projectId: agent.projectId,
        name: agent.name,
        root: agent.root,
      },
    },
    body,
  });
  return data(outcome.body, { status: outcome.status });
}
