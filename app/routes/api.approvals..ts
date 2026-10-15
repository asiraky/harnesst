/**
 * One harnesst approval: GET returns the card (any project member), POST decides it (write
 * access). The ledger re-checks every decision, so a stale card can't advance changed work.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { getSessionAuth, type SessionAuth } from "~/auth/session.server";
import { requireProjectAccess } from "~/project/guard.server";
import {
  ApprovalDecisionError,
  decideApproval,
  getApproval,
} from "~/approvals/approvals.server";
import { LedgerApprovalsError } from "~/approvals/ledger-client.server";
import { approvalCardData, type ApprovalCardData } from "~/approvals/view";
import type { Approval } from "~/db/schema";

const OUTCOME_MESSAGES: Record<string, string> = {
  already_decided: "Someone already decided this request.",
  closed: "The work moved on, so this request no longer applies.",
  expired: "This request expired.",
  stale: "The work changed since this was requested. A new request replaces it.",
};

export type ApprovalActionData =
  | { ok: true; approval: ApprovalCardData; message: string | null }
  | { ok: false; error: string };

async function load(auth: SessionAuth, id: string | undefined) {
  const approval = id ? await getApproval(id) : null;
  if (!approval) throw data("Approval not found", { status: 404 });
  // A project the viewer can't see is a 404 from the guard, same as a missing approval.
  const access = await requireProjectAccess(auth, approval.projectId, "read");
  return { approval, access };
}

function card(approval: Approval, canDecide: boolean) {
  return approvalCardData(
    { ...approval, details: (approval.details ?? {}) as Record<string, unknown> },
    canDecide,
  );
}

export async function loader(args: LoaderFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw data("Sign in", { status: 401 });
  const { approval, access } = await load(auth, args.params.id);
  return { approval: card(approval, access.role === "write") };
}

export async function action(args: ActionFunctionArgs): Promise<ApprovalActionData> {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw data("Sign in", { status: 401 });
  const { approval } = await load(auth, args.params.id);
  await requireProjectAccess(auth, approval.projectId, "write");
  const form = await args.request.formData();
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
