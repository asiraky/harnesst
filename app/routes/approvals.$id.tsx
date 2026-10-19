/**
 * `/approvals/:id` — the link the ledger hands the team's proxy agent. Shows the request and,
 * for anyone with write access to the team, Approve and Reject.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { sessionLoader } from "~/auth/session.server";
import { loadApprovalCard } from "~/approvals/card.server";
import { ApprovalCard } from "~/components/approvals/approval-card";

export function meta() {
  return [{ title: "Approval" }];
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(args, ({ auth }) => loadApprovalCard(auth, args.params.id));

export default function ApprovalPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <section className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-8">
        {data.approval ? (
          <ApprovalCard id={data.approval.id} initial={data.approval} />
        ) : (
          <p className="text-sm text-muted-foreground">{data.error}</p>
        )}
      </div>
    </section>
  );
}
