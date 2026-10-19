/**
 * One harnesst approval: GET returns the card (any project member), POST decides it (write
 * access). The ledger re-checks every decision, so a stale card can't advance changed work.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { getSessionAuth } from "~/auth/session.server";
import { decideApprovalCard, loadApprovalCard } from "~/approvals/card.server";

export async function loader(args: LoaderFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw data("Sign in", { status: 401 });
  return loadApprovalCard(auth, args.params.id);
}

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw data("Sign in", { status: 401 });
  return decideApprovalCard(auth, args.params.id, await args.request.formData());
}
