/**
 * The ledger's approvals API (`public.ledger_approvals`, catalog/ledger/0011). harnesst alone
 * holds the approvals key; agents never see it. Requests go only to the installation's own
 * Supabase project, never to a URL taken from ledger data.
 */
import { projectRef } from "~/marketplace/supabase-provisioning.server";

export type LedgerApprovalStatus =
  | "pending"
  | "submitted"
  | "approved"
  | "denied"
  | "expired"
  | "superseded"
  | "failed";

export interface LedgerApprovalView {
  id: string;
  item_id: string;
  epoch: number;
  stage: string;
  binding: string;
  status: LedgerApprovalStatus;
  action: { input?: Record<string, unknown> } & Record<string, unknown>;
  review_url: string | null;
  created_at: string;
  expires_at: string;
  project: { id: string; slug: string; name: string; repo: string | null } | null;
  decision: {
    status: string;
    approver_id: string | null;
    approver_name: string | null;
    feedback: string | null;
    occurred_at: string;
  } | null;
  /** resolve only. */
  outcome?: "decided" | "already_decided" | "closed" | "expired" | "stale";
  item_stage?: string;
}

/** Ledger errors safe to show: raised by ledger_approvals itself, never upstream text. */
const KNOWN_ERRORS = new Set([
  "forbidden",
  "approval not found",
  "invalid decision",
  "approver required",
  "review URL required",
]);

export class LedgerApprovalsError extends Error {}

export class LedgerApprovals {
  private readonly url: string;
  constructor(
    ref: string,
    private readonly publishableKey: string,
    private readonly approvalsKey: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.url = `https://${projectRef(ref)}.supabase.co/rest/v1/rpc/ledger_approvals`;
  }

  private async call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    const response = await this.request(this.url, {
      method: "POST",
      redirect: "error",
      headers: { apikey: this.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ p_key: this.approvalsKey, p_op: op, p_args: args }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      let message = "";
      try {
        message = String((await response.json())?.message ?? "");
      } catch {
        /* Non-JSON upstream errors stay generic. */
      }
      if (message === "forbidden")
        throw new LedgerApprovalsError(
          "The ledger refused harnesst's approvals key. Update the ledger in Setup.",
        );
      throw new LedgerApprovalsError(
        KNOWN_ERRORS.has(message)
          ? `Ledger: ${message}.`
          : `Ledger approvals request failed (HTTP ${response.status}).`,
      );
    }
    return (await response.json()) as T;
  }

  /** Open requests, plus any listed ids whatever their state. Expires overdue requests first. */
  list(ids: string[] = []) {
    return this.call<LedgerApprovalView[]>("list", { ids });
  }
  /** Gives the request its harnesst link. Wakes the proxy agent once; repeat calls are no-ops. */
  publish(id: string, reviewUrl: string) {
    return this.call<LedgerApprovalView>("publish", { id, review_url: reviewUrl });
  }
  resolve(input: {
    id: string;
    decision: "approve" | "reject";
    approverId: string;
    approverName: string;
    feedback?: string | null;
  }) {
    return this.call<LedgerApprovalView>("resolve", {
      id: input.id,
      decision: input.decision,
      approver_id: input.approverId,
      approver_name: input.approverName,
      feedback: input.feedback ?? null,
    });
  }
}
