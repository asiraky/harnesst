import { reviewBody, reviewDigest, receiptReviewDigest } from "./review.ts";
import {
  createWebhookVerifier,
  MAX_WEBHOOK_BODY_BYTES,
  WebhookVerificationError,
} from "@mayiapp/sdk/webhook-verifier";

type Json = Record<string, any>;
export type Backend = (operation: string, args?: Json) => Promise<any>;
export type Config = {
  origin: string;
  callback_url: string;
  client_id: string;
};
type Fetch = typeof globalThis.fetch;

// Refresh is claimed and persisted before HTTP. Uncertain rotation requires manual
// reauthorization; retrying the old refresh token would revoke the entire grant.
export async function accessToken(
  db: Backend,
  config: Config,
  fetcher: Fetch,
): Promise<string> {
  const token = await db("token", { client_id: config.client_id });
  if (token.access_token) return token.access_token;
  const response = await fetcher(`${config.origin}/api/oauth/token`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: token.client_id,
      refresh_token: token.refresh_token,
    }),
  });
  if (!response.ok) {
    await db("refresh_failed", { claim: token.claim });
    throw new Error("May I reauthorization required");
  }
  const grant = await response.json();
  if (
    typeof grant.access_token !== "string" ||
    typeof grant.refresh_token !== "string" ||
    !Number.isSafeInteger(grant.expires_in) ||
    grant.expires_in < 1
  )
    throw new Error("Invalid May I grant");
  await db("save_token", { ...grant, claim: token.claim });
  return grant.access_token;
}

// Structural equality, ignoring object-key order (JSONB and May I serialize differently).
export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

function validReviewUrl(value: unknown): boolean {
  try { const u = new URL(String(value)); return u.protocol === "https:" && !u.username && !u.password; }
  catch { return false; }
}
class PermanentSubmissionError extends Error {}
class AccessRejectedError extends Error {}
async function rejectAccess(db: Backend, token: string, status: number) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  await db("access_rejected", {
    token_hash: Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join(""),
    status: String(status),
  });
  throw new AccessRejectedError(
    "May I credentials require renewal; approval remains pending",
  );
}

