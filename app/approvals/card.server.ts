/**
 * The approval card's server side, shared by the API route (inline chat cards, the page's
 * decisions) and the `/approvals/:id` page. Access failures come back as a message rather than
 * a thrown response: a card inside a chat reply must not take the conversation down with it.
 */
import type { SessionAuth } from "~/auth/session.server";
import type { Approval } from "~/db/schema";
import { requireProjectAccess } from "~/project/guard.server";
import {
  ApprovalDecisionError,
  decideApproval,
  getApproval,
} from "./approvals.server";
import { LedgerApprovalsError } from "./ledger-client.server";
import { approvalCardData, type ApprovalCardData } from "./view";

export type ApprovalCardResult =
  | { approval: ApprovalCardData; error?: undefined }
  | { approval: null; error: string };

export type ApprovalDecisionResult =
  | { ok: true; approval: ApprovalCardData; message: string | null }
  | { ok: false; error: string };

const NOT_AVAILABLE = "This approval doesn't exist or you don't have access to it.";

const OUTCOME_MESSAGES: Record<string, string> = {
  already_decided: "Someone already decided this request.",
  closed: "The work moved on, so this request no longer applies.",
  expired: "This request expired.",
  stale: "The work changed since this was requested. A new request replaces it.",
};

function card(approval: Approval, canDecide: boolean) {
  return approvalCardData(
    { ...approval, details: (approval.details ?? {}) as Record<string, unknown> },
    canDecide,
  );
}

/** The guard throws responses for no access; anything else is a real failure. */
async function access(auth: SessionAuth, approval: Approval) {
  try {
    return await requireProjectAccess(auth, approval.projectId, "read");
  } catch (error) {
    if (error instanceof Error) throw error;
    return null;
  }
}

export async function loadApprovalCard(
  auth: SessionAuth,
  id: string | undefined,
): Promise<ApprovalCardResult> {
  const approval = id ? await getApproval(id) : null;
  const granted = approval ? await access(auth, approval) : null;
  if (!approval || !granted) return { approval: null, error: NOT_AVAILABLE };
  return { approval: card(approval, granted.role === "write") };
}

export async function decideApprovalCard(
  auth: SessionAuth,
  id: string | undefined,
  form: FormData,
): Promise<ApprovalDecisionResult> {
  const approval = id ? await getApproval(id) : null;
  const granted = approval ? await access(auth, approval) : null;
  if (!approval || !granted) return { ok: false, error: NOT_AVAILABLE };
  if (granted.role !== "write")
    return { ok: false, error: "You need write access to this team to decide." };
  const intent = String(form.get("intent") ?? "");
  if (intent !== "approve" && intent !== "reject")
    return { ok: false, error: "Unknown action." };
  try {
    const result = await decideApproval({
      approval,
      decision: intent,
      feedback: String(form.get("feedback") ?? ""),
      user: { id: auth.user.id, name: auth.user.name || auth.user.email },
    });
    return {
      ok: true,
      approval: card(result.approval, true),
      message: OUTCOME_MESSAGES[result.outcome] ?? null,
    };
  } catch (error) {
    if (error instanceof ApprovalDecisionError || error instanceof LedgerApprovalsError)
      return { ok: false, error: error.message };
    throw error;
  }
}
