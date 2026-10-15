/**
 * A harnesst approval as a card: what's being asked, the evidence and links, and (for anyone
 * with write access to the team) Approve and Reject. Used on `/approvals/:id` and inline in a
 * chat reply that links to it.
 */
import {
  CircleCheck,
  CircleX,
  Clock,
  ExternalLink,
  GitMerge,
  Loader2,
  ShieldQuestion,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { ApprovalCardResult, ApprovalDecisionResult } from "~/approvals/card.server";
import type { ApprovalCardData } from "~/approvals/view";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

const STATUS: Record<
  ApprovalCardData["status"],
  { label: string; icon: typeof Clock; className: string }
> = {
  pending: {
    label: "Waiting for a decision",
    icon: ShieldQuestion,
    className: "text-amber-600 dark:text-amber-400",
  },
  approved: {
    label: "Approved",
    icon: CircleCheck,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  rejected: { label: "Rejected", icon: CircleX, className: "text-destructive" },
  expired: { label: "Expired", icon: Clock, className: "text-muted-foreground" },
  superseded: {
    label: "No longer needed",
    icon: Clock,
    className: "text-muted-foreground",
  },
};

function when(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const stageLabel = (stage: string) => stage.replace(/[-_]/g, " ");

function MergeLine({ merge }: { merge: NonNullable<ApprovalCardData["merge"]> }) {
  const [className, text] =
    merge.status === "merged"
      ? ["text-muted-foreground", `Merged by harnesst${merge.sha ? ` · ${merge.sha.slice(0, 7)}` : ""}`]
      : merge.status === "failed"
        ? ["text-destructive", `Not merged: ${merge.error ?? "GitHub refused the merge."}`]
        : [
            "text-amber-600 dark:text-amber-400",
            merge.error ? `Not merged yet: ${merge.error}` : "Merging…",
          ];
  return (
    <p className={cn("flex items-start gap-1.5 text-xs", className)}>
      <GitMerge className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  );
}

export function ApprovalCard({
  id,
  initial,
  compact = false,
}: {
  id: string;
  initial?: ApprovalCardData;
  /** Inline in a chat reply: link out to the full page. */
  compact?: boolean;
}) {
  const loader = useFetcher<ApprovalCardResult>({ key: `approval-card:${id}` });
  const decision = useFetcher<ApprovalDecisionResult>({ key: `approval-decide:${id}` });
  const { load } = loader;
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (!initial) load(`/api/approvals/${id}`);
  }, [id, initial, load]);

  const decided = decision.data?.ok ? decision.data : null;
  const approval = decided?.approval ?? loader.data?.approval ?? initial ?? null;
  const loadError = loader.data && !loader.data.approval ? loader.data.error : null;
  const decideError = decision.data && !decision.data.ok ? decision.data.error : null;
  const busy = decision.state !== "idle";
  const pendingIntent = busy ? String(decision.formData?.get("intent") ?? "") : null;

  if (!approval)
    return (
      <div className="rounded-lg border px-3 py-2.5 text-sm text-muted-foreground">
        {loadError ?? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading approval…
          </span>
        )}
      </div>
    );

  const status = STATUS[approval.status];
  const StatusIcon = status.icon;

  return (
    <div className="not-prose rounded-lg border bg-card text-card-foreground">
      <div className="flex items-start gap-2.5 border-b px-4 py-3">
        <StatusIcon className={cn("mt-0.5 size-4 shrink-0", status.className)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{approval.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[
              approval.project?.repo ?? approval.project?.name,
              approval.stage && stageLabel(approval.stage),
              approval.headSha && approval.headSha.slice(0, 7),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Badge variant="outline" className={cn("shrink-0", status.className)}>
          {status.label}
        </Badge>
      </div>

      <div className="space-y-3 px-4 py-3 text-sm">
        {approval.problem && !compact && (
          <p className="whitespace-pre-wrap text-muted-foreground">{approval.problem}</p>
        )}
        {approval.acceptanceCriteria.length > 0 && !compact && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Acceptance criteria
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              {approval.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </div>
        )}
        {approval.evidence.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {approval.evidence.map((item, index) => {
              const label = stageLabel(item.type);
              return item.url ? (
                <a
                  key={index}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  title={item.summary ?? undefined}
                >
                  <Badge variant="secondary">{label}</Badge>
                </a>
              ) : (
                <Badge key={index} variant="secondary" title={item.summary ?? undefined}>
                  {label}
                </Badge>
              );
            })}
          </div>
        )}
        {approval.links.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {approval.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
              >
                {link.label}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ))}
          </div>
        )}

        {approval.status === "pending" ? (
          <p className="text-xs text-muted-foreground">
            {approval.approveTo && (
              <>
                Approving moves it to {stageLabel(approval.approveTo)}
                {approval.rejectTo && <>; rejecting sends it back to {stageLabel(approval.rejectTo)}</>}
                .{" "}
              </>
            )}
            {approval.expiresAt && (
              <span suppressHydrationWarning>Expires {when(approval.expiresAt)}.</span>
            )}
          </p>
        ) : (
          (approval.decidedByName || approval.feedback) && (
            <div className="text-xs text-muted-foreground">
              {approval.decidedByName && (
                <p suppressHydrationWarning>
                  {status.label} by {approval.decidedByName}
                  {approval.decidedAt && <> on {when(approval.decidedAt)}</>}.
                </p>
              )}
              {approval.feedback && (
                <p className="mt-1 whitespace-pre-wrap text-foreground">{approval.feedback}</p>
              )}
            </div>
          )
        )}

        {approval.merge && <MergeLine merge={approval.merge} />}
        {decided?.message && <p className="text-xs text-muted-foreground">{decided.message}</p>}
        {decideError && <p className="text-xs text-destructive">{decideError}</p>}

        {approval.canDecide && (
          <decision.Form method="post" action={`/api/approvals/${id}`} className="space-y-2">
            <Textarea
              name="feedback"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="Feedback (required to reject)"
              rows={2}
              disabled={busy}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" name="intent" value="approve" size="sm" disabled={busy}>
                {pendingIntent === "approve" && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                )}
                Approve
              </Button>
              <Button
                type="submit"
                name="intent"
                value="reject"
                size="sm"
                variant="outline"
                disabled={busy || !feedback.trim()}
              >
                {pendingIntent === "reject" && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                )}
                Reject
              </Button>
              {compact && (
                <Link
                  to={`/approvals/${id}`}
                  className="ml-auto text-xs text-muted-foreground underline underline-offset-4"
                >
                  Open
                </Link>
              )}
            </div>
          </decision.Form>
        )}
        {!approval.canDecide && compact && (
          <Link
            to={`/approvals/${id}`}
            className="inline-block text-xs text-muted-foreground underline underline-offset-4"
          >
            Open approval
          </Link>
        )}
      </div>
    </div>
  );
}
