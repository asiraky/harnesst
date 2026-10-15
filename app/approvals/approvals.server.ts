/**
 * harnesst-hosted approvals for ledger gates. The ledger owns the gate and re-checks every
 * decision against the item's current stage, epoch and binding; harnesst mirrors each request
 * into `approvals`, gives it a link, and records who decided.
 *
 * Flow: the ledger opens a request (pending) → sync copies it here and publishes its link
 * (ledger: submitted, which wakes the proxy agent to post the link) → a project member decides
 * here → resolve applies it in the ledger and returns the outcome → an approved merge gate is
 * merged by harnesst (merge.server.ts).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db/client.server";
import { approvals, bundleProvisioning, type Approval } from "~/db/schema";
import {
  ledgerApprovalsAccess,
  ledgerState,
} from "~/provisioners/supabase-ledger/provisioner.server";
import {
  LedgerApprovals,
  type LedgerApprovalView,
} from "./ledger-client.server";
import { mergeAfterDecision, type MergeDeps } from "./merge.server";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "superseded";

export function approvalStatus(view: LedgerApprovalView): ApprovalStatus {
  switch (view.status) {
    case "pending":
    case "submitted":
      return "pending";
    case "approved":
      return "approved";
    case "denied":
      return "rejected";
    case "expired":
      return "expired";
    default:
      return "superseded";
  }
}

export function approvalPath(id: string) {
  return `/approvals/${id}`;
}

type Ledger = Pick<LedgerApprovals, "list" | "publish" | "resolve">;

export interface ApprovalDeps {
  ledgerFor?: (projectId: string) => Promise<Ledger>;
  merge?: MergeDeps;
}

export async function ledgerForProject(projectId: string): Promise<LedgerApprovals> {
  const access = await ledgerApprovalsAccess(projectId);
  if (!access)
    throw new Error("Approvals aren't set up for this team. Update the ledger in Setup.");
  return new LedgerApprovals(access.ref, access.publishableKey, access.approvalsKey);
}

/** Copies the ledger's current view onto harnesst's row (creating it), returning the row. */
async function upsertFromLedger(
  projectId: string,
  view: LedgerApprovalView,
): Promise<Approval> {
  const input = view.action?.input ?? {};
  const status = approvalStatus(view);
  const decided = status === "approved" || status === "rejected";
  const values = {
    title: String(input.title ?? "Approval"),
    details: { ...view.action, project: view.project, stage: view.stage, itemId: view.item_id },
    approverRole: typeof input.approver_role === "string" ? input.approver_role : null,
    status,
    expiresAt: view.expires_at ? new Date(view.expires_at) : null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(approvals)
    .values({
      projectId,
      source: "ledger",
      externalId: view.id,
      ...values,
      decidedByName: decided ? (view.decision?.approver_name ?? null) : null,
      decidedAt: decided && view.decision ? new Date(view.decision.occurred_at) : null,
      feedback: decided ? (view.decision?.feedback ?? null) : null,
    })
    .onConflictDoUpdate({
      target: [approvals.projectId, approvals.source, approvals.externalId],
      set: {
        ...values,
        // A decision made here already carries its harnesst user; keep it.
        decidedByName: decided
          ? sql`coalesce(${approvals.decidedByName}, ${view.decision?.approver_name ?? null})`
          : approvals.decidedByName,
        decidedAt: decided && view.decision
          ? sql`coalesce(${approvals.decidedAt}, ${new Date(view.decision.occurred_at).toISOString()}::timestamptz)`
          : approvals.decidedAt,
        feedback: decided
          ? sql`coalesce(${approvals.feedback}, ${view.decision?.feedback ?? null})`
          : approvals.feedback,
      },
    })
    .returning();
  return row;
}

/**
 * One project's sync: list open ledger requests (and the outcome of ones still open here),
 * mirror them, and publish a link for each request the ledger hasn't published yet.
 */
export async function syncProjectApprovals(
  projectId: string,
  origin: string,
  deps: ApprovalDeps = {},
) {
  const ledger = await (deps.ledgerFor ?? ledgerForProject)(projectId);
  const open = await db
    .select({ externalId: approvals.externalId })
    .from(approvals)
    .where(
      and(
        eq(approvals.projectId, projectId),
        eq(approvals.source, "ledger"),
        eq(approvals.status, "pending"),
      ),
    );
  const views = await ledger.list(open.map((o) => o.externalId));
  let published = 0;
  for (const view of views) {
    const row = await upsertFromLedger(projectId, view);
    if (view.status === "pending") {
      await ledger.publish(view.id, new URL(approvalPath(row.id), origin).href);
      published++;
    }
  }
  return { seen: views.length, published };
}

/** Every installed ledger with approvals set up. One project's failure doesn't stop the rest. */
export async function syncAllApprovals(deps: ApprovalDeps = {}) {
  const rows = await db
    .select()
    .from(bundleProvisioning)
    .where(
      and(
        eq(bundleProvisioning.provisioner, "supabase-ledger"),
        inArray(bundleProvisioning.status, ["provisioned", "ready"]),
      ),
    );
  for (const row of rows) {
    if (!row.publicOrigin || !ledgerState(row).approvalsKey) continue;
    try {
      await syncProjectApprovals(row.projectId, row.publicOrigin, deps);
    } catch (error) {
      console.warn(
        `[approvals] sync failed for ${row.projectId}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}

export async function getApproval(id: string): Promise<Approval | null> {
  return (await db.select().from(approvals).where(eq(approvals.id, id)))[0] ?? null;
}

export class ApprovalDecisionError extends Error {}

/**
 * Applies a human decision in the ledger and records it here. The ledger is the judge: a
 * request superseded by a new commit, expired, or already decided comes back with that outcome
 * and nothing advances.
 */
export async function decideApproval(
  input: {
    approval: Approval;
    decision: "approve" | "reject";
    feedback?: string | null;
    user: { id: string; name: string };
  },
  deps: ApprovalDeps = {},
) {
  const feedback = input.feedback?.trim() || null;
  if (input.decision === "reject" && !feedback)
    throw new ApprovalDecisionError("Say what needs to change so the team can act on it.");
  if (input.approval.source !== "ledger")
    throw new ApprovalDecisionError("Unknown approval source.");
  const ledger = await (deps.ledgerFor ?? ledgerForProject)(input.approval.projectId);
  const view = await ledger.resolve({
    id: input.approval.externalId,
    decision: input.decision,
    approverId: input.user.id,
    approverName: input.user.name,
    feedback,
  });
  const decidedHere = view.outcome === "decided";
  if (decidedHere)
    await db
      .update(approvals)
      .set({
        decidedBy: input.user.id,
        decidedByName: input.user.name,
        decidedAt: new Date(),
        feedback,
      })
      .where(eq(approvals.id, input.approval.id));
  let approval = await upsertFromLedger(input.approval.projectId, view);
  // An approved merge gate is harnesst's to merge. The ledger has the decision either way, so a
  // merge that can't go through yet stays pending for the sync loop rather than failing this.
  if (decidedHere) approval = await mergeAfterDecision(approval, deps.merge);
  return { approval, outcome: view.outcome ?? "decided" };
}