async function readApproval(
  db: Backend,
  config: Config,
  token: string,
  id: string,
  fetcher: Fetch,
): Promise<Json> {
  const response = await fetcher(
    `${config.origin}/api/approvals/${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if ([401, 403].includes(response.status))
    await rejectAccess(db, token, response.status);
  if (!response.ok) throw new Error("Cannot verify May I approval");
  return response.json();
}

function matches(
  local: Json,
  remote: Json,
  config: Config,
  id: string,
): boolean {
  return (
    remote.id === id &&
    canonical(remote.action) === canonical(local.action) &&
    typeof local.review_digest === "string" && remote.reviewDigest === local.review_digest &&
    remote.title === local.review_body?.title &&
    remote.reviewMarkdown === local.review_body?.reviewMarkdown &&
    remote.explanation === local.review_body?.explanation &&
    (remote.supersedesApprovalId ?? null) === (local.review_body?.supersedesApprovalId ?? null) &&
    (["APPROVED", "DENIED"].includes(remote.state) ?
      (remote.state === "APPROVED" ? remote.decisionOutcome === "APPROVED" :
        ["DENIED", "CHANGES_REQUESTED"].includes(remote.decisionOutcome)) : true) &&
    (remote.decisionComment == null || (typeof remote.decisionComment === "string" && remote.decisionComment.length <= 4000)) &&
    (remote.decisionOutcome !== "CHANGES_REQUESTED" || remote.decisionComment?.trim().length > 0) &&
    Number.isFinite(Date.parse(remote.expiresAt)) &&
    (!["APPROVED", "DENIED"].includes(remote.state) ||
      (typeof remote.approverId === "string" &&
        remote.approverId.length > 0 &&
        Number.isFinite(Date.parse(remote.decidedAt)) &&
        Date.parse(remote.decidedAt) <= Date.parse(remote.expiresAt))) &&
    (remote.state !== "APPROVED" ||
      (typeof remote.receipt === "string" && receiptReviewDigest(remote.receipt) === local.review_digest))
  );
}

async function applyRemote(
  db: Backend,
  local: Json,
  remote: Json,
  eventId: string,
  occurredAt: string,
) {
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
    feedback: remote.decisionComment ?? null,
  });
}

export async function dispatch(
  db: Backend,
  fetcher: Fetch = fetch,
): Promise<number> {
  const config: Config = await db("config");
  const token = await accessToken(db, config, fetcher);
  // Callback delivery is fast but finite. Reconcile independently using the same
  // OAuth-owned immutable resource and exact binding checks, never model input.
  for (let n = 0; n < 10; n++) {
    const local = await db("claim_resolution", { client_id: config.client_id, review_protocol: 2 });
    if (!local) break;
    try {
      const remote = await readApproval(
        db,
        config,
        token,
        local.remote_id,
        fetcher,
      );
      if (!matches(local, remote, config, local.remote_id))
        throw new Error("Approval binding mismatch");
      if (
        ["APPROVED", "DENIED", "EXPIRED", "CANCELLED"].includes(remote.state)
      ) {
        const occurred = remote.decidedAt ?? remote.expiresAt;
        if (!Number.isFinite(Date.parse(occurred)))
          throw new Error("Invalid decision time");
        await applyRemote(
          db,
          local,
          remote,
          `reconcile:${remote.id}:${remote.state}`,
          occurred,
        );
      } else {
        await db("retry", {
          id: local.id,
          lease_token: local.lease_token,
          error: null,
        });
      }
    } catch (error) {
      await db("retry", {
        id: local.id,
        lease_token: local.lease_token,
        error: "May I reconciliation unavailable; retry scheduled",
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
        request = await db("prepare_review", {review_protocol:2,id:request.id,lease_token:request.lease_token,
          review_body:body,review_digest:await reviewDigest(body)});
      }
      const response = await fetcher(`${config.origin}/api/approvals/request`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.id,
        },
        body: JSON.stringify({
          action: request.action,
          ...request.review_body,
          expiresInSeconds: 604800,
          callback: { url: config.callback_url, state: request.callback_state },
        }),
      });
      if ([401, 403].includes(response.status))
        await rejectAccess(db, token, response.status);
      if (!response.ok) {
        if (
          response.status >= 400 &&
          response.status < 500 &&
          ![408, 425, 429].includes(response.status)
        )
          throw new PermanentSubmissionError(
            `May I rejected submission (HTTP ${response.status}); correct configuration and reissue this gate`,
          );
        throw new Error("Submission uncertain");
      }
      const approval = await response.json();
      if (
        typeof approval.id !== "string" ||
        !validReviewUrl(approval.reviewUrl) ||
        !matches(request, approval, config, approval.id)
      )
        throw new PermanentSubmissionError(
          "May I returned a mismatched approval; verify connection and reissue this gate",
        );
      await db("submitted", {
        review_protocol: 2,
        id: request.id,
        lease_token: request.lease_token,
        remote_id: approval.id,
        expires_at: approval.expiresAt,
        review_url: approval.reviewUrl,
      });
      count++;
    } catch (error) {
      await db(error instanceof PermanentSubmissionError ? "fail" : "retry", {
        id: request.id,
        lease_token: request.lease_token,
        error:
          error instanceof PermanentSubmissionError
            ? error.message
            : "Approval submission uncertain; retry scheduled",
      });
      if (error instanceof AccessRejectedError) break;
    }
  }
  return count;
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
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

export function callbackHandler(
  db: Backend,
  config: Config,
  fetcher: Fetch = fetch,
) {
  const verifier = createWebhookVerifier({
    mayiOrigin: config.origin,
    maximumEventAgeSeconds: 604800,
    fetch: fetcher,
  });
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    let verified;
    try {
      verified = await verifier.verify({
        body: await boundedBody(request),
        signature: request.headers.get("x-mayi-signature"),
      });
    } catch (error) {
      if (
        error instanceof WebhookVerificationError &&
        error.code === "KEY_SET_UNAVAILABLE"
      )
        return new Response("May I signing keys unavailable; retry delivery", {
          status: 503,
        });
      return new Response("Invalid callback signature or body", {
        status: 401,
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
      // GET authenticates ownership as well as the immutable action and decision.
      const remote = await readApproval(
        db,
        config,
        token,
        event.approvalId,
        fetcher,
      );
      if (
        !matches(local, remote, config, event.approvalId) ||
        remote.state.toLowerCase() !== event.status ||
        ("approver" in event && remote.approverId !== event.approver.id) ||
        (event.status === "approved" && remote.receipt !== event.receipt)
      )
        return new Response("Approval binding mismatch", { status: 409 });
      const result = await applyRemote(
        db,
        local,
        remote,
        event.id,
        event.occurredAt,
      );
      return Response.json(result);
    } catch {
      return new Response("Approval verification unavailable; retry delivery", {
        status: 503,
      });
    }
  };
}
