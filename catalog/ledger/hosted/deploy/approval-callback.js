// Generated from canonical Supabase sources.

// catalog/ledger/supabase/functions/_shared/review.ts
function receiptReviewDigest(receipt) {
  try {
    const parts = receipt.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/"))).review_digest ?? null;
  } catch {
    return null;
  }
}

// catalog/ledger/supabase/functions/_shared/approvals.ts
import {
  createWebhookVerifier,
  MAX_WEBHOOK_BODY_BYTES,
  WebhookVerificationError
} from "npm:@mayiapp/sdk@0.3.0/webhook-verifier";
async function accessToken(db, config, fetcher) {
  const token = await db("token", { client_id: config.client_id });
  if (token.access_token) return token.access_token;
  const response = await fetcher(`${config.origin}/api/oauth/token`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15e3),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: token.client_id,
      refresh_token: token.refresh_token
    })
  });
  if (!response.ok) {
    await db("refresh_failed", { claim: token.claim });
    throw new Error("May I reauthorization required");
  }
  const grant = await response.json();
  if (typeof grant.access_token !== "string" || typeof grant.refresh_token !== "string" || !Number.isSafeInteger(grant.expires_in) || grant.expires_in < 1)
    throw new Error("Invalid May I grant");
  await db("save_token", { ...grant, claim: token.claim });
  return grant.access_token;
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
var AccessRejectedError = class extends Error {
};
async function rejectAccess(db, token, status) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  await db("access_rejected", {
    token_hash: Array.from(
      new Uint8Array(digest),
      (n) => n.toString(16).padStart(2, "0")
    ).join(""),
    status: String(status)
  });
  throw new AccessRejectedError(
    "May I credentials require renewal; approval remains pending"
  );
}
async function readApproval(db, config, token, id, fetcher) {
  const response = await fetcher(
    `${config.origin}/api/approvals/${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15e3)
    }
  );
  if ([401, 403].includes(response.status))
    await rejectAccess(db, token, response.status);
  if (!response.ok) throw new Error("Cannot verify May I approval");
  return response.json();
}
function matches(local, remote, config, id) {
  return remote.id === id && canonical(remote.action) === canonical(local.action) && typeof local.review_digest === "string" && remote.reviewDigest === local.review_digest && remote.title === local.review_body?.title && remote.reviewMarkdown === local.review_body?.reviewMarkdown && remote.explanation === local.review_body?.explanation && (remote.supersedesApprovalId ?? null) === (local.review_body?.supersedesApprovalId ?? null) && (["APPROVED", "DENIED"].includes(remote.state) ? remote.state === "APPROVED" ? remote.decisionOutcome === "APPROVED" : ["DENIED", "CHANGES_REQUESTED"].includes(remote.decisionOutcome) : true) && (remote.decisionComment == null || typeof remote.decisionComment === "string" && remote.decisionComment.length <= 4e3) && (remote.decisionOutcome !== "CHANGES_REQUESTED" || remote.decisionComment?.trim().length > 0) && Number.isFinite(Date.parse(remote.expiresAt)) && (!["APPROVED", "DENIED"].includes(remote.state) || typeof remote.approverId === "string" && remote.approverId.length > 0 && Number.isFinite(Date.parse(remote.decidedAt)) && Date.parse(remote.decidedAt) <= Date.parse(remote.expiresAt)) && (remote.state !== "APPROVED" || typeof remote.receipt === "string" && receiptReviewDigest(remote.receipt) === local.review_digest);
}
async function applyRemote(db, local, remote, eventId, occurredAt) {
  return db("resolve", {
    review_protocol: 2,
    state: local.callback_state,
    event_id: eventId,
    approval_id: remote.id,
    status: remote.state.toLowerCase(),
    occurred_at: occurredAt,
    expires_at: remote.expiresAt,
    approver_id: remote.approverId ?? null,
    decision_outcome: remote.decisionOutcome ?? null,
    feedback: remote.decisionComment ?? null
  });
}
async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
function callbackHandler(db, config, fetcher = fetch) {
  const verifier = createWebhookVerifier({
    mayiOrigin: config.origin,
    maximumEventAgeSeconds: 604800,
    fetch: fetcher
  });
  return async (request) => {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    let verified;
    try {
      verified = await verifier.verify({
        body: await boundedBody(request),
        signature: request.headers.get("x-mayi-signature")
      });
    } catch (error) {
      if (error instanceof WebhookVerificationError && error.code === "KEY_SET_UNAVAILABLE")
        return new Response("May I signing keys unavailable; retry delivery", {
          status: 503
        });
      return new Response("Invalid callback signature or body", {
        status: 401
      });
    }
    if (verified.duplicate) return Response.json({ ok: true });
    const event = verified.event;
    if (event.type !== "approval.resolved")
      return new Response("Wrong event type", { status: 400 });
    try {
      const local = await db("request", { state: event.state });
      if (local.remote_id && local.remote_id !== event.approvalId)
        return new Response("Wrong approval", { status: 409 });
      const token = await accessToken(db, config, fetcher);
      const remote = await readApproval(
        db,
        config,
        token,
        event.approvalId,
        fetcher
      );
      if (!matches(local, remote, config, event.approvalId) || remote.state.toLowerCase() !== event.status || "approver" in event && remote.approverId !== event.approver.id || event.status === "approved" && remote.receipt !== event.receipt)
        return new Response("Approval binding mismatch", { status: 409 });
      const result = await applyRemote(
        db,
        local,
        remote,
        event.id,
        event.occurredAt
      );
      return Response.json(result);
    } catch {
      return new Response("Approval verification unavailable; retry delivery", {
        status: 503
      });
    }
  };
}

// catalog/ledger/supabase/functions/_shared/runtime.ts
function env(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing backend configuration: ${name}`);
  return value;
}
async function rpc(name, operation, args = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_op: operation, p_args: args }),
    signal: AbortSignal.timeout(15e3)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = typeof body.code === "string" && /^[A-Z0-9]{5,10}$/.test(body.code) ? body.code : "unknown";
    throw new Error(
      `Approval database operation failed (${response.status}; ${code})`
    );
  }
  return response.json();
}
var backend = (operation, args) => rpc("ledger_approval_backend", operation, args);

// catalog/ledger/supabase/functions/approval-callback/index.ts
Deno.serve(async (request) => {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (!request.headers.get("x-mayi-signature"))
    return new Response("Signature required", { status: 401 });
  try {
    return await callbackHandler(backend, await backend("config"))(request);
  } catch {
    return new Response("Approval backend not configured", { status: 503 });
  }
});
