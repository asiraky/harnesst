// Generated from canonical Supabase sources.

// catalog/ledger/supabase/functions/_shared/auth.ts
async function authorized(request, secret) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const digest = async (value) => new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );
  const [a, b] = await Promise.all([
    digest(header),
    digest(`Bearer ${secret}`)
  ]);
  let different = 0;
  for (let n = 0; n < a.length; n++) different |= a[n] ^ b[n];
  return different === 0;
}

// catalog/ledger/supabase/functions/_shared/review.ts
var text = (value) => typeof value === "string" ? value.trim() : "";
function reviewBody(action, supersedesApprovalId = null) {
  const input = action.input, spec = input.spec ?? {};
  const title = text(input.title).replace(/[\r\n]+/g, " ").slice(0, 200) || "Review proposed work";
  const sections = [
    `# ${title}`,
    `## Decision requested
Review the proposed ${String(input.stage).replaceAll("-", " ")}. Approval moves this work to **${input.approve_to}**. Requesting changes returns it to **${input.reject_to}**.`,
    text(spec.body) ? `## Specification
${text(spec.body)}` : `## Problem
${text(spec.problem) || "No problem description supplied."}`
  ];
  if (text(spec.review_markdown)) sections.push("## Engineering review\n" + text(spec.review_markdown));
  for (const [key, label] of Object.entries({ decisions: "Proposal and rationale", acceptance_criteria: "Acceptance criteria", out_of_scope: "Out of scope", open_questions: "Open questions" })) {
    const values = spec[key];
    if (Array.isArray(values) && values.length) sections.push(`## ${label}
${values.map((v) => `- ${text(v) || JSON.stringify(v)}`).join("\n")}`);
  }
  if (Array.isArray(spec.proposed_children) && spec.proposed_children.length)
    sections.push("## Proposed work\n" + spec.proposed_children.map((c) => `### ${text(c.title)}
${text(c.spec?.problem)}`).join("\n\n"));
  if (Array.isArray(input.artifacts) && input.artifacts.length)
    sections.push("## Supporting links\n" + input.artifacts.map((a) => `- ${a.type}: ${a.value}`).join("\n"));
  if (Array.isArray(input.evidence) && input.evidence.length)
    sections.push("## Verification and evidence\n```json\n" + JSON.stringify(input.evidence, null, 2) + "\n```");
  sections.push(`## Revision
Work item: ${input.item_id}

Revision: ${input.binding}

Approval generation: ${input.epoch}`);
  const reviewMarkdown = sections.join("\n\n");
  if (reviewMarkdown.length > 1e5) throw new Error("Review document exceeds May I limit; shorten the proposal or evidence");
  return {
    title,
    explanation: `Review ${title}. Approve to proceed to ${input.approve_to}, or request changes with feedback.`,
    reviewMarkdown,
    ...supersedesApprovalId ? { supersedesApprovalId } : {}
  };
}
async function reviewDigest(body) {
  const canonical2 = JSON.stringify({ explanation: body.explanation ?? null, reviewMarkdown: body.reviewMarkdown ?? null, title: body.title ?? null, v: 1 });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical2));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
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
function validReviewUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}
var PermanentSubmissionError = class extends Error {
};
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
async function dispatch(db, fetcher = fetch) {
  const config = await db("config");
  const token = await accessToken(db, config, fetcher);
  for (let n = 0; n < 10; n++) {
    const local = await db("claim_resolution", { client_id: config.client_id, review_protocol: 2 });
    if (!local) break;
    try {
      const remote = await readApproval(
        db,
        config,
        token,
        local.remote_id,
        fetcher
      );
      if (!matches(local, remote, config, local.remote_id))
        throw new Error("Approval binding mismatch");
      if (["APPROVED", "DENIED", "EXPIRED", "CANCELLED"].includes(remote.state)) {
        const occurred = remote.decidedAt ?? remote.expiresAt;
        if (!Number.isFinite(Date.parse(occurred)))
          throw new Error("Invalid decision time");
        await applyRemote(
          db,
          local,
          remote,
          `reconcile:${remote.id}:${remote.state}`,
          occurred
        );
      } else {
        await db("retry", {
          id: local.id,
          lease_token: local.lease_token,
          error: null
        });
      }
    } catch (error) {
      await db("retry", {
        id: local.id,
        lease_token: local.lease_token,
        error: "May I reconciliation unavailable; retry scheduled"
      });
      if (error instanceof AccessRejectedError) return 0;
    }
  }
  let count = 0;
  for (let n = 0; n < 10; n++) {
    let request = await db("claim", { client_id: config.client_id, review_protocol: 2 });
    if (!request) break;
    try {
      if (!request.review_body) {
        const body = reviewBody(request.action, request.supersedes_remote_id);
        request = await db("prepare_review", {
          review_protocol: 2,
          id: request.id,
          lease_token: request.lease_token,
          review_body: body,
          review_digest: await reviewDigest(body)
        });
      }
      const response = await fetcher(`${config.origin}/api/approvals/request`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15e3),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.id
        },
        body: JSON.stringify({
          action: request.action,
          ...request.review_body,
          expiresInSeconds: 604800,
          callback: { url: config.callback_url, state: request.callback_state }
        })
      });
      if ([401, 403].includes(response.status))
        await rejectAccess(db, token, response.status);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status))
          throw new PermanentSubmissionError(
            `May I rejected submission (HTTP ${response.status}); correct configuration and reissue this gate`
          );
        throw new Error("Submission uncertain");
      }
      const approval = await response.json();
      if (typeof approval.id !== "string" || !validReviewUrl(approval.reviewUrl) || !matches(request, approval, config, approval.id))
        throw new PermanentSubmissionError(
          "May I returned a mismatched approval; verify connection and reissue this gate"
        );
      await db("submitted", {
        review_protocol: 2,
        id: request.id,
        lease_token: request.lease_token,
        remote_id: approval.id,
        expires_at: approval.expiresAt,
        review_url: approval.reviewUrl
      });
      count++;
    } catch (error) {
      await db(error instanceof PermanentSubmissionError ? "fail" : "retry", {
        id: request.id,
        lease_token: request.lease_token,
        error: error instanceof PermanentSubmissionError ? error.message : "Approval submission uncertain; retry scheduled"
      });
      if (error instanceof AccessRejectedError) break;
    }
  }
  return count;
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

// catalog/ledger/supabase/functions/approval-dispatch/index.ts
Deno.serve(async (request) => {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (!await authorized(request, env("LEDGER_DISPATCH_TOKEN")))
    return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json({ submitted: await dispatch(backend) });
  } catch {
    return new Response(
      "Approval dispatch unavailable; check backend configuration or reauthorize May I",
      { status: 503 }
    );
  }
});
